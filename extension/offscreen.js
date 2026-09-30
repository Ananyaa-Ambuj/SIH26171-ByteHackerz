// 1. Start Florence-2 Web Worker
const worker = new Worker('florence-worker.bundle.js', { type: 'module' });

// 2. Start pre-loading the model onto WebGPU
worker.postMessage({ type: 'LOAD_MODEL' });

// Final MODEL_READY / load ERROR message, kept so a side panel opened later can ask for it
let modelState = null;
let nextRequestId = 1;

// 3. Forward model loading progress to the extension runtime (sidepanel)
worker.addEventListener('message', (e) => {
    if (e.data.type === 'STATUS') {
        console.log('[Florence Offscreen]', e.data.message);
        chrome.runtime.sendMessage(e.data).catch(() => {});
    } else if (e.data.type === 'PROGRESS') {
        console.log('[Florence Download]', e.data.progress);
        chrome.runtime.sendMessage(e.data).catch(() => {});
    } else if (e.data.type === 'MODEL_READY') {
        console.log(`[Florence] Model is ready on ${e.data.device}!`);
        modelState = e.data;
        chrome.runtime.sendMessage(e.data).catch(() => {});
    } else if (e.data.type === 'ERROR' && e.data.requestId === undefined) {
        // Model loading failed (detection errors carry a requestId and are answered below)
        console.error('[Florence] Model failed to load:', e.data.error);
        modelState = e.data;
        chrome.runtime.sendMessage(e.data).catch(() => {});
    }
});

// 4. Listen for detection requests from sidepanel.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'GET_MODEL_STATUS') {
        sendResponse(modelState);
        return;
    }

    if (message.action === 'RUN_FLORENCE') {
        const requestId = nextRequestId++;

        // Send the screenshot to the Florence worker
        worker.postMessage({
            type: 'DETECT',
            requestId,
            imageDataUrl: message.image
        });

        // Wait for results from the worker, redact the image, and send back to sidepanel.js
        const handleWorkerReply = (e) => {
            // Ignore replies meant for another in-flight request, otherwise its regions would be
            // painted onto this screenshot and leave this screenshot's PII unredacted
            if (e.data.requestId !== requestId) return;

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

              // 2. Instantiate masker to generate fake replacement values
              const masker = new PIIMasker();
              const mockedMappings = [];
              const manifest = { redacted_regions: [] };

              // DOM-scan regions (Pass 1, already in screenshot pixels) + Florence vision regions (Pass 2)
              const boxes = [
                ...(message.domRegions || []),
                ...(e.data.regions || e.data.boxes || e.data.bboxes || e.data.predictions || [])
              ];

              boxes.forEach((box) => {
                const b = box.bbox || box;
                let x, y, w, h;

                // Worker sends pre-normalized {x, y, w, h} objects
                x = b.x ?? 0;
                y = b.y ?? 0;
                w = b.w ?? b.width ?? 0;
                h = b.h ?? b.height ?? 0;

                if (w <= 0 || h <= 0) return;

                const label = (box.type || box.label || box.category || '').toLowerCase();
                const realText = box.text_snippet || box.text || 'Sensitive Data';

                // Check categories
                const isImage = label.includes('image') || label.includes('face') || label.includes('photo') || label.includes('picture') || box.method === 'gaussian_blur';
                const isBlackBox = label.includes('password') || label.includes('secret') || label.includes('card') || label.includes('cvv') || label.includes('aadhaar') || label.includes('pan') || box.method === 'black_box';

                let methodUsed = 'semantic_mock';

                if (isImage) {
                  methodUsed = 'gaussian_blur';
                  // --- 1. GAUSSIAN BLUR FOR IMAGES & FACES ---
                  ctx.save();
                  ctx.beginPath();
                  ctx.rect(x, y, w, h);
                  ctx.clip();
                  ctx.filter = 'blur(14px)';
                  ctx.drawImage(img, 0, 0);
                  ctx.restore();

                } else if (isBlackBox) {
                  methodUsed = 'black_box';
                  // --- 2. SOLID BLACKOUT FOR PASSWORDS, AADHAAR, PAN & CARDS ---
                  // 4px padding to prevent anti-aliasing text bleed
                  ctx.fillStyle = '#000000';
                  ctx.fillRect(Math.max(0, x - 4), Math.max(0, y - 3), w + 8, h + 6);

                } else {
                  methodUsed = 'semantic_mock';
                  // --- 3. MOCK SENSITIVE PII (Name, Email, Phone, Address) ---
                  ctx.fillStyle = '#FFFFFF';
                  ctx.fillRect(x, y, w, h);

                  const fakeText = masker.getFakeValue(realText, label);

                  ctx.fillStyle = '#000000';
                  ctx.font = `${Math.max(12, Math.round(h * 0.7))}px sans-serif`;
                  ctx.textBaseline = 'middle';
                  ctx.fillText(fakeText, x + 2, y + h / 2);

                  mockedMappings.push({ real: realText, fake: fakeText });
                }

                manifest.redacted_regions.push({
                  type: label || 'pii',
                  method: methodUsed,
                  source: box.source || 'unknown',
                  bbox: {
                    x: Math.round(x),
                    y: Math.round(y),
                    w: Math.round(w),
                    h: Math.round(h)
                  }
                });
              });   

              // 3. Convert the modified canvas back into a clean image string
              const redactedDataUrl = canvas.toDataURL('image/jpeg', 0.95);

              // 4. Send the redacted image URL and manifest back
              sendResponse({
                success: true,
                redactedUrl: redactedDataUrl,
                manifest: manifest,
                mockedMappings: mockedMappings,
                latencyMs: e.data.latencyMs
              });
            };
            img.src = message.image;
          } else if (e.data.type === 'ERROR') {
        worker.removeEventListener('message', handleWorkerReply);
        sendResponse({ success: false, error: e.data.error });
      }
    };

    // 5. Register worker message listener and keep channel open for async response
    worker.addEventListener('message', handleWorkerReply);
    return true;
  }
});
