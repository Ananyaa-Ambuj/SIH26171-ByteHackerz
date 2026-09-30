// Privag AI — Side Panel Controller & Orchestrator
// Connects on-device Florence-2 perception with upstream Flask VLM backend

let serverUrl = 'http://localhost:5000';
let actionHistory = [];

// DOM Elements
const serverBadge = document.getElementById('serverBadge');
const modelBadge = document.getElementById('modelBadge');
const settingsToggle = document.getElementById('settingsToggle');
const settingsBody = document.getElementById('settingsBody');
const settingsArrow = document.getElementById('settingsArrow');
const serverUrlInput = document.getElementById('serverUrlInput');
const saveServerUrlBtn = document.getElementById('saveServerUrlBtn');

const taskInput = document.getElementById('taskInput');
const stepButton = document.getElementById('stepButton');
const sanitizeButton = document.getElementById('sanitizeButton');
const clearButton = document.getElementById('clearButton');

const canvas = document.getElementById('screenshotCanvas');
const ctx = canvas.getContext('2d');
const canvasPlaceholder = document.getElementById('canvasPlaceholder');

const visionLatencyEl = document.getElementById('visionLatency');
const serverLatencyEl = document.getElementById('serverLatency');
const redactionCountEl = document.getElementById('redactionCount');

const actionVerbBadge = document.getElementById('actionVerbBadge');
const actionTargetEl = document.getElementById('actionTarget');
const actionCoordsEl = document.getElementById('actionCoords');
const actionValueEl = document.getElementById('actionValue');
const auditLog = document.getElementById('auditLog');

// Progress bar elements
const modelProgress = document.getElementById('modelProgress');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const progressPercent = document.getElementById('progressPercent');

// Theme elements
const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');

// 1. Audit Logger Helper
function log(msg, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  const time = new Date().toLocaleTimeString([], { hour12: false });
  entry.textContent = `[${time}] ${msg}`;
  auditLog.appendChild(entry);
  auditLog.scrollTop = auditLog.scrollHeight;
}

// 1b. Theme System (auto / light / dark)
const THEME_MODES = ['auto', 'light', 'dark'];
const THEME_ICONS = { auto: '🖥️', light: '☀️', dark: '🌙' };
let currentThemeMode = 'auto';

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(mode) {
  currentThemeMode = mode;
  const effective = mode === 'auto' ? getSystemTheme() : mode;
  document.documentElement.setAttribute('data-theme', effective);
  themeIcon.textContent = THEME_ICONS[mode];
  themeToggle.title = `Theme: ${mode.charAt(0).toUpperCase() + mode.slice(1)}`;
}

async function loadTheme() {
  try {
    const data = await chrome.storage.local.get(['privagTheme']);
    applyTheme(data.privagTheme || 'auto');
  } catch (e) {
    applyTheme('auto');
  }
}

themeToggle.addEventListener('click', async () => {
  const next = THEME_MODES[(THEME_MODES.indexOf(currentThemeMode) + 1) % THEME_MODES.length];
  applyTheme(next);
  try { await chrome.storage.local.set({ privagTheme: next }); } catch (e) {}
  log(`Theme → ${next}`, 'info');
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (currentThemeMode === 'auto') applyTheme('auto');
});

// 2. Server URL Persistence & Health Check
async function loadServerUrl() {
  try {
    const data = await chrome.storage.local.get(['privagServerUrl']);
    if (data.privagServerUrl) {
      serverUrl = data.privagServerUrl.trim().replace(/\/$/, '');
      serverUrlInput.value = serverUrl;
    }
  } catch (e) {
    console.warn('Storage unavailable, using default server URL', e);
  }
  checkServerHealth();
}

async function saveServerUrl() {
  const val = serverUrlInput.value.trim().replace(/\/$/, '');
  if (!val) return;
  serverUrl = val;
  try {
    await chrome.storage.local.set({ privagServerUrl: serverUrl });
    log(`Server URL saved: ${serverUrl}`, 'success');
  } catch (e) {
    log(`Failed to save server URL locally: ${e.message}`, 'error');
  }
  checkServerHealth();
}

