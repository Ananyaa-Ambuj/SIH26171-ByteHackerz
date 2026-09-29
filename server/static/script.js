const DEFAULT_PROMPT = `You are PrivacyAgent Server — a browser automation assistant that processes SANITIZED screenshots.

CRITICAL RULES:
1. Black rectangles = redacted text PII (passwords, Aadhaar, PAN, phone numbers).
2. Blurred regions = redacted visual PII (faces, profile photos).
3. Semantic obfuscation = synthetic placeholder text.
4. NEVER attempt to guess, reconstruct, or infer redacted content.
5. Use the Redaction Manifest and DOM context to ground decisions on element labels, placeholders, or IDs.
6. Return EXACTLY ONE action formatted strictly as valid JSON:
{
  "action": "click" | "type" | "scroll" | "wait" | "done",
  "target": "Element description, label or selector",
  "coordinates": [x, y],
  "value": "Text to type if action is type, or up/down if scroll"
}`;

window.onload = async function () {
    // server url
    document.getElementById('extensionUrlDisplay').innerText = window.location.origin + '/api';

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