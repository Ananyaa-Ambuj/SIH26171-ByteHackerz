// Privag AI — Side Panel Controller & Orchestrator
// Connects on-device Florence-2 perception with upstream Flask VLM backend

let serverUrl = 'http://localhost:5000';
let actionHistory = [];
// The task's PII vault (pii-masker.js): everything sent to the server carries its fakes, and a fake the model
// types becomes the real value only where it belongs, right before execution. Memory-only, and it lives as long
// as the task: cleared when the task ends (done, Stop, its tab closed, a new task, Clear), kept while paused.
const masker = new PIIMasker();

// DOM Elements
const serverBadge = document.getElementById('serverBadge');
const modelBadge = document.getElementById('modelBadge');
const settingsToggle = document.getElementById('settingsToggle');
const settingsBody = document.getElementById('settingsBody');
const settingsArrow = document.getElementById('settingsArrow');
const serverUrlInput = document.getElementById('serverUrlInput');
const saveServerUrlBtn = document.getElementById('saveServerUrlBtn');
const serverHelp = document.getElementById('serverHelp');
const serverHelpUrl = document.getElementById('serverHelpUrl');
const serverRetryBtn = document.getElementById('serverRetryBtn');

const taskInput = document.getElementById('taskInput');
const stepButton = document.getElementById('stepButton');
const sanitizeButton = document.getElementById('sanitizeButton');
const clearButton = document.getElementById('clearButton');

const runBanner = document.getElementById('runBanner');
const runBannerText = document.getElementById('runBannerText');
const resumeButton = document.getElementById('resumeButton');
const allowButton = document.getElementById('allowButton');
const answerForm = document.getElementById('answerForm');
const answerInput = document.getElementById('answerInput');

const canvas = document.getElementById('screenshotCanvas');
const ctx = canvas.getContext('2d');
const canvasPlaceholder = document.getElementById('canvasPlaceholder');

const visionLatencyEl = document.getElementById('visionLatency');
const serverLatencyEl = document.getElementById('serverLatency');
const redactionCountEl = document.getElementById('redactionCount');

const actionVerbBadge = document.getElementById('actionVerbBadge');
const actionThoughtEl = document.getElementById('actionThought');
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

// Sanitized frames and the masked task go to this URL. Plain http is accepted only for this machine or a
// private network address (an on-prem server); anything else must use https.
function serverUrlProblem(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'not a valid URL';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol !== 'http:') return 'use an http(s) URL';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // Private ranges apply to IP address literals only (a name like 10.example.com can point anywhere)
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const local = host === 'localhost' || host === '::1' || (ipv4 && (/^127\./.test(host) || /^10\./.test(host) ||
    /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)));
  return local ? null : 'use https for a server outside this machine or your local network';
}

