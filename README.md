Demo video: TODO-VIDEO-LINK

# Privag AI — an on-device PII firewall for browser agents

Smart India Hackathon 2026 · Problem statement **SIH26171** (ISRO): *On-device Visual Perception for Light-weight Browser Agents* · Team **ByteHackerz**, IIT Bhilai

Privag AI is a browser extension that lets a server-side vision-language model (Gemma 4) operate web pages for you without seeing your personal data. Before every step it finds PII on your device — in the page's DOM with checksum validators, and inside images and frames with the Florence-2 vision model running in the browser — and masks it in the screenshot, the task text and the action history. The server answers with one JSON action, which the extension checks against a local gate (no typing secrets, no leaving the site, your click before submit or pay) and then executes.

![Architecture as submitted](assets/Privagflowchart.png)

*The architecture diagram from our submission. Two differences in the code: faces get a solid grey mask instead of a blur, and names in free text are not detected yet (on-device NER is planned).*

## How one agent step works

1. **Pin and settle.** The task is pinned to the tab it started on; the extension pauses the page's animations and waits until its DOM stops changing (MutationObserver).
2. **DOM pass** (`extension/content.js`, `extension/validators.js`). Visible text is checked with validators — Aadhaar (Verhoeff), cards (Luhn), PAN, Indian mobile, UPI, IFSC, email, labelled OTPs; a regex match alone never masks. Form fields are classified by purpose (`type`, `autocomplete` tokens such as `one-time-code` and `cc-number`, labels), including autofilled fields. Interactive elements get refs (`e1`, `e2`, …).
3. **Screenshot** with `chrome.tabs.captureVisibleTab()`. If the page changed around the scan or the capture, both are redone; a page that keeps changing is withheld instead of sent. The raw image never leaves the browser.
4. **Vision pass** (`client-vision/worker.js`): Florence-2 (ONNX, Transformers.js) in a Web Worker on WebGPU with a WASM fallback, run only on images, video, canvas, frames and embedded PDFs: faces (`<OD>`) and text (`<OCR_WITH_REGION>`).
5. **Canvas masking** (`extension/offscreen.js`): black boxes for passwords, OTPs, card and ID numbers and text in images; a solid grey mask for faces and profile photos; format-preserving fakes (`user_0001@example.com`, `90000 00001`) for values the agent may need. A redaction manifest `{type, method, source, bbox}` describes every mask and is schema-checked.
6. **Masked text.** The task and the action history go through the same placeholder vault (memory only).
7. **Server** (`server/`, Flask): validates the request, asks Gemma 4 (vLLM or Ollama, OpenAI-compatible API) and validates the reply into exactly one action: `{"action": "click|type|scroll|wait|done", "ref", "target", "coordinates", "value"}`.
8. **Local gate and execution.** The action is checked on the device; a placeholder becomes the real value only in the field it belongs to; the action runs via `chrome.scripting.executeScript()`; repeat until `done`.

Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · server API: [`docs/API.md`](docs/API.md)

## Run it

**Two-minute check, no server and no model needed:** load the extension (section 2 or 3 below), open any page with personal data on it, open the Privag side panel and press **Sanitize Only**. The panel shows the masked frame exactly as the agent would send it, and the audit log lists what was masked. Running the agent itself needs the server (section 1) and a vision-language model behind it; until the server answers, the side panel shows how to start it.

### 1. Server (Python 3.11+)

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python app.py
```

On Linux/macOS use `.venv/bin/python`. The server listens on `http://127.0.0.1:5000` with the debugger off and opens its setup page in your browser, where you enter the model's OpenAI-compatible URL (and a key, if the endpoint needs one). Settings come from `server/config.default.json`, overridden by the dashboard at `http://127.0.0.1:5000/` (local only; saved to the git-ignored `server/config.json`) and by environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PRIVAG_LLM_URL` | `http://localhost:11434/v1` | OpenAI-compatible endpoint (Ollama; vLLM serves on `http://<host>:8000/v1`) |
| `PRIVAG_LLM_MODEL` | `gemma4:31b-it-q4_K_M` | Ollama tag of Gemma 4 31B-it (Q4_K_M); for vLLM use `google/gemma-4-31B-it` |
| `PRIVAG_LLM_API_KEY` | empty | only for endpoints that need a key |
| `PRIVAG_LLM_TIMEOUT` | `600` | seconds to wait for the model |
| `PRIVAG_HOST` / `PRIVAG_PORT` | `127.0.0.1` / `5000` | where the server listens (`0.0.0.0` to serve a LAN) |
| `PRIVAG_DEBUG` | off | `1` enables Flask debug mode (never on a shared network) |
| `PRIVAG_OPEN_DASHBOARD` | `1` | the server opens its setup page in your browser when it starts; `0` skips that |

