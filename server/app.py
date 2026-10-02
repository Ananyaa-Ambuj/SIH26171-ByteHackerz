from flask import render_template, Flask, request, jsonify, json
from werkzeug.exceptions import HTTPException
import ipaddress
import llm
import math
import os
import re
import socket
import sys
import threading
import time
import webbrowser

app = Flask(__name__)
# A sanitized frame is a JPEG data URL; anything far larger is not a frame and would only be forwarded upstream
MAX_BODY_BYTES = 16 * 1024 * 1024
app.config['MAX_CONTENT_LENGTH'] = MAX_BODY_BYTES

# No CORS headers on purpose: the extension's side panel is an extension page with host permissions, which
# Chrome exempts from CORS, while web pages in other origins must not be able to read any response.

LOCAL_HOSTNAMES = ("localhost", "127.0.0.1", "::1")

def _hostname(host):
    # "localhost:5000" -> "localhost", "[::1]:5000" -> "::1"
    if host.startswith("["):
        return host[1:host.find("]")].lower()
    return host.rsplit(":", 1)[0].lower() if host.count(":") == 1 else host.lower()

def is_local_request():
    """True only for a client on this machine that addresses the server by a loopback name. The Host check
    stops DNS rebinding (a web page whose own domain resolves to 127.0.0.1); the Origin check stops a page
    from another origin posting here."""
    try:
        ip = ipaddress.ip_address(request.remote_addr or "")
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    if not ip.is_loopback or _hostname(request.host) not in LOCAL_HOSTNAMES:
        return False
    origin = request.headers.get("Origin")
    return origin is None or origin.lower() == f"{request.scheme}://{request.host}".lower()

def local_only_error():
    if not is_local_request():
        return jsonify({"error": "Only available from this machine, at http://localhost:<port>/"}), 403
    return None

@app.route('/')
def index():
    # The dashboard edits where every sanitized frame goes, so it is local-only like /api/config
    return local_only_error() or render_template('index.html')

# Redaction manifest schema: a rule-for-rule port of extension/redaction-manifest.js (same keys, enums, limits
# and messages). The side panel refuses to send a manifest that fails it; the server refuses to forward one.
MANIFEST_METHODS = ('black_box', 'solid_mask', 'semantic_mock')
MANIFEST_SOURCES = ('dom_text', 'dom_field', 'dom_media', 'florence_od', 'florence_ocr')
REGION_KEYS = {'type', 'method', 'source', 'bbox', 'value'}
ELEMENT_KEYS = {'ref', 'role', 'name', 'bbox', 'filled', 'redacted', 'disabled'}
TOP_KEYS = {'redacted_regions', 'screenshot_dimensions', 'dom_structure'}
BBOX_KEYS = {'x', 'y', 'w', 'h'}
DIMENSION_KEYS = {'width', 'height'}
DOM_KEYS = {'elements'}

def _is_num(v):
    # bool is an int in Python but not a number in JavaScript; json.loads also accepts NaN and Infinity
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    try:
        return math.isfinite(v)
    except OverflowError:
        # An integer too large for a double is not a JavaScript number either
        return False

def _is_int(v):
    # Number.isInteger: 5.0 counts
    return _is_num(v) and float(v).is_integer()

def _is_short_string(v, max_len):
    # Length in UTF-16 code units, as JavaScript counts it
    return isinstance(v, str) and len(v.encode('utf-16-le', 'surrogatepass')) // 2 <= max_len

def _check_bbox(b, where, errors):
    if not isinstance(b, dict) or not all(_is_num(b.get(k)) for k in ('x', 'y', 'w', 'h')):
        errors.append(f'{where}.bbox must be {{x, y, w, h}} numbers')
        return
    _check_keys(b, BBOX_KEYS, f'{where}.bbox', errors)
    if b['w'] <= 0 or b['h'] <= 0 or b['x'] < 0 or b['y'] < 0:
        errors.append(f'{where}.bbox must have x, y >= 0 and w, h > 0')

def _check_keys(obj, allowed, where, errors):
    for key in obj:
        if key not in allowed:
            errors.append(f'{where} has unexpected key "{key}"')

