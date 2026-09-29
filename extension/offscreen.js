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

              // 2. Instantiate masker to generate fake replacement values
              const masker = new PIIMasker();
              const mockedMappings = [];

              const boxes = e.data.regions || e.data.boxes || e.data.bboxes || e.data.predictions || [];

              boxes.forEach((box) => {
                let x, y, w, h;

                if (Array.isArray(box)) {
                  const [ymin, xmin, ymax, xmax] = box;
                  x = (xmin / 1000) * img.width;
                  y = (ymin / 1000) * img.height;
                  w = ((xmax - xmin) / 1000) * img.width;
                  h = ((ymax - ymin) / 1000) * img.height;
                } else {
                  x = box.x;
                  y = box.y;
                  w = box.width;
                  h = box.height;
                }

                const label = (box.label || box.category || box.type || '').toLowerCase();

                // Check categories
                const isImage = label.includes('image') || label.includes('face') || label.includes('photo') || label.includes('picture');
                const isPassword = label.includes('password') || label.includes('secret') || label.includes('card') || label.includes('cvv');

                if (isImage && w > 0 && h > 0) {
                  // --- 1. GAUSSIAN BLUR FOR IMAGES & FACES ---
                  ctx.save();
                  ctx.beginPath();
                  ctx.rect(x, y, w, h);
                  ctx.clip();
                  ctx.filter = 'blur(12px)';
                  ctx.drawImage(img, 0, 0);
                  ctx.restore();

                } else if (isPassword) {
                  // --- 2. SOLID BLACKOUT FOR PASSWORDS & CREDENTIALS ---
                  ctx.fillStyle = '#000000';
                  ctx.fillRect(x, y, w, h);

                } else {
                  // --- 3. MOCK SENSITIVE PII (Name, Email, Phone, Address) ---
                  ctx.fillStyle = '#FFFFFF';
                  ctx.fillRect(x, y, w, h);

                  const realText = box.text || 'Sensitive Data';
                  const fakeText = masker.getFakeValue(realText, label);

                  ctx.fillStyle = '#000000';
                  ctx.font = `${Math.max(12, h * 0.6)}px sans-serif`;
                  ctx.textBaseline = 'middle';
                  ctx.fillText(fakeText, x + 4, y + h / 2);

                  mockedMappings.push({ real: realText, fake: fakeText });
                }
              });   

          // 3. Convert the modified canvas back into a clean image string
          const redactedDataUrl = canvas.toDataURL('image/jpeg', 0.95);

          // 4. Send the redacted image URL back to popup.js
          sendResponse({
            success: true,
            redactedUrl: redactedDataUrl,
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