`server/.env.example` documents the same variables; the server reads the process environment and does not load `.env` files. To serve Gemma 4 with Ollama: `ollama pull gemma4:31b-it-q4_K_M`, then start the server as above.

### 2. Extension — Chrome, Edge or Brave

1. Open `chrome://extensions` (`brave://extensions`, `edge://extensions`) and turn on **Developer mode**.
2. **Load unpacked** → select the `extension/` folder. No build step: the vision worker bundle and the ONNX Runtime files are committed (rebuild with `cd client-vision; npm install; npm run build`).
3. Click the toolbar icon to open the side panel. The first start downloads the Florence-2 weights from Hugging Face; the browser caches them.
4. In the side panel's settings, the server URL defaults to `http://localhost:5000` (plain `http` is accepted only for this machine or a private network address).
5. Open a page, type a task and press **Run Agent**. **Sanitize Only** shows the masked frame without contacting the server.

### 3. Extension — Firefox

Firefox 140 or newer; the same `extension/` folder, no build step.

1. Open `about:debugging#/runtime/this-firefox` and click **Load Temporary Add-on…**.
2. Select `extension/manifest.json`. (A temporary add-on is removed when Firefox closes.)
3. Click the Privag toolbar button to open the sidebar. If Firefox lists the add-on as needing site access, allow it in `about:addons` → Privag AI → Permissions.
4. Continue from step 4 above. In our Firefox test the vision model ran on WASM, which is much slower than WebGPU (see Measured results).

### 4. Tests and benchmark

```sh
node --test "tests/unit/*.test.mjs"                         # validators, action gate, manifest schema, vault, OCR rules
cd server && .venv/Scripts/python -m unittest discover -s tests   # server contract and security fixes
cd tests && npm install && npm run test:privacy               # privacy end-to-end test (needs a Chromium-based browser)
node bench/bench.mjs                                          # per-stage latency and peak memory -> bench/results/
```

[`tests/README.md`](tests/README.md) explains each suite and its environment variables.

## Feature status

What the code does today, claim by claim, against the idea submission.

| Feature | Status | Notes |
| --- | --- | --- |
| One WebExtension for Chrome (MV3) and Firefox | Implemented | Tested in Brave (Chromium 154) and in headless Firefox 157 as a temporary add-on. Google Chrome and Edge themselves were not tested. |
| Screenshot with `chrome.tabs.captureVisibleTab()`; the raw image never leaves the browser | Implemented | The privacy test checks the exact bytes sent. |
| DOM pass: input types, `autocomplete` tokens (`cc-number`, `one-time-code`, `tel`, `email`, …), visible text with on-screen boxes | Implemented | Text drawn by CSS `::before`/`::after` is not read. |
| Validators: Aadhaar (Verhoeff), cards (Luhn), PAN, phone, UPI, IFSC; a regex match alone never masks | Implemented | Unit-tested against published vectors. |
| MutationObserver for dynamic forms, pop-ups, SPA updates | Implemented | Pages that keep changing are withheld, not guessed. |
| Florence-2 (ONNX, Transformers.js) on WebGPU with WASM fallback, in a Web Worker, only on image, canvas and PDF regions | Implemented | WebGPU in Brave; WASM in our Firefox run. |
| On-device NER for names in free text | Planned | Name *fields* are masked; names in free page text and in the task are not. |
| Canvas masking: black box for passwords, cards and IDs; solid mask (not blur) for faces and profile photos; look-alike values for what the agent must use | Implemented | |
| Fail-closed: unscanned or uncertain regions masked, or the frame withheld | Implemented | Florence-2 gives no calibrated confidence; uncertainty is handled by rules (see Privacy guarantees). |
| Redaction manifest `{type, method, source, bbox}` with every frame | Implemented | Schema-checked by the extension and the server. |
| Task text and action history masked with placeholders | Implemented | Same limits as the DOM pass (no names in free text). |
| Action gate: no typing into password/OTP fields, no off-site navigation, user click before submit or pay | Implemented | |
| Placeholder vault: memory only, real values only into their source field, cleared on tab close | Implemented | Cleared whenever the task ends (done, Stop, a new task, tab closed); kept while a task is paused. |
| Actions through `chrome.scripting.executeScript()`, looping until done | Implemented | |
| Flask REST/JSON server for Gemma 4 31B-it (quantized) via vLLM or Ollama | Partial | Server implemented and tested with a mock model. Not yet run against Gemma 4 here (no GPU large enough on the test machine). |
| One JSON action per step: `{"action": "click\|type\|scroll\|wait\|done", "target", "coordinates"}` | Implemented | The server validates the reply into exactly one action (plus `ref`, `value`, `thought`). |
| The server is never asked to guess masked content | Implemented | System prompt rule; the model only ever sees masks and look-alikes. |

## Measured results

