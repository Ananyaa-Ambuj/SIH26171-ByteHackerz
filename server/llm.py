import requests
import json
import logging
import re
import os
from urllib.parse import urlsplit

log = logging.getLogger('privag')

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Tracked defaults (no secrets). Runtime overrides from the dashboard go to config.json, which is gitignored and
# outside static/: Flask serves static/ to anyone, which is how the API key used to leak.
DEFAULT_CONFIG_PATH = os.path.join(_BASE_DIR, 'config.default.json')
CONFIG_PATH = os.path.join(_BASE_DIR, 'config.json')

CONFIG_KEYS = ('llm_url', 'llm_api_key', 'llm_model', 'llm_timeout', 'system_prompt')
ENV_VARS = {
    'llm_url': 'PRIVAG_LLM_URL',
    'llm_model': 'PRIVAG_LLM_MODEL',
    'llm_api_key': 'PRIVAG_LLM_API_KEY',
    'llm_timeout': 'PRIVAG_LLM_TIMEOUT',
}
_MAX_LENGTHS = {'llm_url': 2048, 'llm_api_key': 4096, 'llm_model': 200, 'system_prompt': 20000}
MAX_TIMEOUT = 3600

def _is_http_url(value):
    try:
        parts = urlsplit(value)
    except ValueError:
        return False
    return parts.scheme in ('http', 'https') and bool(parts.hostname) and not any(c.isspace() for c in value)

def check_config_value(key, value):
    """Returns why value is not acceptable for key, or None when it is."""
    if key == 'llm_timeout':
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 1 <= value <= MAX_TIMEOUT:
            return f'llm_timeout must be a number of seconds from 1 to {MAX_TIMEOUT}'
        return None
    if not isinstance(value, str) or len(value) > _MAX_LENGTHS[key]:
        return f'{key} must be a string of at most {_MAX_LENGTHS[key]} characters'
    if key == 'llm_url' and not _is_http_url(value):
        return 'llm_url must be an http:// or https:// URL'
    if key in ('llm_model', 'system_prompt') and not value.strip():
        return f'{key} must not be empty'
    return None

def _load_defaults():
    # A broken defaults file is a bug in the repo, so fail at startup instead of serving half a config
    with open(DEFAULT_CONFIG_PATH, encoding='utf-8') as f:
        defaults = json.load(f)
    problems = [check_config_value(k, defaults.get(k)) for k in CONFIG_KEYS]
    problems = [p for p in problems if p]
    if problems:
        raise RuntimeError(f'{DEFAULT_CONFIG_PATH} is invalid: {"; ".join(problems)}')
    return {k: defaults[k] for k in CONFIG_KEYS}

DEFAULTS = _load_defaults()

def read_overrides():
    """The valid entries of config.json. A missing file means no overrides; a corrupt file, an unknown key or a
    wrongly typed value is skipped with a warning, so one bad save can no longer break every later step."""
    try:
        with open(CONFIG_PATH, encoding='utf-8') as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        log.warning('Ignoring %s: %s', CONFIG_PATH, e)
        return {}
    if not isinstance(data, dict):
        log.warning('Ignoring %s: not a JSON object', CONFIG_PATH)
        return {}
    overrides = {}
    for key, value in data.items():
        problem = check_config_value(key, value) if key in CONFIG_KEYS else 'unknown key'
        if problem:
            log.warning('Ignoring "%s" in %s: %s', key, CONFIG_PATH, problem)
        else:
            overrides[key] = value
    return overrides

def env_overrides():
    """Config values set through PRIVAG_* environment variables (an empty variable counts as unset)."""
    values = {}
    for key, name in ENV_VARS.items():
        raw = os.environ.get(name, '')
        if not raw:
            continue
        value = raw
        if key == 'llm_timeout':
            try:
                value = float(raw)
            except ValueError:
                pass
        problem = check_config_value(key, value)
        if problem:
            log.warning('Ignoring %s: %s', name, problem)
        else:
            values[key] = value
    return values

