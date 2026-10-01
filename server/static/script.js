// Everything shown here comes from GET /api/config: config.default.json, then server/config.json (what Save
// writes), then PRIVAG_* environment variables. The server never sends the API key back, only whether one is set.

// Config key -> form field
const FIELDS = {
    llm_url: 'llmUrl',
    llm_api_key: 'llmApiKey',
    llm_model: 'llmModel',
    system_prompt: 'systemPrompt'
};

window.onload = async function () {
    // server url
    document.getElementById('extensionUrlDisplay').innerText = window.location.origin;

    await loadConfig();
};

// Fetch the effective config from the Flask server
async function loadConfig() {
    try {
        let response = await fetch('/api/config');
        let data = await response.json();
        if (!response.ok) {
            showAlert(data.error || 'Could not load configuration.', true);
            return;
        }

        document.getElementById('llmUrl').value = data.llm_url;
        document.getElementById('llmModel').value = data.llm_model;
        document.getElementById('systemPrompt').value = data.system_prompt;

        // A blank key field keeps the saved key
        let keyInput = document.getElementById('llmApiKey');
        keyInput.value = '';
        keyInput.placeholder = data.llm_api_key_set ? 'Key saved (leave blank to keep it)' : 'No key saved';
        document.getElementById('keyStatus').innerText = data.llm_api_key_set ? '(key saved)' : '';

        // Fields set by PRIVAG_* environment variables are read-only here and not sent on Save, so the env
        // value is not copied into config.json
        let env = data.env_overrides || [];
        for (let [key, id] of Object.entries(FIELDS)) {
            document.getElementById(id).disabled = env.includes(key);
        }
        let envNote = document.getElementById('envNote');
        envNote.innerText = 'Set by environment variables (read-only here): ' + env.join(', ');
        envNote.style.display = env.length ? 'block' : 'none';
    } catch (err) {
        console.log("Could not load config:", err);
        showAlert('Could not load configuration.', true);
    }
}

// Called when user clicks "Save"
async function save() {
    let configData = {};
    for (let [key, id] of Object.entries(FIELDS)) {
        let input = document.getElementById(id);
        if (!input.disabled) {
            configData[key] = key === 'system_prompt' ? input.value : input.value.trim();
        }
    }
    // A blank key field keeps the saved key
    if (!configData.llm_api_key) {
        delete configData.llm_api_key;
    }

    try {
        let response = await fetch('/api/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(configData)
        });
        let data = await response.json().catch(() => ({}));

        if (response.ok) {
            showAlert('Configuration saved successfully!');
            await loadConfig();
        } else {
            showAlert('Failed to save configuration: ' + (data.error || 'HTTP ' + response.status), true);
        }
    } catch (err) {
        console.log("Error saving:", err);
        showAlert('Error connecting to server.', true);
    }
}

// Copy URL to clipboard
function copyValue(elementId) {
    let text = document.getElementById(elementId).innerText;
    navigator.clipboard.writeText(text);
    showAlert('Copied to clipboard: ' + text);
}

// Show a notification box (green, or red for errors) for a few seconds
function showAlert(message, isError) {
    let box = document.getElementById('alertBox');
    box.innerText = message;
    box.classList.toggle('error', Boolean(isError));
    box.style.display = 'block';

    clearTimeout(showAlert.timer);
    showAlert.timer = setTimeout(function () {
        box.style.display = 'none';
    }, isError ? 6000 : 2000);
}
