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

Every test name says why the rule matters, so a failing test reads as the business rule that broke.

## How the modules are loaded

The extension files are classic scripts that set a global (`globalThis.PrivagValidators`, `PrivagGate`,
`PrivagRedactionManifest`, `PIIMasker`) and also export it when `module.exports` exists. The tests load them with
`createRequire` from `node:module`. `pii-masker.js` reads `globalThis.PrivagValidators`, so its test loads
`validators.js` first. Each test file runs in its own process, so globals do not leak between files.