async function loadServerUrl() {
  try {
    const data = await chrome.storage.local.get(['privagServerUrl']);
    const saved = data.privagServerUrl?.trim().replace(/\/$/, '');
    if (saved && !serverUrlProblem(saved)) {
      serverUrl = saved;
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
  const problem = serverUrlProblem(val);
  if (problem) {
    log(`Server URL not saved: ${problem}.`, 'error');
    return;
  }
  serverUrl = val;
  try {
    await chrome.storage.local.set({ privagServerUrl: serverUrl });
    log(`Server URL saved: ${serverUrl}`, 'success');
  } catch (e) {
    log(`Failed to save server URL locally: ${e.message}`, 'error');
  }
  checkServerHealth();
}

// While the server cannot be reached, a card at the top of the panel says how to start it
async function checkServerHealth() {
  let online = false;
  try {
    const res = await fetch(`${serverUrl}/api/status`, { method: 'GET' });
    online = res.ok;
  } catch (e) {
    online = false;
  }
  serverBadge.textContent = online ? 'Server: Online' : 'Server: Offline';
  serverBadge.className = online ? 'badge badge-online' : 'badge badge-offline';
  serverHelpUrl.textContent = serverUrl;
  serverHelp.hidden = online;
  return online;
}

// 3. Setup Offscreen Document for Florence-2 Web Worker.
// Firefox has no offscreen API: offscreen.html runs in a hidden iframe inside this panel instead (it gets the
// same runtime messages) and lives as long as the panel. Every Firefox window has its own panel and vision host,
// so messages carry this panel's host id and other windows' panels and hosts ignore them.
const visionHostId = chrome.offscreen ? null : crypto.randomUUID();
const toVisionHost = (message) => (visionHostId ? { ...message, host: visionHostId } : message);

async function setupOffscreenDocument() {
  if (visionHostId) {
    if (document.getElementById('visionHost')) return;
    const frame = document.createElement('iframe');
    frame.id = 'visionHost';
    frame.hidden = true;
    frame.src = `offscreen.html?host=${visionHostId}`;
    // Loaded = offscreen.js is listening
    await new Promise((resolve) => {
      frame.addEventListener('load', resolve, { once: true });
      document.body.appendChild(frame);
    });
    log('Vision worker host initialized inside the panel.', 'info');
    return;
  }
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
  if (msg.host && msg.host !== visionHostId) return;
  if (msg.type === 'MODEL_READY') {
    modelProgress.style.display = 'none';
    const onGpu = msg.device === 'webgpu';
    modelBadge.textContent = onGpu ? 'WebGPU: Ready' : 'WASM: Ready';
    modelBadge.className = onGpu ? 'badge badge-online' : 'badge badge-warning';
    log(`Florence-2 vision model loaded on ${onGpu ? 'WebGPU' : 'WASM (CPU fallback, slow)'}!`, onGpu ? 'success' : 'warning');
    // A task paused only because the model was still loading carries on by itself
    if (task && runState === 'paused' && pauseCode === 'MODEL_NOT_READY') resumeTask();
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
    const state = await chrome.runtime.sendMessage(toVisionHost({ action: 'GET_MODEL_STATUS' }));
    if (state) handleModelMessage(state);
  } catch (e) {
    // Offscreen document not reachable yet; it will broadcast its state when loading finishes
  }
}

// 4. Capture & Sanitize a Tab (On-Device Dual-Pass)

// How long the page must be free of DOM changes before it is scanned, and the most we wait for that
const DOM_QUIET_MS = 300;
const DOM_QUIET_MAX_MS = 3000;
// Scan + capture attempts while the page keeps changing between the two
const MAX_CAPTURE_ATTEMPTS = 3;
// How long the DOM must have been still before the scan, so the painted frame already shows what the scan saw
const QUIET_BEFORE_SCAN_MS = 100;

// Masking for DOM detections (user decision D1): secrets are black-boxed with nothing to type; card and ID
// numbers are black-boxed with a placeholder the model may type; other values become look-alike fakes;
// profile photos get a solid mask
const SECRET_TYPES = new Set(['password', 'otp', 'cvv', 'card_meta', 'autofill']);
const ID_TYPES = new Set(['card', 'aadhaar', 'pan']);

const elapsed = (start) => Math.round(performance.now() - start);

// Runs one of content.js's functions in the tab through chrome.scripting.executeScript
async function runInTab(tabId, func, args = []) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return injection?.result;
}

// Fails closed: anything that keeps the DOM pass from running withholds the frame
async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['validators.js', 'content.js'] });
  } catch (e) {
    throw new Error(`Frame withheld: the DOM pass cannot run on this page (${e.message})`);
  }
}

function maskPlan(region, vault) {
  if (region.source === 'dom_media') return { method: 'solid_mask' };
  // Secrets, and regions whose text the DOM pass deliberately did not read (free text holding PII, button labels,
  // placeholders), are blacked out with nothing to type
  if (SECRET_TYPES.has(region.type) || region.text === undefined) return { method: 'black_box' };
  const origin = region.fieldId ? `field:${region.fieldId}` : 'page';
  const value = vault.getFakeValue(region.text, region.type, origin);
  return { method: ID_TYPES.has(region.type) ? 'black_box' : 'semantic_mock', value };
}