def validate_manifest(manifest):
    """Returns a list of problems; an empty list means the manifest is valid."""
    errors = []
    if not isinstance(manifest, dict):
        return ['manifest must be an object']
    _check_keys(manifest, TOP_KEYS, 'manifest', errors)

    regions = manifest.get('redacted_regions')
    if not isinstance(regions, list):
        errors.append('redacted_regions must be an array')
    else:
        for i, r in enumerate(regions):
            where = f'redacted_regions[{i}]'
            if not isinstance(r, dict):
                errors.append(f'{where} must be an object')
                continue
            _check_keys(r, REGION_KEYS, where, errors)
            if not _is_short_string(r.get('type'), 40) or not r.get('type'):
                errors.append(f'{where}.type must be a non-empty string')
            if r.get('method') not in MANIFEST_METHODS:
                errors.append(f'{where}.method must be one of {", ".join(MANIFEST_METHODS)}')
            if r.get('source') not in MANIFEST_SOURCES:
                errors.append(f'{where}.source must be one of {", ".join(MANIFEST_SOURCES)}')
            _check_bbox(r.get('bbox'), where, errors)
            if 'value' in r and not _is_short_string(r['value'], 200):
                errors.append(f'{where}.value must be a string')
            if r.get('method') == 'semantic_mock' and not isinstance(r.get('value'), str):
                errors.append(f'{where}: semantic_mock needs the value shown')
            if r.get('method') == 'solid_mask' and 'value' in r:
                errors.append(f'{where}: solid_mask carries no value')

    dims = manifest.get('screenshot_dimensions')
    if not isinstance(dims, dict) or not _is_int(dims.get('width')) or not _is_int(dims.get('height')) \
            or dims['width'] <= 0 or dims['height'] <= 0:
        errors.append('screenshot_dimensions must be {width, height} positive integers')
    else:
        _check_keys(dims, DIMENSION_KEYS, 'screenshot_dimensions', errors)

    dom = manifest.get('dom_structure')
    elements = dom.get('elements') if isinstance(dom, dict) else None
    if not isinstance(elements, list):
        errors.append('dom_structure.elements must be an array')
    else:
        _check_keys(dom, DOM_KEYS, 'dom_structure', errors)
        for i, el in enumerate(elements):
            where = f'dom_structure.elements[{i}]'
            if not isinstance(el, dict):
                errors.append(f'{where} must be an object')
                continue
            _check_keys(el, ELEMENT_KEYS, where, errors)
            # fullmatch and [0-9]: Python's $ also matches before a trailing newline and \d matches non-ASCII digits
            if not isinstance(el.get('ref'), str) or not re.fullmatch(r'e[0-9]+', el['ref']):
                errors.append(f'{where}.ref must look like e1')
            if not _is_short_string(el.get('role'), 40):
                errors.append(f'{where}.role must be a string')
            if not _is_short_string(el.get('name'), 80):
                errors.append(f'{where}.name must be a string of at most 80 characters')
            _check_bbox(el.get('bbox'), where, errors)
            for flag in ('filled', 'redacted', 'disabled'):
                if flag in el and not isinstance(el[flag], bool):
                    errors.append(f'{where}.{flag} must be a boolean')
    return errors

MAX_TASK_CHARS = 4000
MAX_HISTORY_ITEMS = 50
MAX_HISTORY_ITEM_CHARS = 4000
IMAGE_PREFIXES = ('data:image/png;base64,', 'data:image/jpeg;base64,')
_BASE64 = re.compile(r'[A-Za-z0-9+/]+={0,2}')

def json_body():
    """The request's JSON body, or None when it is missing, malformed or nested too deeply to parse."""
    try:
        return request.get_json(silent=True)
    except RecursionError:
        return None

def step_request_error(data):
    """Why a POST /api body cannot be forwarded to the LLM (an error body for a 400), or None if it can."""
    if not isinstance(data, dict):
        return {"error": "Request body must be a JSON object (Content-Type: application/json)"}
    task = data.get("task")
    if not isinstance(task, str) or not task.strip() or len(task) > MAX_TASK_CHARS:
        return {"error": f"task must be a non-empty string of at most {MAX_TASK_CHARS} characters"}
    image = data.get("image")
    if not isinstance(image, str) or not image.startswith(IMAGE_PREFIXES) \
            or not _BASE64.fullmatch(image.split(",", 1)[1]):
        return {"error": "image must be a data:image/png;base64, or data:image/jpeg;base64, URL"}
    history = data.get("history", [])
    if not isinstance(history, list) or len(history) > MAX_HISTORY_ITEMS \
            or not all(isinstance(h, str) and len(h) <= MAX_HISTORY_ITEM_CHARS for h in history):
        return {"error": f"history must be a list of at most {MAX_HISTORY_ITEMS} strings of at most "
                         f"{MAX_HISTORY_ITEM_CHARS} characters each"}
    if "manifest" not in data:
        return {"error": "manifest is required"}
    problems = validate_manifest(data["manifest"])
    if problems:
        return {"error": "Invalid manifest", "details": problems[:20]}
    return None

@app.route('/api', methods=['POST'])
@app.route('/api/step', methods=['POST'])
def api():
    data = json_body()
    error = step_request_error(data)
    if error:
        return jsonify(error), 400
    # Only these four fields are forwarded; any other key in the body is ignored
    try:
        response = llm.get_response(data["manifest"], data["image"], data["task"], data.get("history", []))
    except llm.LLMError as e:
        # No answer from the model: the extension pauses the task and shows this error until the user resumes
        return jsonify({"error": f"LLM request failed: {e}"}), 502
    return jsonify(response)
    
@app.route('/api/status', methods=['GET', 'POST'])
def api_status():
    return jsonify({"status": "connected"})

