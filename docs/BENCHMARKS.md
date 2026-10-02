# Privag AI — Benchmarks

Every figure on this page comes from `bench/bench.mjs`; the raw output of each run is committed in [`bench/results/`](../bench/results/). Anything this script does not measure is listed at the end as **not yet measured**.

## How it is measured

`node bench/bench.mjs` (after `cd tests && npm install`) starts the real Flask server, a local **mock** OpenAI-compatible model (canned replies; Gemma 4 is not involved), and a headless Chromium-based browser with the unpacked extension. It opens `bench/fixture/index.html` (synthetic PII and a photo; each click on "Next" moves the photo by one pixel, so the vision pass really runs on every step), starts a task and records, for every step, the times the side panel measures itself (`window.__privagSteps`):

| Stage | What it covers |
| --- | --- |
| settle | pausing animations and waiting until the page's DOM is still |
| dom | the DOM scan (Pass 1), including the `executeScript` round trip |
| capture | `chrome.tabs.captureVisibleTab()` |
| vision | Florence-2 `<OD>` + `<OCR_WITH_REGION>` on the media crop (Pass 2), as timed inside the worker |
| mask | canvas masking, Set-of-Marks and JPEG encoding (Pass 3) |
| network | the server round trip minus the time the server waited for the model |
| vlm | the time the server waited for the model (here: the mock) |
| execute | the local gate plus the action in the page |

Memory: private bytes of every browser process, sampled about once a second during the agent run and grouped by process type; the table shows each group's peak. "Model download" is the size of the files the extension stored in its Cache Storage after loading the model.

## Test machine

Laptop, measured on 2026-10-02: Intel Core i5-10300H (4 cores, 8 threads), 7.9 GiB RAM, NVIDIA GeForce GTX 1650 4 GB (driver 617.14, WebGPU adapter "nvidia / turing"), Windows 11 (build 26200), Brave 1.96 (Chromium 154.0.8037.93), headless. Florence-2: `onnx-community/Florence-2-base-ft`.

## Results

Times in milliseconds, median (p90) over all steps of a run, as `bench.mjs` computes them (for an even number of steps the median is the upper of the two middle values). A run of N steps has N + 1 vision passes (the step that answers `done` is sanitized too). Each "Next" click changes the frame, so vision ran on every step; none came from the cache.

| Stage | WebGPU, run 1 (11 steps) | WebGPU, run 2 (11 steps) | WASM fallback (4 steps) |
| --- | --- | --- | --- |
| settle | 312 (319) | 293 (321) | 321 (322) |
| dom | 4 (6) | 3 (4) | 4 (20) |
| capture | 73 (99) | 64 (88) | 73 (100) |
| **vision** | **2825 (3096)** | **2728 (2850)** | **93452 (96455)** |
| mask | 31 (51) | 29 (37) | 24 (48) |
| network | 12 (14) | 12 (14) | 15 (16) |
| vlm (mock) | 5 (12) | 5 (8) | 7 (13) |
| execute | 2 (14) | 3 (12) | 5 (11) |
| **sum per step** | **3251** (max 5864) | **3139** (max 3694) | **93877** (max 96981) |

"Sum per step" adds the stages above, with the server round trip in place of network + vlm. It leaves out the 800 ms the loop waits after each action for the page to settle, and it uses a mock model, so it is **not** the time of a step with Gemma 4.

| Resource | WebGPU, run 1 | WebGPU, run 2 | WASM fallback |
| --- | --- | --- | --- |
| Model load from the browser cache (side panel opened → model ready) | 17.6 s | 12.4 s | 10.4 s |
| Peak memory, the web page's tab (renderer) | 25.1 MiB | 25.9 MiB | 24.9 MiB |
| Peak memory, extension processes (side panel + offscreen document hosting the model) | 1070.4 MiB | 1004.4 MiB | 1320.1 MiB |
| Peak memory, GPU process | 1565.1 MiB | 1571.8 MiB | 31.8 MiB |
| Peak memory, all browser processes | 2723.7 MiB | 2661.3 MiB | 1682.6 MiB |

Model files in the extension's cache: **343.0 MiB** for the WebGPU set (`vision_encoder_fp16` 175.4, `embed_tokens_fp16` 75.1, `decoder_model_merged_q4` 61.4, `encoder_model_q4` 28.7, tokenizer and configs 2.4). The WASM fallback downloads another **227.8 MiB** (`embed_tokens_q4` 150.3, `vision_encoder_q4` 77.5).

Raw output:
- [`2026-10-02-gtx1650-brave-webgpu-run1.json`](../bench/results/2026-10-02-gtx1650-brave-webgpu-run1.json): `STEPS=10 node bench/bench.mjs`
- [`2026-10-02-gtx1650-brave-webgpu-run2.json`](../bench/results/2026-10-02-gtx1650-brave-webgpu-run2.json): the same, run again
- [`2026-10-02-gtx1650-brave-wasm.json`](../bench/results/2026-10-02-gtx1650-brave-wasm.json): `STEPS=3 BROWSER_ARGS=--disable-gpu node bench/bench.mjs` (no GPU, so the worker falls back to WASM)

Each file holds every step's timings, every memory sample (per process) and the list of cached model files.

## Not yet measured

- A full step with **Gemma 4** (the server's model call was a mock in every run above).
- **PII detection recall and precision** on a labelled data set (for example WebPII).
- **Re-OCR check** of our own masked frames ("no PII readable after masking").
- First-run model **download time** (depends on the network).
- Google Chrome, Microsoft Edge, other GPUs and operating systems; **Firefox** timings (our Firefox check was a functional test, not a benchmark).
