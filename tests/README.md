# Privag AI tests

Unit tests for the extension's on-device privacy rules. They use Node's built-in test runner (`node:test`) and
need no dependencies, so there is nothing to install.

## Run

From this folder:

```sh
npm run test:unit
```

Or from the repository root:

```sh
node --test "tests/unit/*.test.mjs"
```

Keep the quotes: Node expands the pattern itself. Passing the folder alone (`node --test tests/unit`) does not
work, because the test runner treats a bare path as a file. Checked with Node 24.18.0.

## What is covered

| File | Module | Rules it pins down |
| --- | --- | --- |
| `unit/validators.test.mjs` | `extension/validators.js` | Verhoeff and Luhn against published vectors; Aadhaar, card, PAN, phone, UPI, IFSC and labelled-OTP checks; `find()` reports only validated, whole-token, non-overlapping spans (a regex match alone never masks). |
| `unit/action-gate.test.mjs` | `extension/action-gate.js` | No typing into password/OTP/CVV fields, no off-site navigation, a user click before submit or pay, fail closed when the start URL is unknown. |
| `unit/redaction-manifest.test.mjs` | `extension/redaction-manifest.js` | The manifest sent with each frame only carries allow-listed keys, valid methods and sources, and well-formed boxes. |
| `unit/pii-masker.test.mjs` | `extension/pii-masker.js` | Consistent, format-preserving, clearly synthetic fakes; outgoing text masking; a fake is turned back into the real value only in the field it came from or a field of the same type. |
| `unit/ocr-pii.test.mjs` | `client-vision/ocr-pii.js` | An OCR line is masked when a validator accepts a value in it, or when a PII label sits next to a value OCR may have garbled; bare labels stay readable; overlapping face boxes merge. |

Every test name says why the rule matters, so a failing test reads as the business rule that broke.

## How the modules are loaded

The extension files are classic scripts that set a global (`globalThis.PrivagValidators`, `PrivagGate`,
`PrivagRedactionManifest`, `PIIMasker`) and also export it when `module.exports` exists. The tests load them with
`createRequire` from `node:module`. `pii-masker.js` reads `globalThis.PrivagValidators`, so its test loads
`validators.js` first. Each test file runs in its own process, so globals do not leak between files.

## Privacy end-to-end test (`privacy/privacy.test.mjs`)

The core promise: no raw PII leaves the device. The test opens `privacy/fixture/index.html` (synthetic Aadhaar,
PAN, card, mobile, email, OTP, UPI, IFSC and a face photo) in a real Chromium-based browser with the unpacked
extension, runs an agent task through the real Flask server (backed by a local mock LLM that clicks "Next", asks
which PAN to enter, types the PAN from the user's answer into the page's empty PAN field and then answers "done"),
and records the exact bytes of every request:

- extension -> server, through a recording proxy in front of Flask, and
- server -> LLM, as received by the mock.

The test answers the agent's question in the side panel's answer box, as the user would: `Use BNZPM2501F`, a PAN
that appears nowhere else.

It fails if any of the PII strings (also in their digits-only forms, and the PAN from the answer) appears in any
of them, if a manifest fails the schema, if an expected mask is missing (black boxes for Aadhaar, PAN, card and
OTP; look-alikes for phone, email, UPI and IFSC; a solid mask on the face found by the on-device vision model), if
the task text still holds the card number, or if a mask in the sent image is not solid. For the answer, it also
fails if the side panel does not show the question with the answer box, if the history sent after the answer does
not hold `The user answered: Use ` plus a placeholder PAN, if the page's PAN field does not end up holding the real
PAN (the vault resolved the placeholder the agent typed), or if the raw answer is still in the answer box after
the task. The captured requests, the sent image and the side panel's log are written to `privacy/out/`
(git-ignored).

```sh
cd tests
npm install            # puppeteer-core only: it drives an installed browser and downloads none
npm run test:privacy
```

| Variable | Meaning | Default |
| --- | --- | --- |
| `BROWSER` | Chrome, Chromium, Edge or Brave executable | common install paths |
| `PRIVAG_PYTHON` | Python with `server/requirements.txt` installed | `server/.venv`, then `python` |
| `PROFILE_DIR` | browser profile to use; reuse one so the Florence-2 weights are downloaded only once | a new temp folder |
| `MODEL_TIMEOUT_S` | how long to wait for the vision model to load | `1200` |

The first run on a fresh profile downloads the Florence-2 weights from Hugging Face.

## Race test (`privacy/race.test.mjs`)

Also run by `npm run test:privacy` (the two run one after the other). A scan's boxes are only valid for the pixels
of the same moment, so a frame whose page changed between the scan and the screenshot must be withheld. PII on its
test pages is drawn in pure magenta, and the test counts strongly magenta pixels left in every frame that is sent:

- a script-driven ticker that moves a phone number every animation frame: withheld (or sent with no magenta);
- a CSS slide-in toast with a phone number, sampled at six moments of its animation: sent, with no magenta
  (animations are paused for the capture);
- a feed adding a phone number every 30 ms: withheld (or sent with no magenta);
- an iframe with 40 lines of text the DOM pass cannot read: sent, with no magenta.

### Fixture provenance

All IDs on the fixture page and in the test's answer are synthetic values chosen to pass their checksums
(Verhoeff, Luhn) or structure checks; `4111 1111 1111 1111` is a published payment test card number and `example.com` is reserved for
documentation. `privacy/fixture/face.jpg` is a downscaled copy of
[File:Albert_Einstein_Head.jpg](https://commons.wikimedia.org/wiki/File:Albert_Einstein_Head.jpg) from Wikimedia
Commons, which is in the public domain (published in the United States between 1931 and 1963 without a renewed
copyright; author died in 1968).

## Benchmark (`../bench/bench.mjs`)

Not a test: it measures per-stage latency and peak memory over real agent steps and writes the raw results to
`bench/results/`. It takes the same `BROWSER`, `PRIVAG_PYTHON`, `PROFILE_DIR` and `MODEL_TIMEOUT_S` variables, plus
`STEPS`, `PHOTO` (`moving`, `still` or `none`: vision runs every step, once then from the cache, or never),
`BROWSER_ARGS` (`--disable-gpu` forces the WASM fallback), `LABEL` and `LLM_URL`/`LLM_MODEL`/`LLM_API_KEY` for a real
model. [`docs/BENCHMARKS.md`](../docs/BENCHMARKS.md) describes the method and every committed run.
