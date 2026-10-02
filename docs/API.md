# Privag AI — Server Integration & API Contract Specification

**Base URL:** `http://localhost:5000` (default; see [Running the server](#0-running-the-server))
**Transport:** HTTP/1.1 REST
**Data Format:** `application/json` (requests and every response, errors included)
**CORS Policy:** none. The server sends no `Access-Control-*` headers. The extension's side panel is an extension page with host permissions, which Chromium exempts from CORS; a web page in another origin cannot read any response.

The server is a thin, validating proxy: it checks what the extension sends, forwards the sanitized frame, manifest, task and history to an OpenAI-compatible chat-completions endpoint, and checks the model's reply before returning exactly one action. It never sees raw screenshots or real PII values; the extension masks them on the device first.

---

## 0. Running the server

```powershell
cd server
uv venv .venv
uv pip install --python .venv/Scripts/python.exe -r requirements.txt   # flask 3.1.3, werkzeug 3.1.9, requests 2.34.2 (pinned)
.venv/Scripts/python.exe app.py                                        # Linux/macOS: .venv/bin/python app.py
```

It prints `Privag AI server listening on http://127.0.0.1:5000`. The dashboard is at `http://localhost:5000/` on the same machine.

### LLM backend

Any OpenAI-compatible chat-completions endpoint that accepts image input. The default (`server/config.default.json`) is a local Ollama with Gemma 4 31B-it, Q4_K_M:

| Backend | `llm_url` | `llm_model` |
| :--- | :--- | :--- |
| Ollama (default) | `http://localhost:11434/v1` | `gemma4:31b-it-q4_K_M` (`ollama pull gemma4:31b-it-q4_K_M`) |
| vLLM | `http://localhost:8000/v1` (vLLM's default port) | `google/gemma-4-31B-it` |

Model latency with Gemma 4 31B-it: not yet measured.

### Configuration

The effective config is built per request, in this order (later wins):

1. `server/config.default.json` (tracked, no secrets): `llm_url`, `llm_api_key` (empty), `llm_model`, `llm_timeout` (seconds, default 600), `system_prompt`.
2. `server/config.json` (gitignored): what the dashboard saves. Only the keys that differ from the defaults are stored. A missing file means no overrides; a corrupt file, unknown key or wrongly typed value is skipped with a warning on stderr.
3. Environment variables (an empty variable counts as unset; an invalid value is ignored with a warning):

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `PRIVAG_LLM_URL` | from config | `http://` or `https://` base URL of the endpoint (`/chat/completions` is appended unless present). |
| `PRIVAG_LLM_MODEL` | from config | Model name as the endpoint knows it. |
| `PRIVAG_LLM_API_KEY` | from config (empty) | Sent as `Authorization: Bearer <key>`. Printable ASCII, no spaces. |
| `PRIVAG_LLM_TIMEOUT` | from config (600) | Seconds to wait for one model reply, 1 to 3600. |
| `PRIVAG_HOST` | `127.0.0.1` | Interface to listen on. `0.0.0.0` makes `/api` reachable from other machines; the dashboard and `/api/config` still answer only to this machine. |
| `PRIVAG_PORT` | `5000` | Port to listen on. Set the same URL in the extension's side panel. |
| `PRIVAG_DEBUG` | off | `1` turns on the Werkzeug debugger (tracebacks with source, interactive console). Development only. |

The server reads only the process environment; it does not load `.env` files (`server/.env.example` documents every variable). Settings never live in `server/static/`, which Flask serves publicly.

---

## 1. Primary Inference Endpoint: `POST /api` (Alias: `POST /api/step`)

Receives one sanitized step from the extension, asks the configured model for the next action, validates the reply, and returns exactly one action.

### Request

This is the request the extension sends (`extension/sidepanel.js`, `runAgentStep`):

```javascript
const response = await fetch(`${serverUrl}/api`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ image: redactedUrl, task: masker.maskText(task.goal, 'task'), history: actionHistory.slice(-50), manifest }),
  signal: serverRequest.signal
});
```

Example body (values are illustrative):

```json
{
  "image": "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
  "task": "Enter my PAN ZZZZZ0001Z and my email user_0001@example.com, then submit",
  "history": [
    "{\"thought\":\"Fill the email field first\",\"action\":\"type\",\"ref\":\"e2\",\"target\":\"Email\",\"value\":\"user_0001@example.com\",\"result\":\"Typed into target\"}"
  ],
  "manifest": {
    "redacted_regions": [
      { "type": "email", "method": "semantic_mock", "source": "dom_field", "value": "user_0001@example.com",
        "bbox": { "x": 210, "y": 120, "w": 240, "h": 28 } },
      { "type": "pan", "method": "black_box", "source": "dom_field", "value": "ZZZZZ0001Z",
        "bbox": { "x": 210, "y": 180, "w": 120, "h": 28 } },
      { "type": "password", "method": "black_box", "source": "dom_field",
        "bbox": { "x": 210, "y": 240, "w": 120, "h": 28 } },
      { "type": "face", "method": "solid_mask", "source": "florence_od",
        "bbox": { "x": 595, "y": 133, "w": 105, "h": 148 } }
    ],
    "screenshot_dimensions": { "width": 1580, "height": 1014 },
    "dom_structure": {
      "elements": [
        { "ref": "e2", "role": "textbox", "name": "Email", "filled": true, "redacted": true, "bbox": { "x": 210, "y": 120, "w": 240, "h": 28 } },
        { "ref": "e3", "role": "textbox", "name": "PAN", "filled": false, "redacted": true, "bbox": { "x": 210, "y": 180, "w": 120, "h": 28 } },
        { "ref": "e5", "role": "button", "name": "Submit", "bbox": { "x": 210, "y": 300, "w": 90, "h": 32 } }
      ]
    }
  }
}
```

Every personal value in the request is masked or a synthetic look-alike: the image, element names, the task (the user typed their real values; the extension sent look-alikes) and the history. The extension restores real values locally, only into the field they belong to.

| Field | Type | Required | Rules |
| :--- | :---: | :---: | :--- |
| `task` | `string` | **Yes** | Non-empty (not just whitespace), at most 4000 characters. |
| `image` | `string` | **Yes** | Starts with `data:image/png;base64,` or `data:image/jpeg;base64,`, followed by non-empty base64. |
| `history` | `string[]` | No (default `[]`) | At most 50 entries, each a string of at most 4000 characters (the extension sends each earlier action plus its `result`, serialized). |
| `manifest` | `object` | **Yes** | Must pass the redaction manifest schema below. |

The body must be a JSON object (`Content-Type: application/json`) of at most 16 MiB. Any other top-level key is ignored and never forwarded.

### Redaction manifest schema

The server applies the same rules as `extension/redaction-manifest.js`, which the side panel checks before sending (fail closed). Keys are allow-listed, so no extra field (OCR text, a field value) can ride along.

| Where | Rule |
| :--- | :--- |
| top level | Only `redacted_regions`, `screenshot_dimensions`, `dom_structure`. |
| `redacted_regions` | Array of objects with only `type`, `method`, `source`, `bbox`, `value`. |
| `type` | Non-empty string, at most 40 characters. |
| `method` | `black_box` \| `solid_mask` \| `semantic_mock`. |
| `source` | `dom_text` \| `dom_field` \| `dom_media` \| `florence_od` \| `florence_ocr`. |
| `value` | Optional string of at most 200 characters; **required** for `semantic_mock` (the look-alike shown); **not allowed** for `solid_mask`. On a `black_box` it is a placeholder the model may type. |
| `bbox` (regions and elements) | `{x, y, w, h}` finite numbers with `x, y >= 0` and `w, h > 0`, in screenshot pixels. |
| `screenshot_dimensions` | `{width, height}` positive integers. |
| `dom_structure.elements` | Array of objects with only `ref`, `role`, `name`, `bbox`, `filled`, `redacted`, `disabled`. |
| `ref` | Matches `e` followed by ASCII digits (`e1`, `e27`). |
| `role` / `name` | Strings of at most 40 / 80 characters (counted in UTF-16 code units, as JavaScript does). |
| `filled`, `redacted`, `disabled` | Optional booleans. |

A failing manifest gets `400 {"error": "Invalid manifest", "details": [...]}` with up to 20 problems, worded as in the extension.

### What the server sends to the model

One chat-completions request: `model`, a `system` message with the configured system prompt, and one `user` message with four parts in this order: `Previous Actions History` (numbered lines, or `None`), `Current Redaction Manifest` (the manifest as JSON), the image as an `image_url` part, and `User Task: <task>`. If an API key is configured it goes in `Authorization: Bearer <key>`.

### Response `200 OK`

```jsonc
{
  "action": {
    "thought": "The PAN field is empty; fill it with the placeholder from the manifest",
    "action": "type",
    "ref": "e3",
    "target": "PAN",
    "value": "ZZZZZ0001Z"
  },
  "raw_response": "```json\n{\"thought\": \"The PAN field is empty; ...\", \"action\": \"type\", \"ref\": \"e3\", ...}\n```",
  "timing": { "vlm_ms": 0 }   // placeholder: measured for every request; real Gemma 4 latency is not yet measured
}
```

| Field | Type | Description |
| :--- | :---: | :--- |
| `action.action` | `string` | Always one of `click`, `type`, `scroll`, `wait`, `done` (lowercase). The extension's agent loop runs until `done`. |
| `action.thought` | `string` | The model's brief reasoning (at most 1000 characters). Optional. |
| `action.ref` | `string` | Target element ref from `dom_structure.elements`, normalised to `e<number>`. Optional. |
| `action.target` | `string` | Human-readable label of the target (at most 200 characters). Optional. |
| `action.coordinates` | `[number, number]` | Fallback for targets without a ref: `[x, y]` in screenshot pixels. Optional. |
| `action.value` | `string` | Text to type (or the dropdown option to pick) for `type`, at most 1000 characters; `up` or `down` for `scroll`. |
| `raw_response` | `string` | The model's reply text, verbatim. |
| `timing.vlm_ms` | `integer` | Milliseconds measured around the request to the LLM. |
| `invalid_reason` | `string` | Present only when the reply was not a usable action (see below). |

**How the reply becomes one action.** The reply is parsed as JSON; if that fails, the first `{...}` object inside it is used (strings and nesting are respected, so prose or a code fence around the JSON is fine, and of two objects the first wins). A JSON list gives its first object. Then:

- `action` is trimmed and lowercased and must be `click`, `type`, `scroll`, `wait` or `done`.
- `ref` is accepted as `"e7"`, `"[e7]"`, `"E7"` or `7` and returned as `"e7"`; an unparseable ref is dropped. A ref written only in `target` (e.g. `"[e12]"`) is also accepted, as the extension does.
- `coordinates` are kept only as a list of two finite numbers `>= 0`.
- `click` and `type` need a `ref` or `coordinates`; `type` needs a string `value`; `scroll` gets `value` `up` or `down` (anything else becomes `down`).
- Every other key is dropped, so the model cannot add fields (such as `"confirmed": true`) to what the extension runs.

If the reply is empty, not JSON, or not a usable action, the response is still `200`, with a placeholder action and the reason:

```json
{
  "action": { "action": "wait", "target": "Model reply was not a valid action" },
  "raw_response": "{\"action\": \"navigate\", \"target\": \"https://example.com\"}",
  "timing": { "vlm_ms": 0 },
  "invalid_reason": "unknown action 'navigate'; expected one of click, type, scroll, wait, done"
}
```

### Errors

All errors are JSON objects with an `error` string; no HTML error page and no traceback is ever returned.

| Status | When | Body |
| :--- | :--- | :--- |
| `400` | Body not a JSON object (including numbers too large for a double and JSON nested too deeply to parse), or a field breaks the rules above | `{"error": "..."}`; for the manifest also `"details": [...]` |
| `405` | Wrong method (e.g. `GET /api`) | `{"error": "405 Method Not Allowed"}` |
| `413` | Body larger than 16 MiB | `{"error": "Request body is larger than 16 MiB"}` |
| `500` | Unexpected server error (traceback only in the server log) | `{"error": "Internal server error"}` |
| `502` | The LLM gave no usable answer: unreachable, timeout, HTTP error, non-JSON or not a chat completion | `{"error": "LLM request failed: <short reason>"}` (no URLs or host names; details go to the server log) |

On a non-`200` answer the extension pauses the task and shows the `error` (and the first `details` entry); the user can fix the cause (e.g. start the model server) and press Resume. The server log records the LLM URL and the error, never the request body, image, task or history.

---

## 2. Health & Diagnostic Endpoints

### 2.1 Health Check: `GET /api/status`
Used by the side panel's server badge (`extension/sidepanel.js`, `checkServerHealth`). It only says the server is reachable; it does not contact the LLM.
```json
{
  "status": "connected"
}
```

### 2.2 Active Model Info: `GET /model/info`
Shows the configured model. The `endpoint` field is included only for requests from this machine (see 3.1), because it can be an internal address.
```json
{
  "model": "gemma4:31b-it-q4_K_M",
  "endpoint": "http://localhost:11434/v1",
  "type": "Vision-Language Model (OpenAI Compatible)",
  "swappable": true
}
```

---

## 3. Dashboard and Runtime Config

### 3.1 Local-only access

`GET /` (the dashboard page) and `GET`/`POST /api/config` answer only when all of these hold; otherwise `403 {"error": "Only available from this machine, at http://localhost:<port>/"}`:

- the client address is loopback (`127.0.0.0/8` or `::1`);
- the `Host` header names `localhost`, `127.0.0.1` or `::1` (stops DNS rebinding, where an attacker's domain re-resolves to `127.0.0.1`);
- an `Origin` header, if present, is the server's own origin (stops another site's page from posting).

Whoever can write this config decides where every frame, task and the API key go, so it is never reachable from another machine or another origin.

### 3.2 `GET /api/config`

Returns the effective config. The API key itself is never returned.

```json
{
  "llm_url": "http://localhost:11434/v1",
  "llm_model": "gemma4:31b-it-q4_K_M",
  "llm_timeout": 600,
  "system_prompt": "You are PrivacyAgent Server — ...",
  "llm_api_key_set": false,
  "env_overrides": []
}
```

`env_overrides` lists the config keys currently set by `PRIVAG_*` variables; they win over anything saved, and the dashboard shows them read-only.

### 3.3 `POST /api/config`

Body: a JSON object with any of `llm_url`, `llm_model`, `llm_timeout`, `system_prompt`, `llm_api_key`. The values are merged into `server/config.json` (a partial save changes only the keys it names; `{}` changes nothing). Response: the same shape as `GET`.

| Key | Rule |
| :--- | :--- |
| `llm_url` | `http://` or `https://` URL with a host, no whitespace, at most 2048 characters. |
| `llm_model` | Non-empty string, at most 200 characters. |
| `llm_timeout` | Number of seconds from 1 to 3600. |
| `system_prompt` | Non-empty string, at most 20000 characters. |
| `llm_api_key` | Printable ASCII without spaces, at most 4096 characters. Empty or missing keeps the saved key. To remove a saved key, delete `llm_api_key` from `server/config.json`. |

An unknown key or an invalid value gets `400 {"error": "..."}` and nothing is saved.

---

## 4. Tests

```powershell
cd server
.venv/Scripts/python.exe -m unittest discover -s tests -v    # Linux/macOS: .venv/bin/python
```

`server/tests/test_app.py` uses only the standard library (`unittest`, `unittest.mock`) and Flask's test client. The LLM is mocked, so no request leaves the machine; each test uses its own temporary `config.json`.