function sendToOffscreen(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(toVisionHost(message), (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

// One sanitized frame of the tab: DOM pass, screenshot, vision pass on media only, canvas masking, manifest.
// Real text from the page stops here; the frame and manifest only carry masks and the vault's fakes.
async function sanitizeTab(tabId, vault) {
  const timings = {};
  log('Capturing viewport screenshot...', 'info');
  await setupOffscreenDocument();
  const tab = await chrome.tabs.get(tabId);
  await injectContentScript(tabId);

  // Animations are paused from here until after the screenshot (they move content without a DOM mutation);
  // then let re-renders finish, so the scan and the screenshot see the same page
  let start = performance.now();
  let scan;
  let rawScreenshot;
  await runInTab(tabId, () => privagFreeze());
  try {
    await runInTab(tabId, (quiet, max) => privagWaitForQuiet(quiet, max), [DOM_QUIET_MS, DOM_QUIET_MAX_MS]);
    timings.settle = elapsed(start);

    // Pass 1 right before the capture, so its boxes match the pixels. If the page changed between the scan and
    // the capture (MutationObserver sequence), scan and capture again; a page that keeps changing is withheld,
    // because boxes from another moment cannot be trusted to cover what the screenshot shows.
    for (let attempt = 1; ; attempt++) {
      timings.attempts = attempt;
      start = performance.now();
      scan = await runInTab(tabId, () => privagScan());
      timings.dom = elapsed(start);
      if (!scan) throw new Error('Frame withheld: the DOM scan returned nothing');

      start = performance.now();
      rawScreenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      timings.capture = elapsed(start);
      // captureVisibleTab shoots whatever tab is active: if the user switched away meanwhile, the pixels belong
      // to another tab and the scan's boxes do not apply
      if (!(await chrome.tabs.get(tabId)).active || (task && pauseRequest)) throw new Error('Frame discarded: the tab changed during capture');

      // The frame is used only if the DOM was still from shortly before the scan until after the screenshot
      const seq = await runInTab(tabId, () => privagMutationSeq());
      if (seq === scan.seq && scan.quietBeforeMs >= QUIET_BEFORE_SCAN_MS) break;
      if (attempt >= MAX_CAPTURE_ATTEMPTS) {
        const err = new Error(`Frame withheld: the page kept changing between the scan and the screenshot (${attempt} tries)`);
        err.code = 'PAGE_UNSTABLE';
        throw err;
      }
      await runInTab(tabId, (quiet, max) => privagWaitForQuiet(quiet, max), [DOM_QUIET_MS, DOM_QUIET_MAX_MS / 3]);
    }
  } finally {
    await runInTab(tabId, () => privagUnfreeze()).catch(() => {});
  }
  const regions = scan.regions;
  log(`DOM scan: ${regions.length} PII regions, ${scan.elements.length} interactive elements, ` +
    `${scan.mediaRegions.length} media regions in ${scan.scanMs}ms`, 'info');

  const domRegions = regions.map((region) => {
    const plan = maskPlan(region, vault);
    return { type: region.type, source: region.source, bbox: region.bbox, method: plan.method, ...(plan.value !== undefined && { value: plan.value }) };
  });
  const elements = scan.elements.map((el) => ({ ...el, role: el.role.slice(0, 40), name: vault.maskText(el.name, 'page').slice(0, 80) }));

  log('Running on-device redaction...', 'info');
  const response = await sendToOffscreen({
    action: 'RUN_FLORENCE',
    image: rawScreenshot,
    domRegions,
    mediaRegions: scan.mediaRegions,
    elements: elements.map(({ ref, bbox }) => ({ ref, bbox })),
  });
  if (!response?.success) {
    const err = new Error(`Frame withheld: ${response?.error || 'redaction failed'}`);
    err.code = response?.code;
    throw err;
  }

  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load sanitized canvas preview'));
    image.src = response.redactedUrl;
  });
  const manifest = {
    redacted_regions: response.manifest.redacted_regions,
    // The coordinate space of coordinates, for anything that has no ref
    screenshot_dimensions: { width: img.width, height: img.height },
    dom_structure: { elements },
  };
  // Fail closed: a malformed manifest (or one carrying unexpected fields) is never sent
  const problems = PrivagRedactionManifest.validate(manifest);
  if (problems.length) throw new Error(`Frame withheld: invalid redaction manifest (${problems[0]})`);

  // Draw redacted image onto viewport canvas
  canvas.width = img.width;
  canvas.height = img.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  canvas.style.display = 'block';
  canvasPlaceholder.style.display = 'none';

  const count = manifest.redacted_regions.length;
  // 'skipped': no media on screen; 'cached': same pixels as an earlier step
  const vision = response.visionMode === 'ran' ? `${response.latencyMs}ms` : response.visionMode;
  visionLatencyEl.textContent = vision;
  redactionCountEl.textContent = count;
  log(`Redaction complete: ${count} regions masked (${domRegions.length} DOM + ${count - domRegions.length} vision; vision ${vision})`, 'success');

  Object.assign(timings, { vision: response.latencyMs, visionMode: response.visionMode, device: response.device, mask: response.maskMs });
  return { redactedUrl: response.redactedUrl, manifest, timings };
}

// 5. Autonomous ReAct agent: observe (sanitize) -> reason + act (server VLM) -> gate -> execute -> repeat.
// A task is pinned to the tab it started on. Switching tabs, leaving the start site, a model still loading or
// an error PAUSES it (the vault is kept); Resume continues. The task ends -- and the vault is cleared -- on
// "done", Stop, Clear, a new task or when its tab is closed.
const MAX_AGENT_STEPS = 15;
const MAX_STALLED_STEPS = 3;
let task = null;            // { goal, tabId, windowId, startUrl, step, stepsLeft, stalled }
let runState = 'idle';      // 'idle' | 'running' | 'paused' | 'confirming' | 'asking'
let pauseReason = '';
let pauseCode = null;
let pauseRequest = null;    // set by tab events while a step runs; the loop pauses at its next checkpoint
let serverRequest = null;   // AbortController of the in-flight server call
let userDecision = null;    // resolver while waiting for the user's click on a submit/pay action or an answer
// Per-step stage timings in ms (capture, DOM, vision, mask, network, VLM, execute), read by bench/
const stepTimings = window.__privagSteps = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function showDecision(action) {
  const verb = String(action.action || 'done').toUpperCase();
  if (action.thought) log(`Thought: ${action.thought}`, 'info');
  log(`VLM decided: ${verb} on "${action.target || action.ref || ''}"`, 'success');

  actionVerbBadge.textContent = verb;
  actionVerbBadge.className = 'badge badge-online';
  actionThoughtEl.textContent = action.thought || '—';
  actionTargetEl.textContent = [action.ref, action.target].filter(Boolean).join(' · ') || 'None';
  actionCoordsEl.textContent = action.ref ? `ref ${action.ref}`
    : Array.isArray(action.coordinates) ? `[${action.coordinates.join(', ')}]` : 'N/A';
  actionValueEl.textContent = action.value || action.question || 'None';
}

// Only these fields of the server's action are used, so a reply cannot smuggle in flags (e.g. a fake
// "confirmed": true) that the page-side code might trust
function pickAction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const action = { action: String(raw.action || '').toLowerCase() };
  for (const key of ['thought', 'target', 'value', 'ref', 'question']) {
    if (typeof raw[key] === 'string') action[key] = raw[key];
  }
  if (typeof raw.ref === 'number') action.ref = `e${raw.ref}`;
  if (Array.isArray(raw.coordinates) && raw.coordinates.length === 2 && raw.coordinates.every(Number.isFinite)) {
    action.coordinates = raw.coordinates;
  }
  return action;
}