async function checkServerHealth() {
  try {
    const res = await fetch(`${serverUrl}/api/status`, { method: 'GET' });
    if (res.ok) {
      serverBadge.textContent = 'Server: Online';
      serverBadge.className = 'badge badge-online';
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (e) {
    serverBadge.textContent = 'Server: Offline';
    serverBadge.className = 'badge badge-offline';
  }
}

// 3. Setup Offscreen Document for Florence-2 Web Worker
async function setupOffscreenDocument() {
  if (await chrome.offscreen.hasDocument?.()) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER', 'WORKERS'],
      justification: 'Running Florence-2 Web Worker & HTML5 Canvas 2D operations.'
    });
    log('Offscreen vision worker host initialized.', 'info');
  } catch (err) {
    if (!err.message.includes('Only a single offscreen document may be created')) {
      log(`Offscreen init error: ${err.message}`, 'error');
    }
  }
}

// Listen for model state announcements from offscreen worker
function handleModelMessage(msg) {
  if (msg.type === 'MODEL_READY') {
    modelProgress.style.display = 'none';
    const onGpu = msg.device === 'webgpu';
    modelBadge.textContent = onGpu ? 'WebGPU: Ready' : 'WASM: Ready';
    modelBadge.className = onGpu ? 'badge badge-online' : 'badge badge-warning';
    log(`Florence-2 vision model loaded on ${onGpu ? 'WebGPU' : 'WASM (CPU fallback, slow)'}!`, onGpu ? 'success' : 'warning');
  } else if (msg.type === 'PROGRESS') {
    const p = msg.progress;
    // Use the aggregate over all model files; per-file events made the bar jump between files
    if (p && p.status === 'progress_total' && typeof p.progress === 'number') {
      modelProgress.style.display = 'block';
      const pct = Math.round(p.progress);
      progressBar.style.width = `${pct}%`;
      progressPercent.textContent = `${pct}%`;
      progressText.textContent = p.file ? `Loading ${p.file.split('/').pop()}` : 'Loading model...';
      modelBadge.textContent = `Model: ${pct}%`;
    }
  } else if (msg.type === 'STATUS') {
    log(`[Worker] ${msg.message}`, 'info');
  } else if (msg.type === 'ERROR') {
    modelProgress.style.display = 'none';
    modelBadge.textContent = 'Model: Failed';
    modelBadge.className = 'badge badge-offline';
    log(`[Worker] ${msg.error}`, 'error');
  }
}
chrome.runtime.onMessage.addListener(handleModelMessage);

// A panel opened after loading finished missed the one-time MODEL_READY / ERROR broadcast, so ask for it
async function syncModelStatus() {
  try {
    const state = await chrome.runtime.sendMessage({ action: 'GET_MODEL_STATUS' });
    if (state) handleModelMessage(state);
  } catch (e) {
    // Offscreen document not reachable yet; it will broadcast its state when loading finishes
  }
}

// 4. Capture & Sanitize Page (On-Device Dual-Pass)
async function sanitizeActiveTab() {
  log('Capturing viewport screenshot...', 'info');
  await setupOffscreenDocument();

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || !activeTab.id) {
    throw new Error('No active browser tab found.');
  }

  // Ensure content script is injected for DOM operations
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ['content.js']
    });
  } catch (e) {
    console.warn('Content script already present or injected:', e);
  }

  // Pass 1: deterministic DOM scan, taken right before the capture so its boxes match the pixels
  let domScan = { regions: [], dom_structure: null };
  try {
    domScan = (await chrome.tabs.sendMessage(activeTab.id, { action: 'SCAN_PII' })) || domScan;
    log(`DOM scan found ${domScan.regions.length} PII regions in ${domScan.scanMs ?? 0}ms`, 'info');
  } catch (e) {
    log(`DOM scan unavailable on this page (${e.message}); relying on the vision pass only`, 'warning');
  }

  const rawScreenshot = await chrome.tabs.captureVisibleTab(
    activeTab.windowId,
    { format: 'png' }
  );

  log('Running Florence-2 WebGPU on-device redaction...', 'info');

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'RUN_FLORENCE', image: rawScreenshot, domRegions: domScan.regions },
      (response) => {
        if (chrome.runtime.lastError) {
          log(`Vision error: ${chrome.runtime.lastError.message}`, 'error');
          return reject(new Error(chrome.runtime.lastError.message));
        }

        if (!response || !response.success) {
          const err = response?.error || 'Worker redaction failed';
          log(`Redaction failed: ${err}`, 'error');
          return reject(new Error(err));
        }

        // Draw redacted image onto viewport canvas
        const img = new Image();
        img.onload = () => {
          canvas.width = img.width;
          canvas.height = img.height;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);

          canvas.style.display = 'block';
          canvasPlaceholder.style.display = 'none';

          const count = response.manifest?.redacted_regions?.length || 0;
          visionLatencyEl.textContent = `${response.latencyMs || 0}ms`;
          redactionCountEl.textContent = count;

          const domCount = domScan.regions.length;
          log(`Redaction complete: ${count} regions occluded (${domCount} DOM + ${count - domCount} vision in ${response.latencyMs}ms)`, 'success');
          resolve({
            redactedUrl: response.redactedUrl,
            manifest: { ...(response.manifest || { redacted_regions: [] }), dom_structure: domScan.dom_structure },
            mockedMappings: response.mockedMappings || [],
            tabId: activeTab.id
          });
        };
        img.onerror = () => reject(new Error('Failed to load sanitized canvas preview'));
        img.src = response.redactedUrl;
      }
    );
  });
}

