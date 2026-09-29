from flask import render_template, Flask, request, jsonify
import json

app = Flask(__name__)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api', methods=['GET', 'POST']) # WIP
def api():
    return jsonify({"status": "connected"})
    
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

if __name__ == "__main__":
    app.run(debug=True, port=5000, host='0.0.0.0')