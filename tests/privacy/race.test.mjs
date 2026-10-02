// Fail-closed test for pages that move or change: the boxes of a DOM scan are only valid for the pixels of the same
// moment, so a frame whose page changed between the scan and the screenshot must be withheld, never sent with
// boxes from another moment. PII on these pages is drawn in pure magenta; a strongly magenta pixel left in a SENT
// frame is unmasked PII.
//
// Run:  cd tests; npm install; npm run test:privacy      (same environment variables as privacy.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.resolve(HERE, '..', '..', 'extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const css = '<meta charset="utf-8"><style>body{font-family:Arial,sans-serif;margin:0;padding:16px 28px;background:#fff;color:#111}.pii{color:#ff00ff}</style>';
const lines = Array.from({ length: 40 }, (_, i) => `<div>Line ${i + 1}: 12 MG Road, account ${30012345600 + i}</div>`).join('');
const PAGES = {
  // Script-driven ticker: the phone number moves every animation frame (a DOM mutation each frame)
  '/ticker': `<!doctype html><html><head>${css}</head><body><h1>Ticker</h1>
    <div id="tick" class="pii" style="position:absolute;top:120px;left:0;font-size:28px;white-space:nowrap">Call 98765 43210</div>
    <script>let x=0;const t=document.getElementById('tick');const f=()=>{x=(x+3)%800;t.style.left=(20+x)+'px';requestAnimationFrame(f)};requestAnimationFrame(f);</script></body></html>`,
  // CSS slide-in: moves without any DOM mutation
  '/slide': `<!doctype html><html><head>${css}<style>@keyframes slidein{from{transform:translateX(-1000px)}to{transform:translateX(0)}}
    #toast{position:fixed;left:300px;top:200px;padding:16px;border:2px solid #333;background:#fff;font-size:28px;animation:slidein 4s linear 0.3s both}</style></head>
    <body><h1>Messages</h1><div id="toast">New login from <span class="pii">98765 43210</span></div></body></html>`,
  // Live feed: a new phone number every 30 ms
  '/feed': `<!doctype html><html><head>${css}</head><body><h1>Live feed</h1><div id="feed"></div>
    <script>let n=0;setInterval(()=>{const d=document.createElement('div');d.className='pii';d.style.fontSize='24px';
    d.textContent='Ph 9'+String(100000000+((n++*7919)%899999999)).slice(0,9);const f=document.getElementById('feed');f.prepend(d);if(f.children.length>12)f.lastChild.remove();},30);</script></body></html>`,
  // 40 magenta lines inside an iframe the DOM pass cannot read
  '/dense': `<!doctype html><html><head>${css}</head><body><h1 style="font-size:18px;margin:4px 0">Dense frame</h1>
    <iframe sandbox srcdoc="${`<body style='font:13px Arial;margin:6px;color:#ff00ff;line-height:17px'>${lines}</body>`.replace(/"/g, '&quot;')}" style="position:absolute;left:20px;top:40px;width:760px;height:720px;border:1px solid #999"></iframe></body></html>`,
};

test('moving and changing pages never send unmasked PII', { timeout: 30 * 60 * 1000 }, async (t) => {
  const cleanup = [];
  t.after(async () => { for (const fn of cleanup.reverse()) await fn().catch(() => {}); });
  const site = await new Promise((resolve) => {
    const s = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGES[req.url.split('?')[0]] || ''); });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  cleanup.push(async () => site.close());
  const origin = `http://127.0.0.1:${site.address().port}`;

  const browser = await puppeteer.launch({
    executablePath: findBrowser(), headless: true, pipe: true,
    userDataDir: process.env.PROFILE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'privag-')),
    enableExtensions: [EXTENSION], defaultViewport: null,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,1000'],
  });
  cleanup.push(async () => browser.close());
  const worker = await browser.waitForTarget((tg) => tg.type() === 'service_worker' && tg.url().includes('background.js'), { timeout: 30000 });
  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  const deadline = Date.now() + Number(process.env.MODEL_TIMEOUT_S || 1200) * 1000;
  let badge = '';
  while (Date.now() < deadline && !/Ready|Failed/.test(badge)) {
    badge = await panel.evaluate(() => document.getElementById('modelBadge').textContent);
    await sleep(1000);
  }
  assert.match(badge, /Ready/, `vision model did not load: ${badge}`);

  const openTab = (url) => panel.evaluate(async (u) => {
    const tab = await chrome.tabs.create({ url: u, active: true });
    for (let i = 0; i < 100 && (await chrome.tabs.get(tab.id)).status !== 'complete'; i++) await new Promise((r) => setTimeout(r, 100));
    return tab.id;
  }, url);
  const closeTab = (id) => panel.evaluate((tabId) => chrome.tabs.remove(tabId), id);
  // One sanitize; returns {sent: false, error} when withheld, else {sent: true, magenta: strongly magenta pixels}
  const sanitize = (tabId) => panel.evaluate(async (id) => {
    try {
      const r = await sanitizeTab(id, new PIIMasker());
      const img = new Image();
      await new Promise((resolve) => { img.onload = resolve; img.src = r.redactedUrl; });
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let magenta = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] > 200) magenta++;
      return { sent: true, magenta };
    } catch (e) {
      return { sent: false, error: e.message };
    }
  }, tabId);

  // 1. A script-driven ticker never holds still: every frame is withheld, or sent fully masked
  let tab = await openTab(`${origin}/ticker`);
  for (let i = 0; i < 3; i++) {
    const r = await sanitize(tab);
    assert.ok(!r.sent ? /kept changing/.test(r.error) : r.magenta === 0, `ticker ${i}: ${JSON.stringify(r)}`);
  }
  await closeTab(tab);

  // 2. A CSS slide-in is paused for the capture, so the frame is sent and the moving PII is masked
  for (let i = 0; i < 6; i++) {
    tab = await openTab(`${origin}/slide?${i}`);
    await sleep(300 + i * 600);
    const r = await sanitize(tab);
    assert.ok(r.sent && r.magenta === 0, `slide-in sampled after ${300 + i * 600} ms: ${JSON.stringify(r)}`);
    await closeTab(tab);
  }

  // 3. A feed adding a phone number every 30 ms is withheld (or sent fully masked)
  tab = await openTab(`${origin}/feed`);
  for (let i = 0; i < 5; i++) {
    const r = await sanitize(tab);
    assert.ok(!r.sent || r.magenta === 0, `feed ${i}: ${JSON.stringify(r)}`);
  }
  await closeTab(tab);

  // 4. Every line inside a frame the DOM pass cannot read is masked
  tab = await openTab(`${origin}/dense`);
  const dense = await sanitize(tab);
  assert.ok(dense.sent && dense.magenta === 0, `dense frame: ${JSON.stringify(dense)}`);
});