// 5. Run Full Autonomous Agent Step (Sanitize -> Server VLM -> Execute Action)
async function runAIStep() {
  const userGoal = taskInput.value.trim() || 'Analyze page context and select the next interactive element.';
  stepButton.disabled = true;
  sanitizeButton.disabled = true;
  actionVerbBadge.textContent = 'THINKING';
  actionVerbBadge.className = 'badge badge-warning';

  try {
    const { redactedUrl, manifest, tabId } = await sanitizeActiveTab();

    log(`Dispatching sanitized perception to ${serverUrl}/api...`, 'info');
    const startTime = performance.now();

    const response = await fetch(`${serverUrl}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: redactedUrl,
        task: userGoal,
        history: actionHistory,
        manifest: manifest
      })
    });

    const elapsed = Math.round(performance.now() - startTime);
    serverLatencyEl.textContent = `${elapsed}ms`;

    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }

    const payload = await response.json();
    const action = payload.action;

    if (!action) {
      throw new Error('Server returned empty action payload');
    }

    const verb = String(action.action || 'done').toUpperCase();
    log(`VLM decided: ${verb} on "${action.target || ''}"`, 'success');

    // Update Decision Card
    actionVerbBadge.textContent = verb;
    actionVerbBadge.className = 'badge badge-online';
    actionTargetEl.textContent = action.target || 'None';
    actionCoordsEl.textContent = Array.isArray(action.coordinates) ? `[${action.coordinates.join(', ')}]` : 'N/A';
    actionValueEl.textContent = action.value || 'None';

    // Append to conversation history for multi-turn coherence
    actionHistory.push(JSON.stringify(action));

    // Execute the action directly on the active webpage via content.js
    log(`Executing ${action.action} on active tab...`, 'info');
    chrome.tabs.sendMessage(tabId, { action: 'EXECUTE_ACTION', data: action }, (res) => {
      if (chrome.runtime.lastError) {
        log(`Execution dispatch warning: ${chrome.runtime.lastError.message}`, 'warning');
      } else if (res && res.success) {
        log(`Page execution: ${res.message}`, 'success');
      } else {
        log(`Execution feedback: ${res?.message || 'Done'}`, 'info');
      }
    });

  } catch (err) {
    log(`Step error: ${err.message}`, 'error');
    actionVerbBadge.textContent = 'ERROR';
    actionVerbBadge.className = 'badge badge-offline';
  } finally {
    stepButton.disabled = false;
    sanitizeButton.disabled = false;
  }
}

// 6. Event Listeners
settingsToggle.addEventListener('click', () => {
  const isOpen = settingsBody.classList.toggle('open');
  settingsArrow.style.transform = isOpen ? 'rotate(180deg)' : 'rotate(0deg)';
});

saveServerUrlBtn.addEventListener('click', saveServerUrl);

serverUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveServerUrl();
});

stepButton.addEventListener('click', runAIStep);

sanitizeButton.addEventListener('click', async () => {
  sanitizeButton.disabled = true;
  try {
    await sanitizeActiveTab();
  } catch (err) {
    log(`Sanitize error: ${err.message}`, 'error');
  } finally {
    sanitizeButton.disabled = false;
  }
});

clearButton.addEventListener('click', () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.style.display = 'none';
  canvasPlaceholder.style.display = 'flex';
  actionVerbBadge.textContent = 'IDLE';
  actionVerbBadge.className = 'badge badge-neutral';
  actionTargetEl.textContent = '—';
  actionCoordsEl.textContent = '—';
  actionValueEl.textContent = '—';
  visionLatencyEl.textContent = '—';
  serverLatencyEl.textContent = '—';
  redactionCountEl.textContent = '0';
  actionHistory = [];
  log('Viewport and action history cleared.', 'info');
});

// Periodic server health check every 15s
setInterval(checkServerHealth, 15000);

// Initialize on mount
loadTheme();
loadServerUrl();
setupOffscreenDocument().then(syncModelStatus);
