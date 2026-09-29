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

        // Wait for results from the worker and send back to popup.js
        const handleWorkerReply = (e) => {
            if (e.data.type === 'RESULTS') {
                worker.removeEventListener('message', handleWorkerReply);
                sendResponse({
                    success: true,
                    regions: e.data.regions,
                    latencyMs: e.data.latencyMs
                });
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