def public_config():
    # Never the key itself: only whether one is set
    config = llm.load_config()
    return {
        "llm_url": config["llm_url"],
        "llm_model": config["llm_model"],
        "llm_timeout": config["llm_timeout"],
        "system_prompt": config["system_prompt"],
        "llm_api_key_set": bool(config["llm_api_key"]),
        # Values set through PRIVAG_* environment variables win over anything saved here
        "env_overrides": sorted(llm.env_overrides()),
    }

@app.route('/api/config', methods=['GET', 'POST'])
def config():
    # Whoever can write this decides where the frames, task and API key go
    denied = local_only_error()
    if denied:
        return denied
    if request.method == 'POST':
        data = json_body()
        if not isinstance(data, dict):
            return jsonify({"error": "Config must be a JSON object"}), 400
        unknown = sorted(set(data) - set(llm.CONFIG_KEYS))
        if unknown:
            return jsonify({"error": f"Unknown config keys: {', '.join(unknown)}"}), 400
        # A blank key keeps the saved one: the dashboard is never sent the key, so it cannot send it back
        key = data.get("llm_api_key")
        if key is None or (isinstance(key, str) and not key.strip()):
            data.pop("llm_api_key", None)
        for name, value in data.items():
            problem = llm.check_config_value(name, value)
            if problem:
                return jsonify({"error": problem}), 400
        # Merged into config.json: a partial save changes only the keys it names
        llm.save_overrides(data)
    return jsonify(public_config())

@app.route('/model/info', methods=['GET'])
def model_info():
    config = llm.load_config()
    info = {
        "model": config["llm_model"],
        "type": "Vision-Language Model (OpenAI Compatible)",
        "swappable": True
    }
    # The endpoint can be an internal address: only shown on this machine
    if is_local_request():
        info["endpoint"] = config["llm_url"]
    return jsonify(info)

# JSON for every error (400, 404, 405, 415, ...) instead of Werkzeug's HTML pages; keeps headers such as Allow
@app.errorhandler(HTTPException)
def http_error(e):
    response = e.get_response()
    response.data = json.dumps({"error": f"{e.code} {e.name}"})
    response.content_type = "application/json"
    return response

@app.errorhandler(413)
def too_large(e):
    return jsonify({"error": f"Request body is larger than {MAX_BODY_BYTES // (1024 * 1024)} MiB"}), 413

# Unhandled exceptions: Flask has already logged the traceback to stderr; the client learns nothing internal
@app.errorhandler(500)
def internal_error(e):
    return jsonify({"error": "Internal server error"}), 500

def open_dashboard_when_ready(host, port):
    """Opens the setup page in the default browser as soon as the server accepts connections, so a first-time user
    lands on it without looking for the URL. The page answers on this machine only, hence a loopback address."""
    local = "[::1]" if host == "::1" else "127.0.0.1"
    for _ in range(50):
        try:
            socket.create_connection((local.strip("[]"), port), timeout=1).close()
            break
        except OSError:
            time.sleep(0.2)
    else:
        return
    url = f"http://{local}:{port}/"
    print(f"Opening the setup page in your browser: {url} (set PRIVAG_OPEN_DASHBOARD=0 to skip)", flush=True)
    webbrowser.open(url)

if __name__ == "__main__":
    # Loopback only and no debugger by default: debug mode shows source and paths on every error and offers a
    # console, and 0.0.0.0 would hand both (and the API) to everyone on the network
    host = os.environ.get("PRIVAG_HOST") or "127.0.0.1"
    port_text = os.environ.get("PRIVAG_PORT") or "5000"
    if not port_text.isdigit() or not 1 <= int(port_text) <= 65535:
        sys.exit(f"PRIVAG_PORT must be a port number from 1 to 65535, got {port_text!r}")
    port = int(port_text)
    debug = os.environ.get("PRIVAG_DEBUG") == "1"

    legacy_config = os.path.join(app.static_folder, "config.json")
    if os.path.exists(legacy_config):
        print(f"WARNING: {legacy_config} is served publicly at /static/config.json and is no longer read. "
              "Delete it; save settings in the dashboard (server/config.json) instead.", file=sys.stderr)
    if host not in ("127.0.0.1", "localhost", "::1"):
        print(f"WARNING: PRIVAG_HOST={host} makes the server reachable from other machines.", file=sys.stderr)
    if debug:
        print("WARNING: PRIVAG_DEBUG=1 turns on the Werkzeug debugger; never use it on a shared network.",
              file=sys.stderr)

    shown_host = f"[{host}]" if ":" in host else host
    print(f"Privag AI server listening on http://{shown_host}:{port}", flush=True)
    # Once only: with PRIVAG_DEBUG=1 the reloader runs this file again in a child process (WERKZEUG_RUN_MAIN)
    if os.environ.get("PRIVAG_OPEN_DASHBOARD", "1") != "0" and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        threading.Thread(target=open_dashboard_when_ready, args=(host, port), daemon=True).start()
    # load_dotenv=False: settings come only from the process environment (see .env.example), even when
    # python-dotenv happens to be installed
    app.run(host=host, port=port, debug=debug, load_dotenv=False)