import { encode } from '@jsquash/avif';
import JSZip from 'jszip';
import tippy from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import './style.css';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const tableBody = document.querySelector('#results-table tbody');
const downloadAllBtn = document.getElementById('download-all');

const zip = new JSZip();
let zipFiles = [];

fileInput.addEventListener('change', e => {
    console.log('Files selected via input:', e.target.files);
    handleFiles(e.target.files);
});

dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
});
dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    console.log('Files dropped:', e.dataTransfer.files);
    handleFiles(e.dataTransfer.files);
});

// Queue logic
let fileQueue = [];
let processing = false;

function handleFiles(fileList) {
    console.log('handleFiles called with:', fileList);
    if (!fileList || fileList.length === 0) {
        console.error('No files received');
        return;
    }
    [...fileList].forEach(file => {
        console.log('Processing file:', file.name);
        const row = createTableRow(file);
        fileQueue.push({ file, row });
    });
    if (!processing) processNext();
}

function createTableRow(file) {
    const row = document.createElement('tr');
    const thumbUrl = URL.createObjectURL(file);
    row.innerHTML = `
  <td data-label="Preview"><img src="${thumbUrl}" alt="" style="width: 40px; height: 40px; object-fit: cover; border-radius: 4px;" /></td>
  <td data-label="File">${file.name}</td>
  <td data-label="Original Size">${formatBytes(file.size)}</td>
  <td class="opt-size" data-label="Optimised Size">Queued...</td>
  <td class="dl-cell" data-label="Download"></td>
`;

    tableBody.appendChild(row);
    return row;
}

async function processNext() {
    if (fileQueue.length === 0) {
        processing = false;
        return;
    }

    processing = true;

    const { file, row } = fileQueue.shift();
    try {
        await processFile(file, row);
    } catch (err) {
        console.error(`Error processing ${file.name}`, err);
        row.querySelector('.opt-size').textContent = '❌ Error';
    }

    requestAnimationFrame(() => processNext());
}

async function processFile(file, row) {
    function getUniqueName(baseName, extension, existingNames) {
        let name = `${baseName}.${extension}`;
        let count = 1;
        while (existingNames.has(name)) {
            name = `${baseName}_${count}.${extension}`;
            count++;
        }
        existingNames.add(name);
        return name;
    }

    const baseName = `opt_${file.name.replace(/\.\w+$/, '')}`;
    const outputName = getUniqueName(baseName, 'avif', new Set(zipFiles.map(f => f.name)));

    const isSVG = file.type === 'image/svg+xml';

    const inputBlob = isSVG
        ? await svgToPngFile(await file.text(), file.name)
        : file;

    // Normalize and resize through canvas
    const imageData = await imageToImageData(inputBlob, 2000);
    const hasAlpha = imageHasAlpha(imageData);
    const finalImageData = hasAlpha
        ? imageData
        : await imageToImageData(inputBlob, 2000, true); // Flatten if opaque

    // First pass at quality 70
    let quality = 70;
    let buffer = await encode(finalImageData, { quality });
    let avifBlob = new Blob([buffer], { type: 'image/avif' });

    const originalSize = file.size;
    const reduction = 1 - (avifBlob.size / originalSize);

    if (reduction < 0.3) {
        // Re-encode at a reduced quality based on how bad the compression was
        const adjustedQuality = Math.max(40, Math.round(quality * reduction));
        const newBuffer = await encode(finalImageData, { quality: adjustedQuality });
        const newBlob = new Blob([newBuffer], { type: 'image/avif' });

        // Keep smaller result
        if (newBlob.size < avifBlob.size) {
            avifBlob = newBlob;
            quality = adjustedQuality;
        }
    }

    const finalFile = new File([avifBlob], outputName, { type: 'image/avif' });
    zip.file(outputName, avifBlob);
    zipFiles.push(finalFile);

    const reducedPercent = ((1 - (avifBlob.size / file.size)) * 100).toFixed(0);
    row.querySelector('.opt-size').textContent = `${formatBytes(avifBlob.size)} (${reducedPercent}%)`;

    const link = document.createElement('a');
    link.textContent = 'Download';
    link.href = URL.createObjectURL(finalFile);
    link.download = finalFile.name;
    row.querySelector('.dl-cell').appendChild(link);

    downloadAllBtn.disabled = false;
}

async function svgToPngFile(svgText, name) {
    const blob = new Blob([svgText], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    await img.decode();

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2000;
    const ctx = canvas.getContext('2d');
    ctx.globalCompositeOperation = 'copy';
    ctx.filter = 'contrast(0.99) brightness(1.01)';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    return new Promise(resolve => {
        canvas.toBlob(blob => {
            resolve(new File([blob], name.replace(/\.svg$/, '.png'), { type: 'image/png' }));
        }, 'image/png', 1);
    });
}

async function imageToImageData(file, maxSize, forceOpaque = false) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const width = Math.floor(bitmap.width * scale);
    const height = Math.floor(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    if (forceOpaque) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
    }

    ctx.drawImage(bitmap, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
}

function imageHasAlpha(imageData) {
    const data = imageData.data;
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) return true;
    }
    return false;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(2)} MB`;
}

downloadAllBtn.addEventListener('click', async () => {
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'optimised_images.zip';
    a.click();
});

tippy('#how-to-use', {
    allowHTML: true,
    placement: 'top',
    maxWidth: 300,
    theme: 'light-border',
});
