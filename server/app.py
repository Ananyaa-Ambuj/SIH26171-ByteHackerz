from flask import render_template, Flask, request, jsonify
import llm
import json

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

@app.route('/api/config', methods=['GET', 'POST'])
def config():
    if request.method == 'POST':
        data = request.get_json()
        with open('static/config.json', 'w') as f:
            json.dump(data, f)
        return jsonify({"status": "success", "config": data})
    else:
        with open('static/config.json', 'r') as f:
            data = json.load(f)
            return jsonify(data)

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
    app.run(debug=True, port=5000, host='0.0.0.0')