// Per-stage latency and peak memory of real agent steps, measured end to end in a Chromium-based browser with
// the unpacked extension, the real Flask server and (by default) a local mock LLM.
// Stages per step, as recorded by the side panel (window.__privagSteps): settle (wait for a quiet DOM),
// dom (scan round trip), capture (captureVisibleTab), vision (Florence-2 worker time), mask (canvas masking
// and JPEG encoding), network (server round trip minus VLM time), vlm (time the server waited for the LLM),
// execute (gate + action in the page).
// Memory: private bytes of every browser process, sampled about once a second, grouped into the page's
// renderer, extension processes (side panel + offscreen document that hosts the model), GPU process and other.
//
// Run:  cd tests; npm install; cd ..; node bench/bench.mjs
// Env:  BROWSER, PRIVAG_PYTHON, PROFILE_DIR, MODEL_TIMEOUT_S  as in tests/privacy/privacy.test.mjs
//       STEPS    agent steps to measure (default 10)
//       LLM_URL / LLM_MODEL / LLM_API_KEY  a real OpenAI-compatible endpoint instead of the mock
//                (e.g. http://localhost:11434/v1 and gemma4:31b-it-q4_K_M); without it "vlm" is the mock's time
//       LABEL    file name label for the results (default: hostname)
//       BROWSER_ARGS  extra browser flags, space-separated (e.g. --disable-blink-features=WebGPU to measure the
//                WASM fallback)
// Use a profile without restored tabs: every restored tab is one more renderer process in the memory figures.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const require = createRequire(path.join(REPO, 'tests', 'package.json'));
const puppeteer = require('puppeteer-core');

const STEPS = Number(process.env.STEPS || 10);
const extraArgs = (process.env.BROWSER_ARGS || '').split(/\s+/).filter(Boolean);
const RESULTS = path.join(HERE, 'results');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout)));

function findBrowser() {
  if (process.env.BROWSER) return process.env.BROWSER;
  const candidates = {
    win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/brave-browser'],
  }[process.platform] || [];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('No Chromium-based browser found; set BROWSER to its executable');
  return found;
}

function findPython() {
  if (process.env.PRIVAG_PYTHON) return process.env.PRIVAG_PYTHON;
  const venv = path.join(REPO, 'server', '.venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python');
  return fs.existsSync(venv) ? venv : 'python';
}

// Every descendant process of the browser with its command line and private bytes
async function processTree(rootPid) {
  let rows = [];
  if (process.platform === 'win32') {
    const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,PrivatePageCount,WorkingSetSize,CommandLine | ConvertTo-Json -Compress';
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    try {
      rows = JSON.parse(out).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, privateBytes: Number(p.PrivatePageCount), workingSet: Number(p.WorkingSetSize), cmd: p.CommandLine || '' }));
    } catch { rows = []; }
  } else {
    const out = await run('ps', ['-axo', 'pid=,ppid=,rss=,command=']);
    rows = out.trim().split('\n').map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return m && { pid: Number(m[1]), ppid: Number(m[2]), privateBytes: Number(m[3]) * 1024, workingSet: Number(m[3]) * 1024, cmd: m[4] };
    }).filter(Boolean);
  }
  const keep = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const r of rows) if (!keep.has(r.pid) && keep.has(r.ppid)) { keep.add(r.pid); changed = true; }
  }
  return rows.filter((r) => keep.has(r.pid));
}

const kindOf = (cmd) => (/--type=gpu-process/.test(cmd) ? 'gpu'
  : /--type=renderer/.test(cmd) ? (/--extension-process/.test(cmd) ? 'extension' : 'renderer')
  : /--type=/.test(cmd) ? 'other' : 'browser');

async function hardware() {
  const info = { platform: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model?.trim(), cpuThreads: os.cpus().length, ramGiB: Number((os.totalmem() / 2 ** 30).toFixed(1)) };
  const gpu = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader']);
  if (gpu.trim()) info.nvidiaGpu = gpu.trim();
  return info;
}

