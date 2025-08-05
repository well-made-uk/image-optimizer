// netlify/functions/convert-to-avif.js
const sharp = require('sharp');

exports.handler = async (event) => {
    console.log('Received request:', {
        method: event.httpMethod,
        headers: event.headers,
        bodyLength: event.body?.length,
        isBase64Encoded: event.isBase64Encoded
    });

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method Not Allowed' }),
        };
    }

    try {
        // Validate input
        if (!event.body) {
            console.error('No request body provided');
            return { statusCode: 400, body: JSON.stringify({ error: 'No image data provided' }) };
        }

        let inputBuffer;
        try {
            // Handle both base64 and binary data
            if (event.isBase64Encoded) {
                inputBuffer = Buffer.from(event.body, 'base64');
            } else {
                // For binary data, create a buffer directly
                inputBuffer = Buffer.from(event.body, 'binary');
            }
            
            if (inputBuffer.length === 0) throw new Error('Empty buffer');
            console.log(`Received image data: ${inputBuffer.length} bytes`);
            
        } catch (bufferError) {
            console.error('Error creating buffer:', bufferError);
            return { 
                statusCode: 400, 
                body: JSON.stringify({ 
                    error: 'Invalid image data',
                    details: bufferError.message 
                }) 
            };
        }

        // Process image
        try {
            const metadata = await sharp(inputBuffer).metadata();
            console.log('Image metadata:', metadata);

            if (!metadata || !metadata.format) {
                throw new Error('Could not determine image format');
            }

            // First pass with quality 85
            const avifBuffer1 = await sharp(inputBuffer)
                .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
                .avif({ quality: 85 })
                .toBuffer();

            const reduction = 1 - (avifBuffer1.length / inputBuffer.length);
            console.log(`First pass reduction: ${(reduction * 100).toFixed(1)}%`);

            if (reduction >= 0.5) {
                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'image/avif' },
                    isBase64Encoded: true,
                    body: avifBuffer1.toString('base64'),
                };
            }

            // Second pass with adjusted quality
            const adjustedQuality = Math.max(40, Math.round(40 + 40 * reduction));
            console.log(`Second pass with quality: ${adjustedQuality}`);
            
            const avifBuffer2 = await sharp(inputBuffer)
                .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
                .avif({ quality: adjustedQuality })
                .toBuffer();

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'image/avif' },
                isBase64Encoded: true,
                body: avifBuffer2.toString('base64'),
            };

        } catch (processError) {
            console.error('Image processing error:', processError);
            return {
                statusCode: 400,
                body: JSON.stringify({ 
                    error: 'Failed to process image',
                    details: processError.message 
                })
            };
        }

    } catch (error) {
        console.error('Unexpected error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: 'Internal server error',
                details: error.message 
            })
        };
    }
};
