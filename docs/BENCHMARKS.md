# Privag AI — Benchmarks

Every figure on this page comes from `bench/bench.mjs`; the raw output of each run is committed in [`bench/results/`](../bench/results/). Anything this script does not measure is listed at the end as **not yet measured**.

## How it is measured

`node bench/bench.mjs` (after `cd tests && npm install`) starts the real Flask server, a local **mock** OpenAI-compatible model (canned replies; Gemma 4 is not involved), and a headless Chromium-based browser with the unpacked extension. It opens `bench/fixture/index.html` (synthetic PII and a photo), starts a task that clicks "Next" on every step, and records the times the side panel measures itself for every step (`window.__privagSteps`):

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

`PHOTO` picks what the fixture page shows:
- `moving` (default): each "Next" click moves the photo by one pixel, so the frame changes and the vision pass really runs on every step.
- `still`: the photo stays put, so vision runs once and later steps reuse the cached result.
- `none`: no photo, so no media is on screen and vision is skipped.

"Step" below is the sum of the stages, with the server round trip in place of network + vlm (`stepSumMs` in the raw output, grouped by what the vision pass did). It leaves out the 800 ms the loop waits after each action for the page to settle, and it uses a mock model, so it is **not** the time of a step with Gemma 4. Times are in milliseconds: median (p90) over the steps of a run, as `bench.mjs` computes them (for an even number of steps the median is the upper of the two middle values). A run of N steps has N + 1 sanitized frames, because the step that answers `done` is sanitized too.

Memory: private bytes of every browser process, sampled about once a second during the agent run and grouped by process type; the tables show each group's peak. "Model download" is the size of the files the extension stored in its Cache Storage after loading the model.

## Test machine

Laptop: Intel Core i5-10300H (4 cores, 8 threads), 7.9 GiB RAM, NVIDIA GeForce GTX 1650 4 GB (driver 617.14, WebGPU adapter "nvidia / turing"), Windows 11 (build 26200), Brave 1.96 (Chromium 154.0.8037.93), headless. Florence-2: `onnx-community/Florence-2-base-ft`.

All runs are from 2026-10-02. The runs in section 4 were made first. Sections 1–3 were made hours later, while the laptop was in normal use (Brave and other apps running; one sample showed 65% CPU load). The later runs are slower across the board, the old manifest included: section 3's runs without isolation had vision medians of 2876–3094 ms, against 2728 and 2825 ms in section 4. Compare runs within a section, not across sections.

## Results

### 1. Conditional vision

What a step costs depending on what the vision pass had to do. Cross-origin isolated build (the current code); the WebGPU model was loaded in every run, but only the `moving` runs make it work on every step.

| Page (`PHOTO`) | Device | What vision did | Step: median (p90), steps |
| --- | --- | --- | --- |
| `none` | WebGPU | skipped on every step | **453** (519), 11 steps |
| `still` | WebGPU | ran on step 1, then reused the cached result | **433** (506), the 10 cached steps; step 1: 6003 |
| `moving` | WebGPU | ran on every step | **3395–4348**, medians of 5 runs of 11 steps |
| `moving` | WASM, 4 threads | ran on every step | **29356** and **48634**, medians of 2 runs of 4 steps |

Most of a skipped or cached step is the settle stage (290–308 ms median), the wait for a still DOM. Step 1 of the `still` run was the first inference after the model loaded, so it includes one-off warm-up.

### 2. CPU only: one WASM thread versus four

ONNX Runtime uses WASM threads only when the page is cross-origin isolated. Since commit `4bedb99` the manifest sets `cross_origin_embedder_policy: require-corp` and `cross_origin_opener_policy: same-origin`. A probe in headless Brave showed `crossOriginIsolated` false with the old manifest (one worker) and true with the new one: ONNX Runtime then started 3 thread workers next to the Florence worker, 4 threads in all (`min(4, ceil(logical cores / 2))` on this 8-thread CPU). All four runs below used `BROWSER_ARGS=--disable-gpu`, which forces the WASM fallback; listed in the order they ran.

| Run | Threads | vision | Step | Peak memory, extension processes | Model load from cache |
| --- | --- | --- | --- | --- | --- |
| `wasm` (section 4, hours earlier) | 1 | 93452 (96455) | 93877 | 1320.1 MiB | 10.4 s |
| `wasm-4threads` | 4 | **28970** (29089) | 29356 | 1304.7 MiB | 39.2 s |
| `wasm-1thread-control` (old manifest) | 1 | 103128 (105377) | 103565 | 1383.1 MiB | 30.6 s |
| `wasm-4threads-b` | 4 | **48107** (48306) | 48634 | 1302.3 MiB | 45.7 s |

Four threads were faster in both comparisons. How much faster depends on how much else the CPU is doing: the two 4-thread runs differ by 19 s.

### 3. WebGPU with and without cross-origin isolation

The isolation could also affect the WebGPU path, so the same benchmark (`PHOTO=moving`, 10 steps) was run alternately with the current manifest and with the previous one. Listed in the order they ran:

| Run | Isolated | vision | Step | Peak memory, extension / GPU process |
| --- | --- | --- | --- | --- |
| `webgpu-run3` | yes | 3486 (5708) | 4057 | 1056.6 / 1549.4 MiB |
| `webgpu-isolated-a` | yes | 3899 (4060) | 4348 | 806.5 / 1537.1 MiB |
| `webgpu-not-isolated-a` | no | 3061 (3406) | 3520 | 1065.4 / 1542.9 MiB |
| `webgpu-isolated-b` | yes | 2957 (3389) | 3395 | 1044.0 / 1540.2 MiB |
| `webgpu-not-isolated-b` | no | 3030 (3244) | 3465 | 1069.9 / 1554.5 MiB |
| `webgpu-not-isolated-c` | no | 3094 (3928) | 3566 | 1179.4 / 1564.4 MiB |
| `webgpu-isolated-c` | yes | 3369 (3546) | 3846 | 775.6 / 1564.3 MiB |
| `webgpu-not-isolated-d` | no | 2876 (3139) | 3326 | 758.8 / 1562.0 MiB |
| `webgpu-isolated-d` | yes | 3009 (3276) | 3467 | 1011.6 / 1568.0 MiB |

In the four alternating pairs (a–d) the isolated build's vision median was slower in three (by 838, 275 and 133 ms) and faster in one (by 73 ms). No gain on WebGPU, then, and possibly a small cost, within the run-to-run noise of this machine. Memory shows no consistent difference.

### 4. Earlier runs (before the threading change)

`PHOTO=moving`, old manifest (WASM on one thread).

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
| **step** | **3251** (max 5864) | **3139** (max 3694) | **93877** (max 96981) |

| Resource | WebGPU, run 1 | WebGPU, run 2 | WASM fallback |
| --- | --- | --- | --- |
| Model load from the browser cache (side panel opened → model ready) | 17.6 s | 12.4 s | 10.4 s |
| Peak memory, the web page's tab (renderer) | 25.1 MiB | 25.9 MiB | 24.9 MiB |
| Peak memory, extension processes (side panel + offscreen document hosting the model) | 1070.4 MiB | 1004.4 MiB | 1320.1 MiB |
| Peak memory, GPU process | 1565.1 MiB | 1571.8 MiB | 31.8 MiB |
| Peak memory, all browser processes | 2723.7 MiB | 2661.3 MiB | 1682.6 MiB |

Model files in the extension's cache: **343.0 MiB** for the WebGPU set (`vision_encoder_fp16` 175.4, `embed_tokens_fp16` 75.1, `decoder_model_merged_q4` 61.4, `encoder_model_q4` 28.7, tokenizer and configs 2.4). The WASM fallback downloads another **227.8 MiB** (`embed_tokens_q4` 150.3, `vision_encoder_q4` 77.5).

## Raw output

All in [`bench/results/`](../bench/results/), file names `2026-10-02-gtx1650-brave-<label>.json`, made with `LABEL=gtx1650-brave-<label>`:

| Label | Command (besides `LABEL`) | Section |
| --- | --- | --- |
| `webgpu-run1`, `webgpu-run2` | `STEPS=10 node bench/bench.mjs` | 4 |
| `wasm` | `STEPS=3 BROWSER_ARGS=--disable-gpu node bench/bench.mjs` | 2, 4 |
| `wasm-4threads`, `wasm-4threads-b` | `STEPS=3 BROWSER_ARGS=--disable-gpu node bench/bench.mjs` | 1, 2 |
| `wasm-1thread-control` | the same, with the previous `extension/manifest.json` | 2 |
| `webgpu-run3`, `webgpu-isolated-a` … `-d` | `STEPS=10 node bench/bench.mjs` | 1, 3 |
| `webgpu-not-isolated-a` … `-d` | the same, with the previous `extension/manifest.json` | 3 |
| `webgpu-photo-still` | `STEPS=10 PHOTO=still node bench/bench.mjs` | 1 |
| `webgpu-photo-none` | `STEPS=10 PHOTO=none node bench/bench.mjs` | 1 |

Each file holds every step's timings, every memory sample (per process) and the list of cached model files. The files from before the `PHOTO` option (`webgpu-run1`, `webgpu-run2`, `wasm`) have no `photo` or `stepSumMs` fields; their steps sum the same way.

## Not yet measured

- A full step with **Gemma 4** (the server's model call was a mock in every run above).
- **PII detection recall and precision** on a labelled data set (for example WebPII).
- **Re-OCR check** of our own masked frames ("no PII readable after masking").
- First-run model **download time** (depends on the network).
- How often real pages need the vision pass at all (the conditional-vision figures above are from one fixture page).
- Google Chrome, Microsoft Edge, other GPUs and operating systems; **Firefox** timings (our Firefox check was a functional test, not a benchmark, and ran before the threading change; Firefox does not support the manifest keys behind it).
