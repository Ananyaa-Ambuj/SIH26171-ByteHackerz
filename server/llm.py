import requests
import json
import re

def load_config():
    with open('static/config.json', 'r') as f:
        return json.load(f)

def generate_msg(manifest, image_b64, task, history, system_prompt):
    user_content = [
        {
            "type": "text",
            "text": f"Previous Actions History:\n{json.dumps(history) if history else 'None'}"
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
    try:
        return json.loads(response_text.strip())
    except:
        match = re.search(r'\{.*\}', response_text, re.DOTALL) 
        if match:
            try:
                return json.loads(match.group(0)) 
            except:
                pass
        return {"action": "wait", "target": "Could not parse action", "value": ""}

def get_response(manifest, image_b64, task, history):
    # Config Load
    config = load_config()
    system_prompt = config["system_prompt"]
    raw_url = config.get("llm_url", "").rstrip("/")
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
        res = requests.post(llm_url, headers=headers, json=payload, timeout=600)
        res.raise_for_status()
        response = res.json()

        raw_content = response.get("choices", [{}])[0].get("message", {}).get("content", "")
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
            "raw_response": error_msg
        }
