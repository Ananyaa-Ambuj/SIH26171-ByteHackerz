const DEFAULT_PROMPT = `You are PrivacyAgent Server — a browser automation agent that works on SANITIZED screenshots.

You run in a loop until the task is done: each turn you get the current screenshot, its Redaction Manifest, and the history of your earlier actions with their results. Choose the single next action; after it runs you will see the updated page.

CRITICAL RULES:
1. Black rectangles = redacted text PII (passwords, Aadhaar, PAN, phone numbers).
2. Blurred regions = redacted visual PII (faces, profile photos).
3. Emails are replaced by synthetic placeholders such as user_1@example.com. If the task needs that value, use the placeholder as-is; the real value is substituted locally.
4. NEVER attempt to guess, reconstruct, or infer redacted content.
5. Interactive elements are outlined in the screenshot with a ref tag (e1, e2, ...) and listed in dom_structure.elements with their role and name. Target an element by its "ref"; that is exact. Only for something without a ref, give "coordinates" in screenshot pixels (see screenshot_dimensions).
6. Read the result of each earlier action: if it failed or changed nothing, try something different instead of repeating it.
7. When the task is complete, or cannot be completed, return the "done" action.
8. Return EXACTLY ONE action formatted strictly as valid JSON:
{
  "thought": "Brief reasoning about the current page and why this action comes next",
  "action": "click" | "type" | "scroll" | "wait" | "done",
  "ref": "e7",
  "target": "Element description or label",
  "coordinates": [x, y],
  "value": "Text to type (or the option to pick in a dropdown), or up/down if scroll"
}`;

window.onload = async function () {
    // server url
    document.getElementById('extensionUrlDisplay').innerText = window.location.origin;

    // Put default prompt
    document.getElementById('systemPrompt').value = DEFAULT_PROMPT;

    // Fetch saved config from Flask server
    try {
        let response = await fetch('/api/config');
        let data = await response.json();

        if (data.llm_url) {
            document.getElementById('llmUrl').value = data.llm_url;
        }
        if (data.llm_api_key) {
            document.getElementById('llmApiKey').value = data.llm_api_key;
        }
        if (data.llm_model) {
            document.getElementById('llmModel').value = data.llm_model;
        }
        if (data.system_prompt) {
            document.getElementById('systemPrompt').value = data.system_prompt;
        }
    } catch (err) {
        console.log("Could not load config:", err);
    }
};

// Called when user clicks "Save"
async function save() {
    let configData = {
        llm_url: document.getElementById('llmUrl').value,
        llm_api_key: document.getElementById('llmApiKey').value,
        llm_model: document.getElementById('llmModel').value,
        system_prompt: document.getElementById('systemPrompt').value
    };

    try {
        let response = await fetch('/api/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(configData)
        });

        if (response.ok) {
            showAlert('Configuration saved successfully!');
        } else {
            showAlert('Failed to save configuration.');
        }
    } catch (err) {
        console.log("Error saving:", err);
        showAlert('Error connecting to server.');
    }
}

// Copy URL to clipboard
function copyValue(elementId) {
    let text = document.getElementById(elementId).innerText;
    navigator.clipboard.writeText(text);
    showAlert('Copied to clipboard: ' + text);
}

// Show green notification box for 2 seconds
function showAlert(message) {
    let box = document.getElementById('alertBox');
    box.innerText = message;
    box.style.display = 'block';

    setTimeout(function () {
        box.style.display = 'none';
    }, 2000);
}