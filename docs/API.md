# Privag AI — Server Integration & API Contract Specification

**Base URL:** `http://localhost:5000` (or host network IP `http://x.x.x.x:5000`)  
**Transport:** HTTP/1.1 REST  
**Data Format:** `application/json`  
**CORS Policy:** Fully Open (`Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: *`, `Access-Control-Allow-Headers: *`)

---

## 1. Primary Inference Endpoint: `POST /api` (Alias: `POST /api/step`)

Receives a sanitized screenshot, task description, action history, and redaction manifest from the browser extension, executes the configured Vision-Language Model, and returns a grounded next action.

### Request Body Schema

```json
{
  "image": "data:image/png;base64,iVBORw0KGgo...",
  "task": "Click on the Submit button to complete registration",
  "history": [
    "{\"thought\": \"Fill the username first\", \"action\": \"type\", \"target\": \"username\", \"value\": \"demo_user\", \"result\": \"Typed into target\"}"
  ],
  "manifest": {
    "redacted_regions": [
      {
        "type": "password",
        "method": "black_box",
        "bbox": { "x": 210, "y": 180, "w": 120, "h": 28 }
      },
      {
        "type": "face",
        "method": "gaussian_blur",
        "bbox": { "x": 595, "y": 133, "w": 105, "h": 148 }
      }
    ]
  }
}
```

| Field | Type | Required | Description |
| :--- | :---: | :---: | :--- |
| `image` | `string` | **Yes** | Base64-encoded PNG/JPEG data URI of the sanitized screenshot. |
| `task` | `string` | **Yes** | Natural language user objective (e.g. *"Log into the portal"*). |
| `history` | `string[]` | No | Earlier steps of the current agent run, each a serialized action JSON plus the `result` the page reported (the ReAct observation). |
| `manifest` | `object` | No | Redaction metadata: occluded PII types and coordinates (`redacted_regions`), `screenshot_dimensions`, and `dom_structure` (visible buttons, form fields; never field values). |

---

### Response Schema

```json
{
  "action": {
    "thought": "The form is filled, so submit it",
    "action": "click",
    "target": "Submit",
    "coordinates": [625, 405],
    "value": ""
  },
  "raw_response": "```json\n{\n  \"action\": \"click\",\n  \"target\": \"Submit\",\n  \"coordinates\": [625, 405],\n  \"value\": \"\"\n}\n```"
}
```

| Field | Type | Description |
| :--- | :---: | :--- |
| `action.thought` | `string` | The model's brief reasoning for this step (ReAct), shown in the side panel. |
| `action.action` | `string` | Action grammar verb: `"click"`, `"type"`, `"scroll"`, `"wait"`, `"done"`. The extension's agent loop runs until `"done"`. |
| `action.target` | `string` | Human-readable label or description of the target DOM element. |
| `action.coordinates` | `[number, number]` | `[x, y]` viewport pixel coordinates for the synthetic interaction. |
| `action.value` | `string` | Input string if action is `"type"`, or `"up"`/`"down"` if action is `"scroll"`. |
| `raw_response` | `string` | Verbatim text returned by the VLM prior to regex JSON parsing. |
| `error` | `string` | Present only when the server got no answer from the VLM (unreachable, HTTP error). `action` is then a placeholder `"wait"` and the extension's agent loop stops. |

---

## 2. Health & Diagnostic Endpoints

### 2.1 Health Check: `GET /api/status`
Verifies backend connectivity from extension background scripts.
```json
{
  "status": "connected"
}
```

### 2.2 Active Model Info: `GET /model/info`
Exposes the currently loaded VLM runtime configuration to demonstrate model-agnosticism.
```json
{
  "model": "gemma3:4b",
  "endpoint": "http://10.50.91.133:11434/v1",
  "type": "Vision-Language Model (OpenAI Compatible)",
  "swappable": true
}
```

### 2.3 Runtime Config Sync: `GET /api/config` & `POST /api/config`
Retrieves or updates the active model URL, system prompt, or API key dynamically from the server dashboard.

---

## 3. Extension Client Implementation Snippet

```javascript
/**
 * Dispatches sanitized visual perception to the Privag server.
 * @param {string} sanitizedBase64 - The redacted screenshot (Data URL).
 * @param {string} userTask - The user goal.
 * @param {object} manifest - Redacted region bounding boxes.
 * @returns {Promise<object|null>} The parsed action.
 */
async function sendStepToServer(sanitizedBase64, userTask, manifest = {}) {
    const SERVER_URL = 'http://127.0.0.1:5000/api';

    try {
        const res = await fetch(SERVER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                image: sanitizedBase64,
                task: userTask,
                history: [],
                manifest: manifest
            })
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return data.action;
    } catch (err) {
        console.error('Server communication failed:', err);
        return null;
    }
}
```
