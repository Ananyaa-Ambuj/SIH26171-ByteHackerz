# Privag AI — Benchmarks

## Summary

| Measure | Result | Section |
| --- | --- | --- |
| Full step with Gemma 4 31B | **9.47 s** median (model 6.91 s, vision 2.04 s) | 5 |
| Step without vision work (mock model) | 453 ms (no media), 433 ms (unchanged media) | 1 |
| Vision pass on new images, WebGPU (GTX 1650) | 2.04–3.90 s median per run | 1, 3, 5 |
| Vision pass, CPU only | 29.0 s and 48.1 s on 4 WASM threads (93.5 s and 103.1 s on one) | 2 |
| Model download (once) | 343.0 MiB (+227.8 MiB for the CPU fallback) | 4 |
| Peak memory, vision on every step | extension 0.78–1.09 GiB, GPU process 1.49–1.57 GiB, page tab 25.6–46.5 MiB | 3, 5 |

Every figure comes from `bench/bench.mjs` (section 5 also `bench/eval.mjs`); raw output in [`bench/results/`](../bench/results/). What is not measured is listed at the end.

## How it is measured

`node bench/bench.mjs` starts the real Flask server, a **mock** model (canned replies) unless `LLM_URL` names a real one, and headless Brave with the extension. On `bench/fixture/index.html` (synthetic PII and a photo) the agent clicks "Next" every step; the side panel records each stage (`window.__privagSteps`):

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

- `PHOTO`: `moving` (default; the photo moves each step, so vision runs every step), `still` (vision once, then cached) or `none` (no media, vision skipped).
- **Step** = the sum of the stages, with the server round trip for network + vlm; it leaves out the 800 ms wait after each action. Times in ms: median (p90) over a run's steps.
- **Memory** = peak private bytes per process group, sampled every second. **Model download** = what the extension stored in Cache Storage.

## Test machine

Laptop: Intel Core i5-10300H (4 cores, 8 threads), 7.9 GiB RAM, NVIDIA GeForce GTX 1650 4 GB (driver 617.14, WebGPU adapter "nvidia / turing"), Windows 11 (build 26200), Brave 1.96 (Chromium 154.0.8037.93), headless. Florence-2: `onnx-community/Florence-2-base-ft`.

Sections 1–4 are from 2026-10-02, section 5 from 2026-10-05. Section 4 ran first; sections 1–3 ran hours later while the laptop was in normal use (65% CPU load in one sample), and are slower across the board (old-manifest vision 2876–3094 ms there, 2728 and 2825 ms in section 4). Compare runs within a section.

## Results

### 1. Conditional vision

What a step costs depending on what vision had to do (current code, mock model).

| Page (`PHOTO`) | Device | What vision did | Step: median (p90), steps |
| --- | --- | --- | --- |
| `none` | WebGPU | skipped on every step | **453** (519), 11 steps |
| `still` | WebGPU | ran on step 1, then reused the cached result | **433** (506), the 10 cached steps; step 1: 6003 |
| `moving` | WebGPU | ran on every step | **3395–4348**, medians of 5 runs of 11 steps |
| `moving` | WASM, 4 threads | ran on every step | **29356** and **48634**, medians of 2 runs of 4 steps |

Most of a skipped or cached step is the settle stage (290–308 ms). Step 1 of the `still` run includes the model's one-off warm-up.

### 2. CPU only: one WASM thread versus four

ONNX Runtime uses WASM threads only in a cross-origin isolated page; since `4bedb99` the manifest sets COEP `require-corp` and COOP `same-origin`. A probe confirmed the switch: one worker before, four threads after (`min(4, ceil(cores / 2))`). Runs forced onto WASM with `--disable-gpu`, in the order they ran:

| Run | Threads | vision | Step | Peak memory, extension processes | Model load from cache |
| --- | --- | --- | --- | --- | --- |
| `wasm` (section 4, hours earlier) | 1 | 93452 (96455) | 93877 | 1320.1 MiB | 10.4 s |
| `wasm-4threads` | 4 | **28970** (29089) | 29356 | 1304.7 MiB | 39.2 s |
| `wasm-1thread-control` (old manifest) | 1 | 103128 (105377) | 103565 | 1383.1 MiB | 30.6 s |
| `wasm-4threads-b` | 4 | **48107** (48306) | 48634 | 1302.3 MiB | 45.7 s |

Four threads were faster in both comparisons; by how much depends on other CPU load (the two 4-thread runs differ by 19 s).

### 3. WebGPU with and without cross-origin isolation

Alternating runs with the current and the previous manifest (`PHOTO=moving`, 10 steps), in the order they ran:

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

Isolated was slower in three pairs (by 838, 275 and 133 ms) and faster in one (by 73 ms): no gain on WebGPU, possibly a small cost within the noise. Memory shows no consistent difference.

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

### 5. With Gemma 4 31B

2026-10-05, current code. Model: Ollama `gemma4:31b` on a server on the local network (hardware not recorded). Client: the same laptop, Brave on Chromium 154.0.8037.98. Vision ran every step; the model clicked "Next" until the 15-step limit paused the task.

| Stage | Gemma 4 31B (15 steps) |
| --- | --- |
| settle | 309 (317) |
| dom | 4 (6) |
| capture | 39 (51) |
| vision | 2044 (2082) |
| mask | 17 (20) |
| network | 9 (12) |
| **vlm (Gemma 4 31B)** | **6908 (7689)** |
| execute | 2 (5) |
| **step** | **9467** (p90 10132, max 11275) |

Model load from the browser cache 20.8 s. Peak memory: the page's tab 25.6 MiB, extension processes 1087.2 MiB, GPU process 1494.6 MiB, all browser processes 2584.2 MiB.

In the task evaluation (same day, same model, 39 steps of six tasks) the model's reply took 9491 ms median (p90 22336, range 5581–28723). Task results: [`EVALUATION.md`](EVALUATION.md).

## Raw output

All in [`bench/results/`](../bench/results/), file names `<date>-gtx1650-brave-<label>.json`, made with `LABEL=gtx1650-brave-<label>` (2026-10-02 unless noted):

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
| `webgpu-gemma4-31b` (2026-10-05) | `STEPS=10 LLM_URL=<the server's Ollama URL> LLM_MODEL=gemma4:31b LLM_API_KEY=<key> node bench/bench.mjs` | 5 |
| `2026-10-05-eval-gemma4-31b.json` | `REPEATS=3 node bench/eval.mjs` (the server's own model settings) | 5, EVALUATION.md |

Each file holds every step's timings, every memory sample (per process) and the list of cached model files. The files from before the `PHOTO` option (`webgpu-run1`, `webgpu-run2`, `wasm`) have no `photo` or `stepSumMs` fields; their steps sum the same way.

## Not yet measured

- PII recall and precision on a labelled set (e.g. WebPII); a re-OCR check of masked frames.
- Gemma 4 through vLLM; the model server's hardware.
- How often real pages need vision at all (section 1 uses one fixture page); first-run download time.
- Chrome, Edge, other GPUs and operating systems; Firefox timings (our Firefox check was functional only).