// Lets click handlers, re-renders and smooth scrolling finish, then waits out any navigation the
// action started, so the next screenshot shows the action's effect
async function waitForPageSettle(tabId) {
  await sleep(800);
  for (let i = 0; i < 40; i++) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status === 'complete') return;
    await sleep(250);
  }
}

// Whether the task's tab can be observed right now: it must be the active tab of its window and still on the
// site the task started on
async function taskTabUsable() {
  const tab = await chrome.tabs.get(task.tabId).catch(() => null);
  if (!tab) return { ok: false, reason: "the task's tab is gone" };
  if (!tab.active) return { ok: false, reason: "switch back to the task's tab to continue" };
  if (!PrivagGate.sameSite(tab.url, task.startUrl)) return { ok: false, reason: `the tab is no longer on ${PrivagGate.hostOf(task.startUrl)}` };
  return { ok: true };
}

function pauseTask(reason, code = null) {
  runState = 'paused';
  pauseReason = reason;
  pauseCode = code;
  log(`Task paused: ${reason}. The vault is kept; Resume to continue or Stop to end the task.`, 'warning');
  setAgentUi();
}

// Converts a pause requested by a tab event into a pause; true when the step must not go on
function checkPauseRequest() {
  if (!task) return true;
  if (!pauseRequest) return false;
  const reason = pauseRequest;
  pauseRequest = null;
  pauseTask(reason);
  return true;
}

