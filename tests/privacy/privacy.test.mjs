// Privacy end-to-end test: the core promise of Privag AI is that no raw PII leaves the device.
// Loads a fixture page full of synthetic PII (Aadhaar, PAN, card, phone, email, OTP, UPI, IFSC and a face
// photo) in a real Chromium-based browser with the unpacked extension, runs one agent step through the real
// Flask server (backed by a local mock LLM), captures the exact bytes of every outbound request and asserts
// that none of the PII strings appear in them -- neither in what the extension sends to the server, nor in
// what the server sends to the LLM -- and that the masks in the sent image are solid.
//
// Run:  cd tests; npm install; npm run test:privacy
// Env:  BROWSER       Chrome/Chromium/Brave executable (default: common install paths)
//       PRIVAG_PYTHON Python with the server requirements (default: server/.venv, then "python")
//       PROFILE_DIR   browser profile; reuse one to skip the one-time Florence-2 download (default: a temp dir)
//       MODEL_TIMEOUT_S  how long to wait for the vision model to load (default 1200)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const EXTENSION = path.join(REPO, 'extension');
const FIXTURE = path.join(HERE, 'fixture');
const OUT = path.join(HERE, 'out');
const require = createRequire(import.meta.url);
const { validate: validateManifest } = require(path.join(EXTENSION, 'redaction-manifest.js'));

// Every PII value on the fixture page or in the task, in the forms it could leak in
const PII = [
  '2345 6789 0124', '234567890124',            // Aadhaar
  'ABCPE1234F',                                 // PAN
  '4111 1111 1111 1111', '4111111111111111',    // card
  '98765 43210', '9876543210',                  // mobile
  'ravi.kumar@example.com',                     // email
  '482913',                                     // OTP
  'ravi.kumar@okicici',                         // UPI
  'SBIN0001234',                                // IFSC
];
const TASK = 'Check the KYC page. My card is 4111 1111 1111 1111, OTP 482913, PAN ABCPE1234F. Click Next.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const readBody = (req) => new Promise((resolve) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });

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

