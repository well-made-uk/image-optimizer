// netlify/functions/convert-to-avif.js
const sharp = require('sharp');

// Helper function to log memory usage
function logMemoryUsage(stage) {
    const used = process.memoryUsage();
    console.log(`Memory at ${stage}:`, {
        rss: `${Math.round(used.rss / 1024 / 1024 * 100) / 100} MB`,
        heapTotal: `${Math.round(used.heapTotal / 1024 / 1024 * 100) / 100} MB`,
        heapUsed: `${Math.round(used.heapUsed / 1024 / 1024 * 100) / 100} MB`,
        external: `${Math.round(used.external / 1024 / 1024 * 100) / 100} MB`
    });
}

exports.handler = async (event) => {
    console.log('Received request:', {
        method: event.httpMethod,
        headers: event.headers,
        bodyLength: event.body?.length,
        isBase64Encoded: event.isBase64Encoded
    });
    logMemoryUsage('start');

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method Not Allowed' }),
        };
    }

    // Validate content length (10MB max)
    const MAX_SIZE = 10 * 1024 * 1024; // 10MB
    const contentLength = parseInt(event.headers['content-length'] || '0');
    if (contentLength > MAX_SIZE) {
        console.error(`Request too large: ${contentLength} bytes`);
        return {
            statusCode: 413,
            body: JSON.stringify({ error: `File too large. Maximum size is ${MAX_SIZE / 1024 / 1024}MB` })
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
                inputBuffer = Buffer.from(event.body, 'binary');
            }
            
            if (inputBuffer.length === 0) {
                throw new Error('Empty buffer received');
            }
            console.log(`Received image data: ${inputBuffer.length} bytes`);
            logMemoryUsage('after buffer creation');
            
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

        // Process image with timeout
        const processWithTimeout = async () => {
            const timeout = 9000; // 9 seconds (leaving 1s for response)
            let timeoutId;
            
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`Processing timed out after ${timeout}ms`));
                }, timeout);
            });

            try {
                const metadata = await Promise.race([
                    sharp(inputBuffer).metadata(),
                    timeoutPromise
                ]);
                
                clearTimeout(timeoutId);
                console.log('Image metadata:', {
                    format: metadata.format,
                    width: metadata.width,
                    height: metadata.height,
                    size: metadata.size ? `${Math.round(metadata.size / 1024)}KB` : 'unknown'
                });
                logMemoryUsage('after metadata');

                if (!metadata || !metadata.format) {
                    throw new Error('Could not determine image format');
                }

                // Inside the processWithTimeout function, right before the first AVIF conversion:
                console.log('Starting first AVIF conversion...');
                const avifBuffer1 = await Promise.race([
                    (async () => {
                        try {
                            const startTime = Date.now();
                            const result = await sharp(inputBuffer, {
                                failOnError: true,
                                limitInputPixels: 2000 * 2000 // Limit to 4MP to prevent processing very large images
                            })
                                .resize(2000, 2000, {
                                    fit: 'inside',
                                    withoutEnlargement: true
                                })
                                .avif({
                                    quality: 70,
                                    effort: 4, // Reduced from 6 to speed up processing
                                    chromaSubsampling: '4:2:0' // Better compression
                                })
                                .toBuffer();
                            console.log(`First AVIF conversion took ${Date.now() - startTime}ms`);
                            return result;
                        } catch (e) {
                            console.error('First AVIF conversion failed:', e);
                            throw e;
                        }
                    })(),
                    timeoutPromise
                ]);

                const reduction = 1 - (avifBuffer1.length / inputBuffer.length);
                console.log(`First pass reduction: ${(reduction * 100).toFixed(1)}%`);
                logMemoryUsage('after first pass');

                if (reduction >= 0.6 || avifBuffer1.length < 75 * 1024) {
                    return {
                        statusCode: 200,
                        headers: { 
                            'Content-Type': 'image/avif',
                            'X-Image-Processed': 'single-pass',
                            'X-Original-Size': inputBuffer.length,
                            'X-Optimized-Size': avifBuffer1.length,
                            'X-Reduction': `${(reduction * 100).toFixed(1)}%`
                        },
                        isBase64Encoded: true,
                        body: avifBuffer1.toString('base64'),
                    };
                }

                // Calculate quality for second pass (40-65 based on reduction)
                const minQuality = 40;
                const maxQuality = 65;
                const qualityRange = maxQuality - minQuality;
                const qualityScale = Math.min(1, reduction / 0.6);
                const adjustedQuality = Math.round(minQuality + (qualityRange * qualityScale));

                console.log(`Second pass with quality: ${adjustedQuality}`);

                const avifBuffer2 = await Promise.race([
                    sharp(inputBuffer, { failOnError: true })
                        .resize(2000, 2000, { 
                            fit: 'inside', 
                            withoutEnlargement: true 
                        })
                        .avif({ 
                            quality: adjustedQuality, 
                            effort: 6 
                        })
                        .toBuffer(),
                    timeoutPromise
                ]);

                logMemoryUsage('after second pass');

                return {
                    statusCode: 200,
                    headers: { 
                        'Content-Type': 'image/avif',
                        'X-Image-Processed': 'two-pass',
                        'X-Original-Size': inputBuffer.length,
                        'X-Optimized-Size': avifBuffer2.length,
                        'X-Reduction': `${((1 - (avifBuffer2.length / inputBuffer.length)) * 100).toFixed(1)}%`
                    },
                    isBase64Encoded: true,
                    body: avifBuffer2.toString('base64'),
                };

            } catch (err) {
                clearTimeout(timeoutId);
                throw err;
            }
        };

        return await processWithTimeout();

    } catch (error) {
        console.error('Error processing image:', {
            error: error.message,
            stack: error.stack,
            name: error.name
        });
        logMemoryUsage('on error');

        return {
            statusCode: error.statusCode || 500,
            body: JSON.stringify({
                error: 'Failed to process image',
                details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
                code: error.code
            })
        };
    }
};
