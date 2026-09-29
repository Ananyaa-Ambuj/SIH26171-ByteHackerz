// 1. Start Florence-2 Web Worker
const worker = new Worker('florence-worker.bundle.js', { type: 'module' });

// 2. Start pre-loading the model onto WebGPU
worker.postMessage({ type: 'LOAD_MODEL' });

// 3. Log model loading progress in the background
worker.addEventListener('message', (e) => {
    if (e.data.type === 'STATUS') {
        console.log('[Florence Offscreen]', e.data.message);
    } else if (e.data.type === 'PROGRESS') {
        console.log('[Florence Download]', e.data.progress);
    } else if (e.data.type === 'MODEL_READY') {
        console.log('[Florence] Model is ready on WebGPU!');
    }
});

// 4. Listen for detection requests from popup.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'RUN_FLORENCE') {
        // Send the screenshot to the Florence worker
        worker.postMessage({
            type: 'DETECT',
            imageDataUrl: message.image
        });

        // Wait for results from the worker, redact the image, and send back to popup.js
        const handleWorkerReply = (e) => {
            if (e.data.type === 'RESULTS') {
                worker.removeEventListener('message', handleWorkerReply);

                // --- NEW CANVAS REDACTION CODE STARTS HERE ---
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext('2d');

                    // 1. Draw original screenshot raw pixels
                    ctx.drawImage(img, 0, 0);

                    // 2. Burn solid black bars directly over detected regions
                    ctx.fillStyle = '#000000';
                    
                    // Note: Check if your worker returns array as 'regions' or 'boxes'
                    const boxes = e.data.regions || []; 
                    
                    boxes.forEach(box => {
                        // Adjust these keys (box.x, box.y, etc.) based on your worker's output format
                        ctx.fillRect(box.x, box.y, box.width, box.height);
                    });

                    // 3. Convert the modified canvas back into a clean image string
                    const redactedDataUrl = canvas.toDataURL('image/jpeg', 0.95);

                    // 4. Send the redacted image URL back to popup.js
                    sendResponse({
                        success: true,
                        redactedUrl: redactedDataUrl,
                        latencyMs: e.data.latencyMs
                    });
                };
                img.src = message.image; // Use the original screenshot passed from popup
                // --- NEW CANVAS REDACTION CODE ENDS HERE ---

            } else if (e.data.type === 'ERROR') {
                worker.removeEventListener('message', handleWorkerReply);
                sendResponse({
                    success: false,
                    error: e.data.error
                });
            }
        };

        worker.addEventListener('message', handleWorkerReply);
        return true; // Keep Chrome channel open for async response
    }
});

