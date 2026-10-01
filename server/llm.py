import requests
import json
import logging
import math
import re
import os
import time
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
    # It becomes an HTTP header: printable ASCII only, so it can neither break nor inject headers
    if key == 'llm_api_key' and value and not re.fullmatch(r'[\x21-\x7e]+', value):
        return 'llm_api_key must be printable ASCII without spaces'
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

def extract_json(text):
    """The model's reply as one JSON object: the whole reply if it is JSON (a list gives its first object), else
    the first {...} object inside it. raw_decode from each "{" respects strings and nesting, so prose around the
    JSON or a second object no longer breaks parsing the way the old greedy regex did."""
    text = text.strip()
    try:
        value = json.loads(text)
    except (ValueError, RecursionError):
        value = None
    if isinstance(value, list):
        value = next((v for v in value if isinstance(v, dict)), None)
    if isinstance(value, dict):
        return value
    decoder = json.JSONDecoder()
    start = text.find('{')
    while start != -1:
        try:
            value, _ = decoder.raw_decode(text, start)
            if isinstance(value, dict):
                return value
        except (ValueError, RecursionError):
            pass
        start = text.find('{', start + 1)
    return None

ACTIONS = ('click', 'type', 'scroll', 'wait', 'done')
INVALID_ACTION = {"action": "wait", "target": "Model reply was not a valid action"}
_MAX_CHARS = {'thought': 1000, 'target': 200, 'value': 1000}
_REF = re.compile(r'\W*[eE]?([0-9]{1,6})\W*')
_REF_IN_TARGET = re.compile(r'\W*[eE][0-9]{1,6}\W*')

def _normalize_ref(value):
    # "e7", "[e7]", "E7" and 7 all mean e7, as the extension reads them
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 10 ** 6:
        return f"e{value}"
    match = _REF.fullmatch(value) if isinstance(value, str) else None
    return f"e{int(match.group(1))}" if match else None

def _is_coordinate(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0

def normalize_action(reply):
    """(action, None) when the reply is one usable action, else (None, why). Only the six documented keys
    survive, so the model cannot smuggle other fields (such as "confirmed") into what the extension runs."""
    if not isinstance(reply, dict):
        return None, "the reply has no JSON object"
    verb = reply.get("action")
    verb = verb.strip().lower() if isinstance(verb, str) else None
    if "action" not in reply:
        return None, 'the reply has no "action"'
    if verb not in ACTIONS:
        return None, f"unknown action {str(reply['action'])[:40]!r}; expected one of {', '.join(ACTIONS)}"

    action = {}
    if isinstance(reply.get("thought"), str):
        action["thought"] = reply["thought"][:_MAX_CHARS["thought"]]
    action["action"] = verb
    ref = _normalize_ref(reply.get("ref"))
    target = reply.get("target")
    # The extension also accepts a ref written only in "target"
    if ref is None and isinstance(target, str) and _REF_IN_TARGET.fullmatch(target):
        ref = _normalize_ref(target)
    if ref:
        action["ref"] = ref
    if isinstance(target, str):
        action["target"] = target[:_MAX_CHARS["target"]]
    coordinates = reply.get("coordinates")
    if isinstance(coordinates, list) and len(coordinates) == 2 and all(_is_coordinate(c) for c in coordinates):
        action["coordinates"] = coordinates
    value = reply.get("value")
    if verb == "scroll":
        value = value.strip().lower() if isinstance(value, str) else ""
        action["value"] = value if value in ("up", "down") else "down"
    elif isinstance(value, str):
        action["value"] = value[:_MAX_CHARS["value"]]

    if verb in ("click", "type") and "ref" not in action and "coordinates" not in action:
        return None, f"{verb} needs a ref or [x, y] coordinates"
    if verb == "type" and not isinstance(value, str):
        return None, "type needs a string value"
    return action, None

class LLMError(Exception):
    """The LLM gave no usable answer (unreachable, timeout, HTTP error, not a chat completion). The message is
    safe to show the client: no URLs or host names."""

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

    # Details (URL, exception text) go to the server console only; never the payload, image, task or history
    started = time.perf_counter()
    try:
        res = requests.post(llm_url, headers=headers, json=payload, timeout=config["llm_timeout"])
        res.raise_for_status()
    except requests.exceptions.Timeout as e:
        log.warning("LLM request to %s timed out: %s", llm_url, e)
        raise LLMError(f"no reply within {config['llm_timeout']} s") from e
    except requests.exceptions.ConnectionError as e:
        log.warning("LLM request to %s could not connect: %s", llm_url, e)
        raise LLMError("could not connect to the LLM endpoint") from e
    except requests.exceptions.HTTPError as e:
        log.warning("LLM request to %s failed: %s", llm_url, e)
        raise LLMError(f"the LLM endpoint answered HTTP {e.response.status_code}") from e
    except requests.exceptions.RequestException as e:
        log.warning("LLM request to %s failed: %s", llm_url, e)
        raise LLMError(type(e).__name__) from e
    vlm_ms = round((time.perf_counter() - started) * 1000)

    try:
        response = res.json()
    except ValueError as e:
        log.warning("LLM reply from %s was not JSON: %s", llm_url, e)
        raise LLMError("the LLM endpoint did not answer with JSON") from e
    try:
        # content is null when a model answers with only tool calls / reasoning
        raw_content = response["choices"][0]["message"].get("content") or ""
    except (KeyError, IndexError, TypeError, AttributeError) as e:
        log.warning("LLM reply from %s had no choices[0].message", llm_url)
        raise LLMError("the LLM endpoint did not return a chat completion") from e
    if not isinstance(raw_content, str):
        raw_content = ""

    action, problem = normalize_action(extract_json(raw_content))
    result = {
        "action": action or dict(INVALID_ACTION),
        "raw_response": raw_content,
        "timing": {"vlm_ms": vlm_ms}
    }
    if problem:
        result["invalid_reason"] = "the model returned an empty reply" if not raw_content.strip() else problem
    return result