function requestPause(reason) {
  if (runState === 'running') {
    pauseRequest = reason;
    serverRequest?.abort();
  } else if (runState === 'confirming') {
    pauseRequest = reason;
    userDecision?.('pause');
  } else if (runState === 'paused') {
    setAgentUi();
  }
  // While the agent waits for an answer nothing touches the page: the question stays, and the loop checks the
  // tab again before its next step
}

function endTask(message, type = 'info') {
  if (!task) return;
  serverRequest?.abort();
  userDecision?.('stop');
  task = null;
  runState = 'idle';
  pauseRequest = null;
  pauseCode = null;
  actionHistory = [];
  masker.clear();
  log(`${message} Task ended; the vault was cleared.`, type);
  setAgentUi();
}

// Pauses until the user clicks Allow once (or Stop); the page is not touched before that
function askUser(question) {
  runState = 'confirming';
  pauseReason = question;
  log(`Waiting for your click: ${question}`, 'warning');
  setAgentUi();
  return new Promise((resolve) => {
    userDecision = (decision) => {
      userDecision = null;
      resolve(decision);
    };
  });
}

// The agent's question: the task waits for the user's typed answer (or Stop). The answer goes through the vault like
// the task text, so PII in it reaches the server only as placeholders, which the gate resolves in matching fields.
async function answerQuestion(action, current) {
  const question = action.question || action.value || '';
  runState = 'asking';
  pauseReason = question;
  log(`The agent asks: ${question}`, 'warning');
  answerInput.value = '';
  setAgentUi();
  answerInput.focus();
  const reply = await new Promise((resolve) => {
    userDecision = (decision) => {
      userDecision = null;
      resolve(decision);
    };
  });
  // The raw answer does not stay in the panel, neither after it is sent nor after Stop or Clear
  answerInput.value = '';
  if (!current() || typeof reply?.answer !== 'string') return { stale: true };
  runState = 'running';
  setAgentUi();
  const answer = masker.maskText(reply.answer, 'task');
  const entry = { action: 'ask_user', question: masker.maskText(question, 'page'), result: `The user answered: ${answer}` };
  if (typeof action.thought === 'string') entry.thought = masker.maskText(action.thought, 'page');
  log(`You answered; the agent sees: ${answer}`, 'success');
  actionHistory.push(JSON.stringify(entry));
  return { progress: true };
}

