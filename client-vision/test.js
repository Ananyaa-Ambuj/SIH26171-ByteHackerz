const statusDiv = document.getElementById('status');
const detectBtn = document.getElementById('detectBtn');
const generateBtn = document.getElementById('generateBtn');
const imageInput = document.getElementById('imageInput');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const output = document.getElementById('output');

let isModelReady = false;

// 1. Spawn the Florence Web Worker (the extension's build: `npm run build`, served from the repo root)
const worker = new Worker('../extension/florence-worker.bundle.js', { type: 'module' });
worker.postMessage({ type: 'LOAD_MODEL' });

// 2. Listen for worker updates (download progress & results)
worker.addEventListener('message', (e) => {
    const { type, message, progress, regions, latencyMs, error, device } = e.data;

    if (type === 'STATUS') {
        statusDiv.textContent = `ℹ️ ${message}`;
        statusDiv.className = 'loading';
    } else if (type === 'PROGRESS') {
        if (progress && progress.progress) {
            statusDiv.textContent = `⏳ Downloading weights: ${Math.round(progress.progress)}% (${progress.file || ''})`;
        }
    } else if (type === 'MODEL_READY') {
        isModelReady = true;
        statusDiv.textContent = `✅ Florence-2 Model Ready on ${device === 'webgpu' ? 'WebGPU' : 'WASM (CPU fallback)'}!`;
        statusDiv.className = 'ready';
        detectBtn.disabled = false;
    } else if (type === 'RESULTS') {
        statusDiv.textContent = `✅ Detection Complete in ${latencyMs} ms!`;
        statusDiv.className = 'ready';
        detectBtn.disabled = false;

        // Display structured results
        output.textContent = JSON.stringify({ latencyMs, regionsFound: regions.length, regions }, null, 2);

        // Draw redaction boxes on the canvas
        drawRedactions(regions);
    } else if (type === 'ERROR') {
        statusDiv.textContent = `❌ Error: ${error}`;
        statusDiv.className = 'loading';
        detectBtn.disabled = false;
        output.textContent = error;
    }
});

// 3. Helper to draw redactions on the canvas
// 3. Helper to draw REAL Gaussian Blur and Clean Black Boxes
function drawRedactions(regions) {
    regions.forEach((r) => {
        // Add a 4px safety padding around the bounding box
        const padX = 4;
        const padY = 3;
        const x = Math.max(0, r.bbox.x - padX);
        const y = Math.max(0, r.bbox.y - padY);
        const w = r.bbox.w + (padX * 2);
        const h = r.bbox.h + (padY * 2);

        if (r.method === 'gaussian_blur') {
            // REAL Canvas Gaussian Blur
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, w, h);
            ctx.clip(); // Restrict blur only to this box
            ctx.filter = 'blur(14px)';
            ctx.drawImage(canvas, 0, 0);
            ctx.restore();

            // Clean border + label badge
            ctx.strokeStyle = 'rgba(37, 99, 235, 0.8)';
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, w, h);
            ctx.fillStyle = '#2563eb';
            ctx.font = 'bold 11px sans-serif';
            ctx.fillText('BLURRED FACE', x + 4, Math.max(16, y - 4));
        } else {
            // Solid, clean black privacy bar
            ctx.fillStyle = '#000000';
            ctx.fillRect(x, y, w, h);

            // Subtle privacy tag
            ctx.fillStyle = '#64748b';
            ctx.font = '9px monospace';
            ctx.fillText(`• REDACTED (${r.type})`, x + w + 8, y + h - 2);
        }
    });
}

// 4. Generate a Sample Form with fake PII for instant 1-click testing
function createSampleForm() {
    canvas.width = 600;
    canvas.height = 360;

    // Background
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Form Box
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#cbd5e1';
    ctx.fillRect(20, 20, 560, 320);
    ctx.strokeRect(20, 20, 560, 320);

    // Header
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText('User Identity Verification Form', 40, 60);

    // Fields
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#334155';
    ctx.fillText('Full Name: John Doe', 40, 110);
    ctx.fillText('Aadhaar No: 9876 5432 1098', 40, 150);
    ctx.fillText('PAN Card: ABCDE1234F', 40, 190);
    ctx.fillText('Phone No: 9876543210', 40, 230);
    ctx.fillText('Email: user.demo@privacy.org', 40, 270);

    // Fake Profile Avatar (Face circle)
    ctx.beginPath();
    ctx.arc(480, 140, 45, 0, Math.PI * 2);
    ctx.fillStyle = '#cbd5e1';
    ctx.fill();
    ctx.fillStyle = '#475569';
    ctx.font = '12px sans-serif';
    ctx.fillText('Profile Photo', 445, 210);

    output.textContent = '// Sample form loaded onto canvas. Click "Run AI Detection" to scan!';
}

// 5. Button & Input Event Handlers
generateBtn.addEventListener('click', createSampleForm);

imageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const img = new Image();
    img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        output.textContent = '// Image loaded. Click "Run AI Detection" to scan!';
    };
    img.src = URL.createObjectURL(file);
});

detectBtn.addEventListener('click', () => {
    if (!isModelReady) return;

    statusDiv.textContent = '⚡ Running Florence-2 Detection on WebGPU...';
    statusDiv.className = 'loading';
    detectBtn.disabled = true;

    // Send the canvas image data to the worker
    const imageDataUrl = canvas.toDataURL('image/png');
    worker.postMessage({
        type: 'DETECT',
        imageDataUrl: imageDataUrl,
    });
});

// Auto-create sample form on page load
createSampleForm();
