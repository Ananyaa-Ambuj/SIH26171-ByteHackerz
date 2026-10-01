from flask import render_template, Flask, request, jsonify
import llm
import os
import sys

app = Flask(__name__)

# Handle CORS
@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = '*'
    response.headers['Access-Control-Allow-Methods'] = '*'
    return response

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api', methods=['POST', 'OPTIONS'])
@app.route('/api/step', methods=['POST', 'OPTIONS'])
def api():
    if request.method == 'OPTIONS':
        return jsonify({"status": "ok"})
    data = request.get_json() or {}
    image = data.get("image", "")
    task = data.get("task", "")
    history = data.get("history", [])
    manifest = data.get("manifest", {})
    response = llm.get_response(manifest, image, task, history)
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
    if request.method == 'POST':
        data = request.get_json(silent=True)
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
    return jsonify({
        "model": config.get("llm_model"),
        "endpoint": config.get("llm_url"),
        "type": "Vision-Language Model (OpenAI Compatible)",
        "swappable": True
    })

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
    app.run(host=host, port=port, debug=debug)