// The local gate: the target is described by the page, the rules in action-gate.js decide, and a typed fake is
// resolved to its real value only where the vault allows. Blocked actions are reported back to the model.
async function gateAndExecute(tabId, action) {
  const request = { action: action.action, ref: action.ref, coordinates: action.coordinates, target: action.target };
  const needsTarget = action.action === 'click' || action.action === 'type';
  const describe = () => (needsTarget ? runInTab(tabId, (data) => privagDescribeTarget(data), [request]) : null);
  const target = await describe();
  const gateContext = { startUrl: task.startUrl, blockedOrigins: [new URL(serverUrl).origin] };
  let verdict = PrivagGate.check(action, target?.found ? target : null, gateContext);
  if (needsTarget && !target?.found && target?.missing) verdict = { verdict: 'block', reason: target.missing };

  let value = action.value;
  if (verdict.verdict !== 'block' && action.action === 'type') {
    const resolved = masker.resolve(action.value, target);
    if (resolved.blocked.length) {
      const types = [...new Set(resolved.blocked.map((b) => b.type))].join(', ');
      verdict = { verdict: 'block', reason: `the ${types} value can only be typed into the field it came from or a field for that kind of value` };
    } else {
      value = resolved.text;
    }
  }

  if (verdict.verdict === 'confirm') {
    const run = task;
    const decision = await askUser(`${action.action} "${target.label || action.target || action.ref || ''}" (${verdict.reason})`);
    if (decision !== 'allow' || task !== run) return { paused: true };
    runState = 'running';
    setAgentUi();
    log('Allowed by you once.', 'success');
    // The page may have changed while it waited: the click goes ahead only on the very element you allowed
    const now = await describe();
    const same = (k) => now?.[k] === target[k];
    if (!now?.found || !['tag', 'label', 'href', 'submitsForm', 'formAction'].every(same)) {
      verdict = { verdict: 'block', reason: 'the target changed while waiting for your click; nothing was done' };
    } else {
      const again = PrivagGate.check(action, now, gateContext);
      if (again.verdict === 'block') verdict = again;
    }
  }
  if (verdict.verdict === 'block') {
    log(`Gate blocked ${action.action}: ${verdict.reason}`, 'warning');
    return { success: false, message: `Blocked on the device: ${verdict.reason}` };
  }
  const result = await runInTab(tabId, (data) => privagExecute(data), [{
    ...request,
    value,
    ...(action.action === 'type' && { expectFieldId: target.fieldId }),
  }]);
  return result || { success: false, message: 'No result reported by the page' };
}