test('no raw PII leaves the device during an agent step', { timeout: 30 * 60 * 1000 }, async (t) => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const cleanup = [];
  t.after(async () => { for (const fn of cleanup.reverse()) await fn().catch(() => {}); });

  // Fixture page
  const site = await listen((req, res) => {
    const file = req.url.startsWith('/face.jpg') ? 'face.jpg' : 'index.html';
    res.setHeader('Content-Type', file.endsWith('.jpg') ? 'image/jpeg' : 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(FIXTURE, file)));
  });
  cleanup.push(async () => site.close());
  const pageUrl = `http://127.0.0.1:${site.address().port}/`;

  // Mock OpenAI-compatible LLM: records exactly what the server sends; first reply clicks Next, then "done"
  const llmBodies = [];
  const llm = await listen(async (req, res) => {
    const body = (await readBody(req)).toString('utf8');
    llmBodies.push(body);
    const request = JSON.parse(body);
    const manifestText = request.messages[1].content.find((c) => c.type === 'text' && c.text.startsWith('Current Redaction Manifest')).text;
    const manifest = JSON.parse(manifestText.slice(manifestText.indexOf('{')));
    const next = manifest.dom_structure.elements.find((e) => e.name === 'Next')?.ref;
    const action = llmBodies.length === 1 && next
      ? { thought: 'Go to the next page', action: 'click', ref: next, target: 'Next' }
      : { thought: 'Nothing left to do', action: 'done' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(action) } }] }));
  });
  cleanup.push(async () => llm.close());

  // The real Flask server, configured by environment variables only
  const flaskPort = await freePort();
  const flask = spawn(findPython(), ['app.py'], {
    cwd: path.join(REPO, 'server'),
    env: { ...process.env, PRIVAG_HOST: '127.0.0.1', PRIVAG_PORT: String(flaskPort), PRIVAG_LLM_URL: `http://127.0.0.1:${llm.address().port}/v1`, PRIVAG_LLM_MODEL: 'mock', PRIVAG_LLM_API_KEY: '' },
  });
  let flaskLog = '';
  flask.stdout.on('data', (d) => (flaskLog += d));
  flask.stderr.on('data', (d) => (flaskLog += d));
  cleanup.push(async () => { flask.kill(); });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${flaskPort}/api/status`)).ok; } catch { await sleep(200); }
  }
  assert.ok(up, `Flask server did not start:\n${flaskLog}`);

  // Recording proxy in front of the server: the exact bytes the extension sends off the device
  const outbound = [];
  const proxy = await listen(async (req, res) => {
    const body = await readBody(req);
    outbound.push({ method: req.method, url: req.url, headers: req.headers, body: body.toString('utf8') });
    const upstream = await fetch(`http://127.0.0.1:${flaskPort}${req.url}`, {
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] || 'application/json' },
      body: req.method === 'GET' ? undefined : body,
    });
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  cleanup.push(async () => proxy.close());

  const profile = process.env.PROFILE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'privag-'));
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    pipe: true,
    userDataDir: profile,
    enableExtensions: [EXTENSION],
    defaultViewport: null,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,1000'],
  });
  cleanup.push(async () => browser.close());

  const worker = await browser.waitForTarget((tg) => tg.type() === 'service_worker' && tg.url().includes('background.js'), { timeout: 30000 });
  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await panel.evaluate((url) => { serverUrl = url; }, `http://127.0.0.1:${proxy.address().port}`);

  // The face on the page needs the on-device vision model (downloaded once per profile)
  const modelDeadline = Date.now() + Number(process.env.MODEL_TIMEOUT_S || 1200) * 1000;
  let badge = '';
  while (Date.now() < modelDeadline && !/Ready|Failed/.test(badge)) {
    badge = await panel.evaluate(() => document.getElementById('modelBadge').textContent);
    await sleep(1000);
  }
  assert.match(badge, /Ready/, `vision model did not load: ${badge}`);

  // The fixture as the active tab of the panel's window, then one agent run
  await panel.evaluate(async (url) => {
    const tab = await chrome.tabs.create({ url, active: true });
    for (let i = 0; i < 100 && (await chrome.tabs.get(tab.id)).status !== 'complete'; i++) await new Promise((r) => setTimeout(r, 100));
  }, pageUrl);
  await panel.evaluate((goal) => {
    document.getElementById('taskInput').value = goal;
    document.getElementById('stepButton').click();
  }, TASK);
  let state;
  for (let i = 0; i < 240; i++) {
    state = await panel.evaluate(() => ({ task: Boolean(task), runState, banner: document.getElementById('runBannerText').textContent }));
    if (!state.task || state.runState === 'paused') break;
    await sleep(500);
  }
  const auditLog = await panel.evaluate(() => [...document.querySelectorAll('#auditLog .log-entry')].map((e) => e.textContent));
  fs.writeFileSync(path.join(OUT, 'audit-log.txt'), auditLog.join('\n'));
  assert.ok(!state.task, `the agent run did not finish: ${JSON.stringify(state)}`);

  const steps = outbound.filter((r) => r.url === '/api');
  steps.forEach((r, i) => fs.writeFileSync(path.join(OUT, `outbound-${i + 1}.json`), r.body));
  llmBodies.forEach((b, i) => fs.writeFileSync(path.join(OUT, `server-to-llm-${i + 1}.json`), b));
  assert.ok(steps.length >= 1, 'no agent step reached the server');

  // 1. The exact outbound requests: extension -> server, and server -> LLM
  for (const [label, bodies] of [['extension -> server', steps.map((r) => r.body)], ['server -> LLM', llmBodies]]) {
    bodies.forEach((body, i) => {
      const leaked = PII.filter((value) => body.includes(value));
      assert.deepEqual(leaked, [], `${label} request ${i + 1} contains raw PII: ${leaked.join(', ')}`);
    });
  }

  // 2. Each manifest passes the schema, and the page's PII is actually masked (not just absent from text)
  const first = JSON.parse(steps[0].body);
  assert.deepEqual(validateManifest(first.manifest), []);
  const regions = first.manifest.redacted_regions;
  const has = (type, method) => regions.some((r) => r.type === type && r.method === method);
  for (const [type, method] of [['aadhaar', 'black_box'], ['pan', 'black_box'], ['card', 'black_box'], ['otp', 'black_box'],
    ['phone', 'semantic_mock'], ['email', 'semantic_mock'], ['upi', 'semantic_mock'], ['ifsc', 'semantic_mock'], ['face', 'solid_mask']]) {
    assert.ok(has(type, method), `expected a ${method} region of type ${type}; got ${regions.map((r) => `${r.type}/${r.method}`).join(' ')}`);
  }
  assert.match(first.task, /4111 1111 1111 0001/, 'the card number in the task should be replaced by its placeholder');

  // 3. The masks in the sent image are solid: decode the JPEG in the browser and measure each mask's interior
  const image = first.image;
  fs.writeFileSync(path.join(OUT, 'outbound-1.jpg'), Buffer.from(image.split(',')[1], 'base64'));
  const fills = await panel.evaluate(async (dataUrl, boxes) => {
    const img = new Image();
    await new Promise((resolve) => { img.onload = resolve; img.src = dataUrl; });
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return boxes.map(({ bbox, method }) => {
      // Interior only: JPEG ringing at the edges is not a leak
      const x = Math.round(bbox.x) + 3, y = Math.round(bbox.y) + 3, w = Math.round(bbox.w) - 6, h = Math.round(bbox.h) - 6;
      const d = g.getImageData(x, y, w, h).data;
      const target = method === 'solid_mask' ? 0x7f : 0;
      let ok = 0;
      for (let i = 0; i < d.length; i += 4) if ([d[i], d[i + 1], d[i + 2]].every((v) => Math.abs(v - target) <= 12)) ok++;
      return ok / (d.length / 4);
    });
  }, image, regions.filter((r) => (r.method === 'solid_mask' || r.method === 'black_box') && r.bbox.w > 8 && r.bbox.h > 8));
  fills.forEach((f, i) => assert.ok(f >= 0.98, `mask ${i} is not solid (${(f * 100).toFixed(1)}% uniform)`));

  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({
    outboundRequests: steps.length,
    serverToLlmRequests: llmBodies.length,
    piiStringsChecked: PII,
    regions: regions.map((r) => ({ type: r.type, method: r.method, source: r.source })),
    maskUniformity: fills.map((f) => Number(f.toFixed(4))),
  }, null, 2));
});