const stats = (values) => {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const at = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  return { n: v.length, min: v[0], median: at(0.5), p90: at(0.9), max: v[v.length - 1] };
};

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  const cleanup = [];
  const finish = async () => { for (const fn of cleanup.reverse()) await fn().catch(() => {}); };
  try {
    const face = fs.readFileSync(path.join(REPO, 'tests', 'privacy', 'fixture', 'face.jpg'));
    const site = await listen((req, res) => {
      if (req.url.startsWith('/face.jpg')) { res.setHeader('Content-Type', 'image/jpeg'); return res.end(face); }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(fs.readFileSync(path.join(HERE, 'fixture', 'index.html')));
    });
    cleanup.push(async () => site.close());

    // Mock LLM (unless a real one is given): clicks Next STEPS times, then "done"
    let llmUrl = process.env.LLM_URL;
    let llmModel = process.env.LLM_MODEL || 'mock';
    if (!llmUrl) {
      let calls = 0;
      const mock = await listen((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          calls++;
          // Target "Next" by the ref the extension listed in the manifest, like a real model would
          const manifestText = JSON.parse(body).messages[1].content.find((c) => c.type === 'text' && c.text.startsWith('Current Redaction Manifest')).text;
          const next = JSON.parse(manifestText.slice(manifestText.indexOf('{'))).dom_structure.elements.find((e) => e.name === 'Next')?.ref;
          const action = calls <= STEPS ? { thought: 'next', action: 'click', ref: next, target: 'Next' } : { thought: 'done', action: 'done' };
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(action) } }] }));
        });
      });
      cleanup.push(async () => mock.close());
      llmUrl = `http://127.0.0.1:${mock.address().port}/v1`;
    }

    const flaskPort = await freePort();
    const flask = spawn(findPython(), ['app.py'], {
      cwd: path.join(REPO, 'server'),
      env: { ...process.env, PRIVAG_HOST: '127.0.0.1', PRIVAG_PORT: String(flaskPort), PRIVAG_LLM_URL: llmUrl, PRIVAG_LLM_MODEL: llmModel, PRIVAG_LLM_API_KEY: process.env.LLM_API_KEY || '' },
    });
    cleanup.push(async () => { flask.kill(); });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${flaskPort}/api/status`)).ok) break; } catch { await sleep(200); }
    }

    const profile = process.env.PROFILE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'privag-bench-'));
    const browser = await puppeteer.launch({
      executablePath: findBrowser(), headless: true, pipe: true, userDataDir: profile,
      enableExtensions: [path.join(REPO, 'extension')], defaultViewport: null,
      args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,1000', ...extraArgs],
    });
    cleanup.push(async () => browser.close());
    const rootPid = browser.process().pid;

    // Memory sampler
    const samples = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const tree = await processTree(rootPid);
        const byKind = {};
        for (const p of tree) byKind[kindOf(p.cmd)] = (byKind[kindOf(p.cmd)] || 0) + p.privateBytes;
        const pageRenderers = tree.filter((p) => kindOf(p.cmd) === 'renderer').map((p) => p.privateBytes);
        samples.push({
          t: Date.now(), total: tree.reduce((s, p) => s + p.privateBytes, 0), ...byKind, maxRenderer: Math.max(0, ...pageRenderers),
          // Every process, so the grouping can be checked afterwards
          processes: tree.map((p) => ({ pid: p.pid, kind: kindOf(p.cmd), privateMiB: Number((p.privateBytes / 2 ** 20).toFixed(1)) })),
        });
        await sleep(1000);
      }
    })();
    cleanup.push(async () => { sampling = false; await sampler; });

    const worker = await browser.waitForTarget((tg) => tg.type() === 'service_worker' && tg.url().includes('background.js'), { timeout: 30000 });
    const panel = await browser.newPage();
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    await panel.evaluate((url) => { serverUrl = url; }, `http://127.0.0.1:${flaskPort}`);

    const loadStart = Date.now();
    let badge = '';
    while (Date.now() - loadStart < Number(process.env.MODEL_TIMEOUT_S || 1200) * 1000 && !/Ready|Failed/.test(badge)) {
      badge = await panel.evaluate(() => document.getElementById('modelBadge').textContent);
      await sleep(500);
    }
    const modelLoadMs = Date.now() - loadStart;
    log(`model: ${badge} after ${modelLoadMs} ms`);
    if (!/Ready/.test(badge)) throw new Error(`vision model did not load: ${badge}`);
    // What the model download put in the extension's Cache Storage (Transformers.js caches every file it fetches)
    const modelCache = await panel.evaluate(async () => {
      const files = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          const blob = await (await cache.match(request)).blob();
          files.push({ cache: name, file: new URL(request.url).pathname.split('/').slice(-2).join('/'), bytes: blob.size });
        }
      }
      return files;
    });
    const adapter = await panel.evaluate(async () => {
      try { const a = await navigator.gpu?.requestAdapter(); return a ? { vendor: a.info?.vendor, architecture: a.info?.architecture, description: a.info?.description } : null; } catch { return null; }
    });

    const pageUrl = `http://127.0.0.1:${site.address().port}/`;
    await panel.evaluate(async (url) => {
      const tab = await chrome.tabs.create({ url, active: true });
      for (let i = 0; i < 100 && (await chrome.tabs.get(tab.id)).status !== 'complete'; i++) await new Promise((r) => setTimeout(r, 100));
    }, pageUrl);
    const page = await (await browser.waitForTarget((tg) => tg.url() === pageUrl)).page();

    const runStart = Date.now();
    const memoryBefore = samples.length;
    await panel.evaluate(() => {
      document.getElementById('taskInput').value = 'Click Next on every step';
      document.getElementById('stepButton').click();
    });
    // Up to 5 minutes per step: a vision pass on the WASM fallback takes far longer than on WebGPU
    let state;
    const runDeadline = Date.now() + STEPS * 300_000;
    while (Date.now() < runDeadline) {
      state = await panel.evaluate(() => ({ task: Boolean(task), runState, banner: document.getElementById('runBannerText').textContent }));
      if (!state.task || state.runState === 'paused') break;
      await sleep(250);
    }
    const runMs = Date.now() - runStart;
    const steps = await panel.evaluate(() => window.__privagSteps);
    const heap = await page.metrics();
    sampling = false;
    await sampler;

    const during = samples.slice(memoryBefore);
    const peak = (key) => Math.max(0, ...during.map((s) => s[key] || 0));
    const mib = (bytes) => Number((bytes / 2 ** 20).toFixed(1));
    const stages = ['settle', 'dom', 'capture', 'vision', 'mask', 'network', 'vlm', 'execute', 'server'];
    const result = {
      date: new Date().toISOString(),
      hardware: { ...(await hardware()), webgpuAdapter: adapter },
      browser: await browser.version(),
      browserArgs: extraArgs,
      visionDevice: steps.find((s) => s.device)?.device || null,
      vlm: process.env.LLM_URL ? { url: 'real endpoint (LLM_URL)', model: llmModel } : { url: 'local mock (canned replies)', model: 'mock' },
      requestedSteps: STEPS,
      finalState: state,
      runMs,
      // From opening the side panel until the model badge said Ready (includes the download on a fresh profile)
      modelLoadMs,
      // vision: only steps where the model actually ran (a cached or skipped vision pass takes no model time)
      stagesMs: Object.fromEntries(stages.map((k) => [k, stats((k === 'vision' ? steps.filter((s) => s.visionMode === 'ran') : steps).map((s) => s[k]))])),
      visionModes: steps.map((s) => s.visionMode),
      peakMemoryMiB: {
        // pageRenderer: the largest non-extension renderer, i.e. the test page's tab
        total: mib(peak('total')), pageRenderer: mib(peak('maxRenderer')), allRenderers: mib(peak('renderer')),
        extensionProcesses: mib(peak('extension')), gpuProcess: mib(peak('gpu')), browserProcess: mib(peak('browser')), other: mib(peak('other')),
      },
      pageJsHeapUsedMiB: mib(heap.JSHeapUsedSize),
      modelCacheMiB: mib(modelCache.reduce((sum, f) => sum + f.bytes, 0)),
      modelCacheFiles: modelCache,
      steps,
      memorySamples: during,
    };
    const label = (process.env.LABEL || os.hostname()).replace(/[^\w.-]+/g, '-');
    const file = path.join(RESULTS, `${result.date.slice(0, 10)}-${label}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    log(`raw results: ${path.relative(REPO, file)}`);
    log('stages (ms):', JSON.stringify(result.stagesMs));
    log('peak memory (MiB):', JSON.stringify(result.peakMemoryMiB));
    log('vision device:', result.visionDevice, 'vlm:', JSON.stringify(result.vlm));
  } finally {
    await finish();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