// One ReAct turn. The action is recorded together with its result, which the model reads next turn.
async function runAgentStep(current) {
  const tabId = task.tabId;
  task.step++;
  task.stepsLeft--;
  const timing = { step: task.step };
  const { redactedUrl, manifest, timings } = await sanitizeTab(tabId, masker);
  if (!current()) return { stale: true };
  Object.assign(timing, timings);
  if (checkPauseRequest()) return { paused: true };

  log(`Step ${task.step}: dispatching sanitized perception to ${serverUrl}/api...`, 'info');
  const startTime = performance.now();
  serverRequest = new AbortController();
  const response = await fetch(`${serverUrl}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // PII in the task itself (e.g. "type my PAN ...") is faked too; the vault restores it where it belongs
    // The server accepts the 50 most recent steps
    body: JSON.stringify({ image: redactedUrl, task: masker.maskText(task.goal, 'task'), history: actionHistory.slice(-50), manifest }),
    signal: serverRequest.signal
  });
  const payload = await response.json().catch(() => ({}));
  if (!current()) return { stale: true };
  const roundTrip = elapsed(startTime);
  serverRequest = null;
  serverLatencyEl.textContent = `${roundTrip}ms`;
  // The server explains its refusals (400: which check failed; 502: why the LLM call failed)
  if (!response.ok) {
    const detail = Array.isArray(payload.details) && payload.details.length ? ` (${payload.details[0]})` : '';
    throw new Error(`${payload.error || `Server returned HTTP ${response.status}`}${detail}`);
  }
  const vlm = Number.isFinite(payload.timing?.vlm_ms) ? payload.timing.vlm_ms : null;
  Object.assign(timing, { server: roundTrip, vlm, network: vlm === null ? null : Math.max(0, roundTrip - vlm) });
  // The user switched away while the model was thinking: this action is dropped, the step is redone on Resume
  if (checkPauseRequest()) return { paused: true };

  const action = pickAction(payload.action);
  if (!action) throw new Error('Server returned empty action payload');
  if (payload.invalid_reason) log(`The model's reply was not a valid action (${payload.invalid_reason}).`, 'warning');
  showDecision(action);
  if (action.action === 'done') {
    stepTimings.push(timing);
    return { done: true };
  }
  if (action.action === 'ask_user') {
    stepTimings.push(timing);
    return answerQuestion(action, current);
  }

  log(`Executing ${action.action} on the task's tab...`, 'info');
  const executeStart = performance.now();
  const result = await gateAndExecute(tabId, action);
  if (!current()) return { stale: true };
  timing.execute = elapsed(executeStart);
  stepTimings.push(timing);
  if (result.paused) {
    checkPauseRequest();
    return { paused: true };
  }
  // Results can quote the page (e.g. a picked dropdown option), and the model's own fields could echo a real
  // value it was never shown: everything entering the history is masked
  const entry = { ...action, result: masker.maskText(result.message, 'page') };
  for (const key of ['thought', 'target', 'value']) {
    if (typeof entry[key] === 'string') entry[key] = masker.maskText(entry[key], 'page');
  }
  log(`Page execution: ${entry.result}`, result.success ? 'success' : 'warning');
  actionHistory.push(JSON.stringify(entry));
  return { progress: result.success && action.action !== 'wait' };
}

// A loop belongs to one run of one task: Stop + Run (or Resume) starts a new run, and the old loop, still
// awaiting something, notices on its next checkpoint that it is stale and exits without touching anything
async function runLoop() {
  const run = Symbol('run');
  task.run = run;
  const current = () => Boolean(task) && task.run === run;
  runState = 'running';
  setAgentUi();
  try {
    while (current() && runState === 'running') {
      const usable = await taskTabUsable();
      if (!current()) return;
      if (!usable.ok) return pauseTask(usable.reason);
      if (task.stepsLeft <= 0) {
        task.stepsLeft = MAX_AGENT_STEPS;
        return pauseTask(`${MAX_AGENT_STEPS} steps without finishing; Resume allows ${MAX_AGENT_STEPS} more`);
      }
      actionVerbBadge.textContent = 'THINKING';
      actionVerbBadge.className = 'badge badge-warning';

      const outcome = await runAgentStep(current);
      if (!current() || outcome.paused || outcome.stale) return;
      if (outcome.done) return endTask(`Task complete after ${task.step} step(s).`, 'success');

      // Waiting, failing or being blocked makes no progress; several in a row means the agent is stuck
      task.stalled = outcome.progress ? 0 : task.stalled + 1;
      if (task.stalled >= MAX_STALLED_STEPS) {
        task.stalled = 0;
        return pauseTask(`${MAX_STALLED_STEPS} steps in a row made no progress`);
      }
      await waitForPageSettle(task.tabId);
      if (!current() || checkPauseRequest()) return;
    }
  } catch (err) {
    if (!current() || checkPauseRequest()) return;
    if (err.name === 'AbortError') return pauseTask('the server request was cancelled');
    if (err.code === 'MODEL_NOT_READY') return pauseTask('the vision model is still loading; the task resumes when it is ready', 'MODEL_NOT_READY');
    actionVerbBadge.textContent = 'ERROR';
    actionVerbBadge.className = 'badge badge-offline';
    pauseTask(err.message);
  } finally {
    if (current()) serverRequest = null;
    setAgentUi();
  }
}

async function startTask() {
  const goal = taskInput.value.trim();
  if (!goal) {
    log('Enter a task for the agent first.', 'warning');
    taskInput.focus();
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    log('No active browser tab found.', 'error');
    return;
  }
  if (!(await checkServerHealth())) {
    log(`No Privag server at ${serverUrl}; start it as shown at the top of the panel, then press Run Agent again.`, 'warning');
    serverHelp.scrollIntoView({ block: 'nearest' });
    return;
  }
  masker.clear();
  actionHistory = [];
  stepTimings.length = 0;
  task = { goal, tabId: tab.id, windowId: tab.windowId, startUrl: tab.url, step: 0, stepsLeft: MAX_AGENT_STEPS, stalled: 0 };
  log(`Task started on ${PrivagGate.hostOf(tab.url) || 'this tab'}.`, 'info');
  runLoop();
}

async function resumeTask() {
  if (!task || runState !== 'paused') return;
  const usable = await taskTabUsable();
  if (!usable.ok) {
    log(`Cannot resume yet: ${usable.reason}.`, 'warning');
    return;
  }
  pauseRequest = null;
  pauseCode = null;
  log('Task resumed.', 'info');
  runLoop();
}

function setAgentUi() {
  const active = Boolean(task);
  stepButton.innerHTML = active ? '<span class="btn-icon">■</span> Stop' : '<span class="btn-icon">⚡</span> Run Agent';
  stepButton.className = active ? 'btn btn-danger' : 'btn btn-primary';
  stepButton.disabled = false;
  sanitizeButton.disabled = active;
  taskInput.disabled = active;

  const banner = runState === 'paused' || runState === 'confirming' || runState === 'asking';
  runBanner.hidden = !banner;
  runBanner.className = `run-banner ${{ confirming: 'run-banner-confirm', asking: 'run-banner-ask' }[runState] || ''}`;
  runBannerText.textContent = {
    confirming: `Your click is needed: ${pauseReason}`,
    asking: `The agent asks: ${pauseReason}`,
  }[runState] || `Paused: ${pauseReason}`;
  resumeButton.hidden = runState !== 'paused';
  allowButton.hidden = runState !== 'confirming';
  answerForm.hidden = runState !== 'asking';
}

// Tab events: the task follows only its own tab
chrome.tabs.onRemoved.addListener((tabId) => {
  if (task && tabId === task.tabId) endTask("The task's tab was closed.", 'warning');
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (!task || windowId !== task.windowId) return;
  if (tabId !== task.tabId) requestPause('you switched to another tab');
  else setAgentUi();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!task || tabId !== task.tabId || !changeInfo.url) return;
  if (!PrivagGate.sameSite(changeInfo.url, task.startUrl)) requestPause(`the tab left ${PrivagGate.hostOf(task.startUrl)}`);
});