def load_config():
    """Effective config: config.default.json <- config.json (dashboard) <- PRIVAG_* environment variables."""
    config = dict(DEFAULTS)
    config.update(read_overrides())
    config.update(env_overrides())
    return config

def save_overrides(updates):
    """Merges already validated values into config.json. A value equal to the default is dropped from the file
    instead, so a later change to config.default.json (such as a new system prompt) still takes effect."""
    overrides = read_overrides()
    for key, value in updates.items():
        if value == DEFAULTS[key]:
            overrides.pop(key, None)
        else:
            overrides[key] = value
    # Written to a temp file and swapped in, so a crash mid-write never leaves a half-written config.
    # 0o600: the file can hold an API key (the mode only matters on POSIX systems).
    tmp_path = CONFIG_PATH + '.tmp'
    fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with open(fd, 'w', encoding='utf-8') as f:
        json.dump(overrides, f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, CONFIG_PATH)

def generate_msg(manifest, image_b64, task, history, system_prompt):
    # One numbered line per earlier step (the action plus its result), not a doubly-escaped JSON list
    history_text = "\n".join(
        f"{i}. {step if isinstance(step, str) else json.dumps(step)}" for i, step in enumerate(history, 1)
    ) if history else "None"
    user_content = [
        {
            "type": "text",
            "text": f"Previous Actions History:\n{history_text}"
        },
        {
            "type": "text",
            "text": f"Current Redaction Manifest:\n{json.dumps(manifest) if manifest else 'None'}"
        }
    ]

    if image_b64:
        image_url = image_b64 if image_b64.startswith("data:") else f"data:image/png;base64,{image_b64}"
        user_content.append({
            "type": "image_url",
            "image_url": {
                "url": image_url
            }
        })

    user_content.append({
        "type": "text",
        "text": f"User Task: {task}\n\nWhat is the next action?"
    })

    messages = [
        {
            "role": "system",
            "content": system_prompt
        },
        {
            "role": "user",
            "content": user_content
        }
    ]
    return messages

def parse_action(response_text):
    # regex for formatting into structured json
    action = None
    try:
        action = json.loads(response_text.strip())
    except (json.JSONDecodeError, ValueError):
        match = re.search(r'\{.*\}', response_text, re.DOTALL)
        if match:
            try:
                action = json.loads(match.group(0))
            except (json.JSONDecodeError, ValueError):
                pass

    # The extension needs exactly one action object; some models wrap it in a list
    if isinstance(action, list) and action and isinstance(action[0], dict):
        action = action[0]
    if not isinstance(action, dict):
        return {"action": "wait", "target": "Could not parse action", "value": ""}
    return action

def get_response(manifest, image_b64, task, history):
    # Config Load (always complete: missing or bad entries fall back to config.default.json)
    config = load_config()
    system_prompt = config["system_prompt"]
    raw_url = config["llm_url"].rstrip("/")
    llm_url = raw_url if raw_url.endswith("/chat/completions") else f"{raw_url}/chat/completions"
    llm_api_key = config["llm_api_key"]
    llm_model = config["llm_model"]
    
    messages = generate_msg(manifest, image_b64, task, history, system_prompt)

    headers = {
        "Content-Type": "application/json"
    }
    if llm_api_key != "":
        headers["Authorization"] = f"Bearer {llm_api_key}"

    payload = {
        "model": llm_model,
        "messages": messages
    }

    try:
        res = requests.post(llm_url, headers=headers, json=payload, timeout=config["llm_timeout"])
        res.raise_for_status()
        response = res.json()

        # content is null when a model answers with only tool calls / reasoning
        raw_content = response.get("choices", [{}])[0].get("message", {}).get("content") or ""
        action = parse_action(raw_content)

        return {
            "action": action,
            "raw_response": raw_content
        }
    except Exception as e:
        error_msg = f"LLM Error: {str(e)}"
        return {
            "action": {
                "action": "wait",
                "target": error_msg,
                "coordinates": [0, 0],
                "value": ""
            },
            "raw_response": error_msg,
            # Lets the extension's agent loop stop instead of retrying a model it cannot reach
            "error": error_msg
        }
