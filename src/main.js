import './style.css';
import { ImagePool } from '@squoosh/lib';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const tableBody = document.querySelector('#results-table tbody');
const downloadAllBtn = document.getElementById('download-all');

let processedFiles = [];

async function optimizeImageClientSide(blob, firstPassQuality = 70, secondPassMinQuality = 40, secondPassMaxQuality = 65) {
    const imagePool = new ImagePool();
    const image = imagePool.ingestImage(blob);

    // First pass with higher quality
    await image.encode({
        avif: {
            quality: firstPassQuality,
            cqLevel: Math.round(63 - (firstPassQuality * 0.6)),
            chromaDeltaQ: false,
            sharpness: 0,
            subsample: 1,
            speed: 4,
        },
    });

    const firstPassResult = await image.encodedWith.avif;
    const firstPassBlob = new Blob([firstPassResult.binary.buffer], { type: 'image/avif' });
    
    // Check if first pass is sufficient
    const reduction = 1 - (firstPassBlob.size / blob.size);
    if (reduction >= 0.6 || firstPassBlob.size < 75 * 1024) {
        await imagePool.close();
        return firstPassBlob;
    }

    // Calculate quality for second pass
    const qualityScale = Math.min(1, reduction / 0.6);
    const adjustedQuality = Math.round(
        secondPassMinQuality + 
        ((secondPassMaxQuality - secondPassMinQuality) * qualityScale)
    );

    // Second pass with adjusted quality
    await image.encode({
        avif: {
            quality: adjustedQuality,
            cqLevel: Math.round(63 - (adjustedQuality * 0.6)),
            chromaDeltaQ: false,
            sharpness: 0,
            subsample: 1,
            speed: 6,
        },
    });

    const secondPassResult = await image.encodedWith.avif;
    const secondPassBlob = new Blob([secondPassResult.binary.buffer], { type: 'image/avif' });
    
    await imagePool.close();
    return secondPassBlob;
}

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
    try {
        // Convert SVG to PNG first if needed
        const imageBlob = file.type === 'image/svg+xml' 
            ? await svgToPngFile(await file.text(), file.name)
            : file;

        // Process image through canvas
        const { blob: processedBlob } = await processImageThroughCanvas(imageBlob);
        
        // Use client-side optimization
        const optimizedBlob = await optimizeImageClientSide(processedBlob);
        const finalFile = new File(
            [optimizedBlob],
            `x-${file.name.replace(/\.[^/.]+$/, '')}.avif`,
            { type: 'image/avif' }
        );

        // Update UI
        const reducedPercent = ((1 - (optimizedBlob.size / file.size)) * 100).toFixed(0);
        row.querySelector('.opt-size').textContent = 
            `${formatBytes(optimizedBlob.size)} (${reducedPercent}%)`;

        const link = document.createElement('a');
        link.textContent = 'Download';
        link.href = URL.createObjectURL(finalFile);
        link.download = finalFile.name;
        row.querySelector('.dl-cell').appendChild(link);

        // Add to processed files for batch download
        processedFiles.push(finalFile);
        downloadAllBtn.disabled = false;
        
    } catch (error) {
        console.error('Error processing file:', error);
        row.querySelector('.opt-size').textContent = '❌ Error';
        throw error;
    }
}

async function processImageThroughCanvas(blob) {
    const img = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // Calculate dimensions to fit within 2000x2000 while maintaining aspect ratio
    const maxSize = 2000;
    let width = img.width;
    let height = img.height;
    
    if (width > height && width > maxSize) {
        height = Math.round((height * maxSize) / width);
        width = maxSize;
    } else if (height > maxSize) {
        width = Math.round((width * maxSize) / height);
        height = maxSize;
    }
    
    canvas.width = width;
    canvas.height = height;
    
    // Draw image on canvas
    ctx.drawImage(img, 0, 0, width, height);
    
    // Check for transparency
    const hasAlpha = imageHasAlpha(ctx.getImageData(0, 0, width, height));
    
    // Convert to blob with appropriate format
    const outputBlob = await new Promise(resolve => {
        canvas.toBlob(blob => resolve(blob), 
            hasAlpha ? 'image/png' : 'image/jpeg', 0.9);
    });
    
    return { blob: outputBlob };
}

function imageHasAlpha(imageData) {
    const data = imageData.data;
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) return true;
    }
    return false;
}

function blobToBase64(blob) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
    });
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

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(2)} MB`;
}

downloadAllBtn.addEventListener('click', async () => {
    if (processedFiles.length === 0) return;
    
    // Create a new zip file
    const zipResponse = await fetch('https://stuk.github.io/jszip/dist/jszip.min.js');
    const zipScript = await zipResponse.text();
    const scriptEl = document.createElement('script');
    scriptEl.textContent = zipScript;
    document.body.appendChild(scriptEl);
    
    // Wait for JSZip to be available
    await new Promise(resolve => {
        const check = () => {
            if (window.JSZip) return resolve();
            setTimeout(check, 50);
        };
        check();
    });
    
    const zip = new JSZip();
    
    // Add all processed files to the zip
    for (const file of processedFiles) {
        zip.file(file.name, file);
    }
    
    // Generate the zip file
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    
    // Create and trigger download
    const a = document.createElement('a');
    a.href = url;
    a.download = 'optimized-images.zip';
    document.body.appendChild(a);
    a.click();
    
    // Clean up
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
});