// 6. Event Listeners
settingsToggle.addEventListener('click', () => {
  const isOpen = settingsBody.classList.toggle('open');
  settingsArrow.style.transform = isOpen ? 'rotate(180deg)' : 'rotate(0deg)';
});

saveServerUrlBtn.addEventListener('click', saveServerUrl);

serverRetryBtn.addEventListener('click', async () => {
  log((await checkServerHealth()) ? `Privag server found at ${serverUrl}.` : `Still no Privag server at ${serverUrl}.`, 'info');
});

serverUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveServerUrl();
});

stepButton.addEventListener('click', () => {
  if (!task) {
    startTask();
    return;
  }
  endTask('Stopped by you.', 'warning');
});

resumeButton.addEventListener('click', resumeTask);

allowButton.addEventListener('click', () => {
  userDecision?.('allow');
});

answerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const answer = answerInput.value.trim();
  if (!answer || runState !== 'asking') {
    answerInput.focus();
    return;
  }
  userDecision?.({ answer });
});

sanitizeButton.addEventListener('click', async () => {
  sanitizeButton.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active browser tab found.');
    // Outside a task the preview uses a throwaway vault
    const { timings } = await sanitizeTab(tab.id, new PIIMasker());
    window.__privagLastSanitize = timings;
  } catch (err) {
    log(`Sanitize error: ${err.message}`, 'error');
  } finally {
    sanitizeButton.disabled = Boolean(task);
  }
});

clearButton.addEventListener('click', () => {
  if (task) endTask('Cleared by you.', 'info');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.style.display = 'none';
  canvasPlaceholder.style.display = 'flex';
  actionVerbBadge.textContent = 'IDLE';
  actionVerbBadge.className = 'badge badge-neutral';
  actionThoughtEl.textContent = '—';
  actionTargetEl.textContent = '—';
  actionCoordsEl.textContent = '—';
  actionValueEl.textContent = '—';
  visionLatencyEl.textContent = '—';
  serverLatencyEl.textContent = '—';
  redactionCountEl.textContent = '0';
  log('Viewport cleared.', 'info');
});

// Periodic server health check every 15s
setInterval(checkServerHealth, 15000);

// Initialize on mount
loadTheme();
loadServerUrl();
setAgentUi();
setupOffscreenDocument().then(syncModelStatus);