Measured on 2026-10-02 with `bench/bench.mjs`: a laptop with an Intel Core i5-10300H, 7.9 GiB RAM and an NVIDIA GeForce GTX 1650 (4 GB), Windows 11, Brave 1.96 (Chromium 154), headless. Each run was 10 agent steps on WebGPU (two runs) or 3 steps on the WASM fallback, against the real server and a **mock** model. Raw output is in [`bench/results/`](bench/results/); method and every stage are in [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

| Measure | WebGPU | WASM fallback |
| --- | --- | --- |
| Florence-2 vision pass per step (median) | 2.73 s and 2.83 s (two runs) | 93.5 s |
| DOM scan per step (median) | 3–4 ms | 4 ms |
| Screenshot (median) | 64–73 ms | 73 ms |
| Masking + JPEG (median) | 29–31 ms | 24 ms |
| Whole step on the device and server, mock model (median) | 3.14 s and 3.25 s | 93.9 s |
| Model load from the browser cache | 12.4 s and 17.6 s | 10.4 s |
| Model download (first run, once) | 343.0 MiB | + 227.8 MiB |
| Peak memory of the web page's tab | 25.1–25.9 MiB | 24.9 MiB |
| Peak memory of the extension (side panel + model host) | 1004.4–1070.4 MiB | 1320.1 MiB |
| Peak memory of the browser's GPU process | 1565.1–1571.8 MiB | 31.8 MiB |
| Gemma 4 time per step | not yet measured | not yet measured |
| PII detection recall / precision on a labelled set | not yet measured | not yet measured |

Test results on the same machine: 98 unit tests and 39 server tests pass; the privacy test and the race test pass in Brave. The smoke tests were run from a scratch harness outside the repository: Brave passed 28/28 and headless Firefox 157 passed 36/36, with vision on WASM there.

## Privacy guarantees

What the code enforces, and what checks it:

- **Pixels.** Only the masked JPEG leaves the browser. The raw screenshot goes from the side panel to the offscreen document by in-browser messaging and nowhere else. *Checked by:* the privacy test, which captures the exact request bytes.
- **Text.** Page text and field values never leave the device. The manifest carries only types, methods, sources, boxes and look-alike values, and both sides reject any other key. Element names, the task and the action history go through the same vault. *Checked by:* the privacy test (11 PII strings searched in every request, extension → server and server → model), unit tests of the manifest schema.
- **Placeholders.** A look-alike typed by the model becomes the real value only in the field it was read from, or in a field whose purpose matches its type. Everywhere else the action is refused. The vault lives in memory only and is cleared when the task ends. *Checked by:* unit tests of the vault, the Brave and Firefox smoke tests.
- **Actions.** No typing into password, OTP or CVV fields; no navigation or form submission off the start site; your click before any submit or payment. *Checked by:* unit tests of the gate, smoke tests.
- **Fail-closed.** The frame is withheld when:
  - the DOM pass cannot run;
  - the page changes between the scan and the screenshot;
  - vision is needed but not ready, fails, or returns a face or text without a position;
  - the tab changes during capture;
  - the manifest fails its schema.

  Text inside frames and embedded PDFs, which the DOM pass cannot read, is blacked out line by line, and whole media areas are blacked out when OCR output was cut off. *Checked by:* the race harness (live feed, script-driven ticker, CSS animation, dense frame), the privacy test.
- **Server.** It listens on 127.0.0.1 with the debugger off. It sends no CORS headers, so web pages cannot read its answers. Its config endpoint answers only local requests and never returns the API key. Every request and every model reply is validated. *Checked by:* 39 server unit tests.

## Known limitations

- **Names in free text** are not detected yet (on-device NER is planned). Name fields are masked.
- **OCR misses:** text that Florence-2 OCR does not read inside an image or frame is not masked. Small text in a large image is the usual case.
- **Not read by the DOM pass:** text drawn with CSS `::before`/`::after`.
- **Pages that change faster than every 100 ms** (live feeds, script-driven tickers) are withheld on every step, so the agent stops on them.
- **Script navigations:** a page script can navigate without a link; the gate cannot see that in advance, so the task pauses when the tab has left the site.
- **Not yet measured:** detection recall and precision on a labelled set, a full step with Gemma 4, and Chrome/Edge (only Brave was tested).
- **Firefox speed:** our Firefox run used the WASM fallback, which is far slower than WebGPU.

## Repository layout

| Path | What |
| --- | --- |
| `extension/` | the WebExtension: side panel orchestrator, content script, validators, action gate, vault, offscreen canvas masking, Florence-2 worker bundle |
| `client-vision/` | source of the vision worker (`worker.js`, `ocr-pii.js`) and a standalone test page |
| `server/` | Flask server, default config, dashboard, unit tests |
| `tests/` | unit tests and the privacy end-to-end test |
| `bench/` | benchmark script, fixture page and raw results |
| `docs/` | architecture, server API, benchmarks, evaluation mapping |

## License

Developed for Smart India Hackathon 2026 under the MIT License.
