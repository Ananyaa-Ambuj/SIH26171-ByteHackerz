"""Tests for the Privag AI server (server/app.py, server/llm.py).

Run (Windows; on Linux/macOS use .venv/bin/python):
    cd server
    uv venv .venv
    uv pip install --python .venv/Scripts/python.exe -r requirements.txt
    .venv/Scripts/python.exe -m unittest discover -s tests -v

Standard library only (unittest, unittest.mock) plus the server's own requirements. The LLM is never contacted:
requests.post is mocked, and every test uses its own temporary config.json with PRIVAG_* variables cleared.
"""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock
from urllib.parse import urlsplit

import requests

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SERVER_DIR)
import app as server  # noqa: E402
import llm  # noqa: E402

IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=='
TASK = 'Type user_0001@example.com into the email field'
LLM_HOST = 'llm.internal.example'


def manifest():
    return {
        'redacted_regions': [
            {'type': 'email', 'method': 'semantic_mock', 'source': 'dom_field', 'value': 'user_0001@example.com',
             'bbox': {'x': 10, 'y': 20, 'w': 200, 'h': 24}},
            {'type': 'password', 'method': 'black_box', 'source': 'dom_field', 'bbox': {'x': 10, 'y': 60, 'w': 200, 'h': 24}},
            {'type': 'face', 'method': 'solid_mask', 'source': 'florence_od', 'bbox': {'x': 300, 'y': 10, 'w': 80.5, 'h': 90}},
        ],
        'screenshot_dimensions': {'width': 1280, 'height': 800},
        'dom_structure': {'elements': [
            {'ref': 'e1', 'role': 'textbox', 'name': 'Email', 'bbox': {'x': 10, 'y': 20, 'w': 200, 'h': 24},
             'filled': False, 'redacted': True},
            {'ref': 'e2', 'role': 'button', 'name': 'Sign in', 'bbox': {'x': 10, 'y': 100, 'w': 80, 'h': 30}},
        ]},
    }


def step_body(**changes):
    body = {'task': TASK, 'image': IMAGE, 'history': ['{"action": "scroll", "value": "down", "result": "Scrolled down"}'],
            'manifest': manifest()}
    body.update(changes)
    return body


def llm_reply(content):
    response = mock.Mock()
    response.json.return_value = {'choices': [{'message': {'content': content}}]}
    return response


class ServerTestCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.config_path = os.path.join(tmp.name, 'config.json')
        for patcher in (mock.patch.object(llm, 'CONFIG_PATH', self.config_path),
                        mock.patch.dict(os.environ, {name: '' for name in llm.ENV_VARS.values()})):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = server.app.test_client()

    def write_config(self, data):
        with open(self.config_path, 'w', encoding='utf-8') as f:
            f.write(data if isinstance(data, str) else json.dumps(data))

    def step(self, body=None, reply='{"action": "done", "thought": "finished"}', **request_kwargs):
        with mock.patch('llm.requests.post', return_value=llm_reply(reply)) as post:
            res = self.client.post('/api', json=step_body() if body is None else body, **request_kwargs)
        return res, post

    def action_for(self, reply):
        res, _ = self.step(reply=reply)
        self.assertEqual(res.status_code, 200)
        return res.get_json()


class CorsAndLocalOnlyTests(ServerTestCase):
    def test_no_cors_headers_on_any_response(self):
        """With Access-Control-Allow-Origin, any website the user visits could read this server's responses (the
        API key used to be one of them). The extension does not need CORS: its side panel is an extension page
        with host permissions."""
        evil = {'Origin': 'https://evil.example'}
        responses = [
            self.client.get('/api/status', headers=evil),
            self.step(headers=evil)[0],
            self.client.open('/api', method='OPTIONS',
                             headers={**evil, 'Access-Control-Request-Method': 'POST'}),
            self.client.get('/static/style.css', headers=evil),
        ]
        for res in responses:
            self.assertFalse([h for h in res.headers.keys() if h.lower().startswith('access-control-')], res.headers)
            res.close()

    def test_config_refuses_clients_on_other_machines(self):
        """Anyone on the same Wi-Fi could otherwise point llm_url at their own host and receive every sanitized
        frame, the task and the API key."""
        remote = {'REMOTE_ADDR': '192.168.1.50'}
        self.assertEqual(self.client.get('/api/config', environ_base=remote).status_code, 403)
        res = self.client.post('/api/config', json={'llm_url': 'http://192.168.1.50:9/v1'}, environ_base=remote)
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.content_type, 'application/json')
        self.assertEqual(llm.load_config()['llm_url'], llm.DEFAULTS['llm_url'])

    def test_config_refuses_dns_rebinding_host(self):
        """DNS rebinding: a page on attacker.example that re-resolves to 127.0.0.1 is same-origin with itself and
        could read the response; the request still names attacker.example in Host, which must be refused."""
        res = self.client.get('/api/config', headers={'Host': 'attacker.example:5000'})
        self.assertEqual(res.status_code, 403)

    def test_config_post_refuses_foreign_origin(self):
        """A web page in another origin must not be able to repoint the LLM URL, or every sanitized frame and the
        task would go to the attacker."""
        res = self.client.post('/api/config', json={'llm_url': 'http://127.0.0.1:9/v1'},
                               headers={'Origin': 'https://evil.example'})
        self.assertEqual(res.status_code, 403)
        self.assertEqual(llm.load_config()['llm_url'], llm.DEFAULTS['llm_url'])

    def test_dashboard_itself_still_works(self):
        """The restrictions must not lock out the user's own dashboard (same origin, loopback, IPv4 or IPv6)."""
        res = self.client.post('/api/config', json={'llm_model': 'gemma4:31b-it-q4_K_M'},
                               headers={'Origin': 'http://localhost'})
        self.assertEqual(res.status_code, 200)
        res = self.client.get('/api/config', environ_base={'REMOTE_ADDR': '::1'}, headers={'Host': '[::1]:5000'})
        self.assertEqual(res.status_code, 200)

    def test_dashboard_page_is_local_only(self):
        """The dashboard edits where every frame goes, so other machines get a JSON 403, never the page."""
        self.assertEqual(self.client.get('/').status_code, 200)
        res = self.client.get('/', environ_base={'REMOTE_ADDR': '10.0.0.7'})
        self.assertEqual(res.status_code, 403)
        self.assertIn('error', res.get_json())

    def test_refusal_names_the_working_url(self):
        """With PRIVAG_HOST=0.0.0.0, opening http://0.0.0.0:5000/ or the LAN address is refused; the error must say
        which address does work, with the real port, instead of a "<port>" placeholder."""
        res = self.client.get('/', base_url='http://0.0.0.0:5123/')
        self.assertEqual(res.status_code, 403)
        self.assertIn('http://localhost:5123/', res.get_json()['error'])
        self.assertNotIn('<port>', res.get_json()['error'])

    def test_model_info_hides_endpoint_from_other_machines(self):
        """The LLM endpoint can be an internal address; only the model name is public."""
        self.write_config({'llm_url': f'http://{LLM_HOST}:11434/v1'})
        remote = self.client.get('/model/info', environ_base={'REMOTE_ADDR': '10.0.0.7'}).get_json()
        self.assertEqual(remote['model'], llm.DEFAULTS['llm_model'])
        self.assertNotIn('endpoint', remote)
        self.assertNotIn(LLM_HOST, json.dumps(remote))
        self.assertEqual(self.client.get('/model/info').get_json()['endpoint'], f'http://{LLM_HOST}:11434/v1')


class ConfigTests(ServerTestCase):
    def test_get_never_returns_the_key(self):
        """The key used to be readable by anyone who could reach the server; the dashboard only needs to know
        whether one is saved."""
        self.write_config({'llm_api_key': 'SECRET-TEST-KEY'})
        for path in ('/api/config', '/model/info'):
            res = self.client.get(path)
            self.assertNotIn('SECRET-TEST-KEY', res.get_data(as_text=True))
            self.assertNotIn('llm_api_key', res.get_json())
        self.assertIs(self.client.get('/api/config').get_json()['llm_api_key_set'], True)

    def test_empty_post_keeps_defaults_and_steps_still_work(self):
        """In Step 1, POST {} replaced the whole config and every later step crashed with KeyError."""
        self.assertEqual(self.client.post('/api/config', json={}).status_code, 200)
        config = self.client.get('/api/config').get_json()
        for key in ('llm_url', 'llm_model', 'llm_timeout', 'system_prompt'):
            self.assertEqual(config[key], llm.DEFAULTS[key])
        res, post = self.step()
        self.assertEqual(res.status_code, 200)
        self.assertEqual(post.call_args.kwargs['json']['messages'][0]['content'], llm.DEFAULTS['system_prompt'])

    def test_partial_post_merges_and_blank_key_keeps_saved_key(self):
        """The dashboard never receives the key, so it sends a blank one; that must not wipe the saved key, and
        saving one field must not drop the others."""
        self.client.post('/api/config', json={'llm_api_key': 'SECRET-TEST-KEY', 'llm_model': 'model-a'})
        self.client.post('/api/config', json={'llm_api_key': '', 'llm_url': f'http://{LLM_HOST}:8000/v1'})
        config = llm.load_config()
        self.assertEqual((config['llm_api_key'], config['llm_model'], config['llm_url']),
                         ('SECRET-TEST-KEY', 'model-a', f'http://{LLM_HOST}:8000/v1'))
        _, post = self.step()
        self.assertEqual(post.call_args.kwargs['headers']['Authorization'], 'Bearer SECRET-TEST-KEY')

    def test_post_rejects_unknown_keys_and_bad_values(self):
        """Only an http(s) URL may receive frames, the key becomes an HTTP header, and an unknown key is a typo
        or an attack; each is refused with a JSON 400 and nothing is saved."""
        for body in ({'llm_url': 'file:///etc/passwd'}, {'llm_url': 'javascript:alert(1)'}, {'text_snippet': 'x'},
                     {'llm_api_key': 'two words'}, {'llm_api_key': 'key\r\nX-Injected: 1'}, {'llm_timeout': 0},
                     {'llm_timeout': True}, {'system_prompt': '   '}, {'llm_model': 'm' * 201}, [1]):
            res = self.client.post('/api/config', json=body)
            self.assertEqual(res.status_code, 400, body)
            self.assertIn('error', res.get_json())
        self.assertFalse(os.path.exists(self.config_path))

    def test_value_equal_to_default_is_not_frozen_into_config_json(self):
        """The dashboard saves every field; a default prompt copied into config.json would hide later fixes to
        config.default.json on that install."""
        self.client.post('/api/config', json={'system_prompt': llm.DEFAULTS['system_prompt'], 'llm_model': 'm2'})
        with open(self.config_path, encoding='utf-8') as f:
            self.assertEqual(json.load(f), {'llm_model': 'm2'})

    def test_corrupt_or_wrongly_typed_config_falls_back_to_defaults(self):
        """A hand-edited or half-written config.json must degrade to the defaults, not crash every step."""
        for content in ('{corrupt', '[1, 2]', json.dumps({'system_prompt': 5, 'llm_url': 'ftp://x', 'llm_timeout': 'x'})):
            self.write_config(content)
            with self.assertLogs('privag', 'WARNING'):
                self.assertEqual(llm.load_config(), llm.DEFAULTS)
            with self.assertLogs('privag', 'WARNING'):
                self.assertEqual(self.step()[0].status_code, 200)

    def test_environment_variables_override_config_file(self):
        """A judge can point the server at their own LLM without editing files, and the dashboard says which
        values come from the environment."""
        self.write_config({'llm_url': 'http://127.0.0.1:1/v1', 'llm_model': 'from-file'})
        env = {'PRIVAG_LLM_URL': f'http://{LLM_HOST}:8000/v1', 'PRIVAG_LLM_MODEL': 'google/gemma-4-31B-it',
               'PRIVAG_LLM_API_KEY': 'ENV-KEY', 'PRIVAG_LLM_TIMEOUT': '30'}
        with mock.patch.dict(os.environ, env):
            _, post = self.step()
            config = self.client.get('/api/config').get_json()
        self.assertEqual(post.call_args.args[0], f'http://{LLM_HOST}:8000/v1/chat/completions')
        self.assertEqual(post.call_args.kwargs['json']['model'], 'google/gemma-4-31B-it')
        self.assertEqual(post.call_args.kwargs['headers']['Authorization'], 'Bearer ENV-KEY')
        self.assertEqual(post.call_args.kwargs['timeout'], 30)
        self.assertEqual(config['env_overrides'], ['llm_api_key', 'llm_model', 'llm_timeout', 'llm_url'])

    def test_non_ascii_prompt_round_trips_as_utf8(self):
        """Without an explicit encoding, Windows read config.json as cp1252 and garbled non-ASCII prompts (for
        example Hindi) before they reached the model."""
        prompt = 'आप एक ब्राउज़र एजेंट हैं — never guess masked content.'
        self.client.post('/api/config', json={'system_prompt': prompt})
        self.assertEqual(self.client.get('/api/config').get_json()['system_prompt'], prompt)
        _, post = self.step()
        self.assertEqual(post.call_args.kwargs['json']['messages'][0]['content'], prompt)

    def test_default_config_is_local_and_matches_the_masking_policy(self):
        """A judge's first run must go to a local model, not a third-party tunnel, and the prompt must describe
        the masks actually drawn (solid masks, not blur) and forbid guessing masked content (claim C17)."""
        self.assertIn(urlsplit(llm.DEFAULTS['llm_url']).hostname, ('localhost', '127.0.0.1'))
        self.assertEqual(llm.DEFAULTS['llm_api_key'], '')
        prompt = llm.DEFAULTS['system_prompt']
        self.assertIn('NEVER attempt to guess, reconstruct, or infer masked content', prompt)
        self.assertIn('solid_mask', prompt)
        self.assertNotIn('lurred', prompt)


class StepValidationTests(ServerTestCase):
    def test_non_object_bodies_get_json_400(self):
        """These used to crash with a 500 Werkzeug debugger page (source code and local paths)."""
        cases = [dict(json=[1]), dict(json='just a string'), dict(json=None, data='{bad', content_type='application/json'),
                 dict(json=None, data='hello', content_type='text/plain')]
        for kwargs in cases:
            kwargs = {k: v for k, v in kwargs.items() if not (k == 'json' and v is None)}
            res = self.client.post('/api', **kwargs)
            self.assertEqual(res.status_code, 400, kwargs)
            self.assertEqual(res.content_type, 'application/json')

    def test_huge_integers_and_deep_nesting_get_json_400(self):
        """A 400-digit number in a box or a body nested 100000 levels deep used to crash the server with a 500
        (OverflowError / RecursionError) where the extension's validator rejects the same frame."""
        huge = manifest()
        huge['redacted_regions'][0]['bbox']['x'] = 10 ** 400
        res, post = self.step(step_body(manifest=huge))
        self.assertEqual(res.status_code, 400)
        post.assert_not_called()
        with mock.patch('llm.requests.post') as post:
            res = self.client.post('/api', data='[' * 100000, content_type='application/json')
        self.assertEqual(res.status_code, 400)
        self.assertTrue(res.is_json)
        post.assert_not_called()

    def test_oversized_body_gets_json_413(self):
        """A 20 MB body used to be accepted and forwarded upstream in full."""
        body = b'{"task": "' + b'a' * (server.MAX_BODY_BYTES + 1) + b'"}'
        with mock.patch('llm.requests.post') as post:
            res = self.client.post('/api', data=body, content_type='application/json')
        self.assertEqual(res.status_code, 413)
        self.assertEqual(res.content_type, 'application/json')
        post.assert_not_called()

    def test_bad_fields_are_rejected_before_the_llm(self):
        """A string history was forwarded one character per line and a missing task as an empty task; nothing
        malformed may reach the model."""
        bad = [step_body(task=''), step_body(task='   '), step_body(task='x' * 4001), step_body(task=5),
               step_body(image=123), step_body(image='http://example.com/a.png'),
               step_body(image='data:image/png;base64,'), step_body(image='data:image/svg+xml;base64,PHN2Zz4='),
               step_body(history='abc'), step_body(history={'k': 'v'}), step_body(history=['x'] * 51),
               step_body(history=[{'action': 'click'}]), step_body(history=['x' * 4001])]
        for body in bad:
            res, post = self.step(body)
            self.assertEqual(res.status_code, 400, body)
            post.assert_not_called()

    def test_manifest_is_required_and_validated(self):
        """The model needs the manifest to know what was masked; a missing or malformed one (e.g. a blurred face
        from an old extension) must not be forwarded."""
        body = step_body()
        del body['manifest']
        self.assertEqual(self.step(body)[0].status_code, 400)
        regions = manifest()
        regions['redacted_regions'][2]['method'] = 'gaussian_blur'
        res, post = self.step(step_body(manifest=regions))
        self.assertEqual(res.status_code, 400)
        self.assertIn('method must be one of', res.get_json()['details'][0])
        post.assert_not_called()

    def test_manifest_with_extra_key_is_rejected(self):
        """Allow-listed keys are what stop raw OCR text or a field value riding along to the server by accident."""
        for where in ('top', 'region', 'element'):
            m = manifest()
            target = {'top': m, 'region': m['redacted_regions'][0], 'element': m['dom_structure']['elements'][0]}[where]
            target['text_snippet'] = 'Aadhaar 2345 6789 0123'
            res, post = self.step(step_body(manifest=m))
            self.assertEqual(res.status_code, 400, where)
            self.assertIn('unexpected key "text_snippet"', ' '.join(res.get_json()['details']))
            post.assert_not_called()

    def test_manifest_rules_match_the_extension(self):
        """The server applies the same rules as extension/redaction-manifest.js, so a frame the extension would
        refuse to send is also refused here, and one it sends is accepted."""
        def broken(change):
            m = manifest()
            change(m)
            return m
        rejected = [
            broken(lambda m: m['redacted_regions'][0].pop('value')),                         # semantic_mock needs value
            broken(lambda m: m['redacted_regions'][2].update(value='x')),                    # solid_mask has no value
            broken(lambda m: m['redacted_regions'][0].update(source='server')),
            broken(lambda m: m['redacted_regions'][0].update(type='')),
            broken(lambda m: m['redacted_regions'][0]['bbox'].update(w=0)),
            broken(lambda m: m['redacted_regions'][0]['bbox'].update(x=True)),               # bool is not a number
            broken(lambda m: m['redacted_regions'][0]['bbox'].update(x=float('nan'))),
            broken(lambda m: m['screenshot_dimensions'].update(width=12.5)),
            broken(lambda m: m['dom_structure']['elements'][0].update(ref='e1\n')),          # Python $ would allow it
            broken(lambda m: m['dom_structure']['elements'][0].update(ref='e١')),            # non-ASCII digit
            broken(lambda m: m['dom_structure']['elements'][0].update(name='n' * 81)),
            broken(lambda m: m['dom_structure']['elements'][0].update(filled='yes')),
            broken(lambda m: m.update(dom_structure=[])),
            broken(lambda m: m.update(redacted_regions={})),
            # Nested objects are allow-listed too, so no field can carry page text inside a box or the structure
            broken(lambda m: m['redacted_regions'][0]['bbox'].update(text='2345 6789 0124')),
            broken(lambda m: m['dom_structure']['elements'][0]['bbox'].update(label='Rahul Sharma')),
            broken(lambda m: m['dom_structure'].update(page_text='Rahul Sharma')),
            broken(lambda m: m['screenshot_dimensions'].update(url='https://bank.example/account')),
        ]
        for m in rejected:
            self.assertEqual(self.step(step_body(manifest=m))[0].status_code, 400, m)
        accepted = [
            manifest(),
            broken(lambda m: m['screenshot_dimensions'].update(width=1280.0)),               # Number.isInteger(1280.0)
            broken(lambda m: m['dom_structure']['elements'][0].update(name='😀' * 40)),      # 80 UTF-16 code units
            broken(lambda m: m.update(redacted_regions=[], dom_structure={'elements': []})),
        ]
        for m in accepted:
            self.assertEqual(self.step(step_body(manifest=m))[0].status_code, 200, m)

    def test_other_errors_are_json_too(self):
        """No Werkzeug HTML error page may ever be returned; the extension and scripts parse JSON."""
        for res in (self.client.get('/nope'), self.client.get('/api'), self.client.put('/api/config')):
            self.assertEqual(res.content_type, 'application/json')
            self.assertIn('error', res.get_json())

    def test_unexpected_crash_returns_generic_json_500(self):
        """A traceback (source, local paths) must never reach the client; it stays in the server log."""
        with mock.patch('llm.get_response', side_effect=RuntimeError(r'C:\Users\someone\secret.py')), \
                self.assertLogs(server.app.logger, 'ERROR'):
            res = self.client.post('/api', json=step_body())
        self.assertEqual(res.status_code, 500)
        self.assertEqual(res.get_json(), {'error': 'Internal server error'})


class ForwardingTests(ServerTestCase):
    def test_valid_step_forwards_prompt_manifest_image_and_task(self):
        """The model needs exactly these four inputs; anything else in the body is not forwarded."""
        body = step_body(extra_field='must not be forwarded')
        res, post = self.step(body, reply='{"action": "click", "ref": "e2", "target": "Sign in"}')
        self.assertEqual(res.status_code, 200)
        url = post.call_args.args[0]
        payload = post.call_args.kwargs['json']
        self.assertEqual(url, llm.DEFAULTS['llm_url'] + '/chat/completions')
        self.assertEqual(payload['model'], llm.DEFAULTS['llm_model'])
        self.assertEqual(payload['messages'][0], {'role': 'system', 'content': llm.DEFAULTS['system_prompt']})
        user = payload['messages'][1]['content']
        texts = '\n'.join(p['text'] for p in user if p['type'] == 'text')
        manifest_part = next(p['text'] for p in user if p['type'] == 'text' and 'Redaction Manifest' in p['text'])
        self.assertEqual(json.loads(manifest_part.split('\n', 1)[1]), body['manifest'])
        self.assertIn(TASK, texts)
        self.assertIn('Scrolled down', texts)
        self.assertEqual([p['image_url']['url'] for p in user if p['type'] == 'image_url'], [IMAGE])
        self.assertNotIn('must not be forwarded', json.dumps(payload))
        self.assertNotIn('Authorization', post.call_args.kwargs['headers'])

        data = res.get_json()
        self.assertEqual(data['action'], {'action': 'click', 'ref': 'e2', 'target': 'Sign in'})
        self.assertIsInstance(data['timing']['vlm_ms'], int)
        self.assertNotIn('invalid_reason', data)


class ModelReplyTests(ServerTestCase):
    def test_unknown_verb_becomes_wait(self):
        """The extension can only run click/type/scroll/wait/done; 'navigate' to an arbitrary URL must never be
        passed on as if it were an action."""
        data = self.action_for('{"action": "navigate", "target": "https://evil.example", "coordinates": [1, 2]}')
        self.assertEqual(data['action'], llm.INVALID_ACTION)
        self.assertIn('navigate', data['invalid_reason'])

    def test_ask_user_carries_a_question(self):
        """The agent can stop and ask the user for a missing detail; the side panel shows the question, so an
        ask_user without one would leave the user staring at an empty prompt."""
        data = self.action_for('{"action": "ask_user", "thought": "date missing", "question": " Which travel date? "}')
        self.assertEqual(data['action'], {'action': 'ask_user', 'thought': 'date missing', 'question': 'Which travel date?'})
        # Models that put the question in "value", as for type, are understood too
        self.assertEqual(self.action_for('{"action": "ASK_USER", "value": "Which class?"}')['action']['question'],
                         'Which class?')
        for reply in ('{"action": "ask_user"}', '{"action": "ask_user", "question": "  "}',
                      '{"action": "ask_user", "question": 5}'):
            data = self.action_for(reply)
            self.assertEqual(data['action'], llm.INVALID_ACTION, reply)
            self.assertIn('question', data['invalid_reason'])
        self.assertEqual(len(self.action_for('{"action": "ask_user", "question": "%s"}' % ('q' * 900))['action']['question']), 500)

    def test_done_announces_a_summary(self):
        """The side panel announces the end of a task with the model's summary; a "done" without one must still end
        the task (it is not invalid), and the summary is kept only on "done"."""
        data = self.action_for('{"action": "done", "summary": " Entered the PAN in the PAN field. "}')
        self.assertEqual(data['action'], {'action': 'done', 'summary': 'Entered the PAN in the PAN field.'})
        self.assertEqual(self.action_for('{"action": "done"}')['action'], {'action': 'done'})
        self.assertNotIn('invalid_reason', self.action_for('{"action": "done", "summary": 7}'))
        self.assertNotIn('summary', self.action_for('{"action": "scroll", "summary": "x"}')['action'])
        self.assertEqual(len(self.action_for('{"action": "done", "summary": "%s"}' % ('s' * 900))['action']['summary']), 500)

    def test_default_prompt_describes_every_action(self):
        """The model can only use an action it is told about: every action the server accepts must be in the
        default system prompt's JSON template."""
        for verb in llm.ACTIONS:
            self.assertIn(f'\\"{verb}\\"', json.dumps(llm.DEFAULTS['system_prompt']), verb)
        self.assertIn('"question"', llm.DEFAULTS['system_prompt'])
        self.assertIn('"summary"', llm.DEFAULTS['system_prompt'])

    def test_smuggled_keys_are_dropped(self):
        """The model must not be able to set flags such as "confirmed" that the extension's action gate might
        trust; only the eight documented keys survive."""
        data = self.action_for('{"action": "click", "ref": "e2", "confirmed": true, "url": "https://evil.example",'
                               ' "thought": "pay now"}')
        self.assertEqual(set(data['action']), {'action', 'ref', 'thought'})

    def test_prose_around_json_is_parsed(self):
        """Models often wrap the JSON in prose or a code fence; that is still one valid action."""
        reply = 'Sure! Here is the action:\n```json\n{"thought": "fill it", "action": "type", "ref": "e1", ' \
                '"value": "user_0001@example.com"}\n```\nLet me know {if} you need more.'
        self.assertEqual(self.action_for(reply)['action'],
                         {'thought': 'fill it', 'action': 'type', 'ref': 'e1', 'value': 'user_0001@example.com'})

    def test_two_objects_give_the_first(self):
        """The old greedy regex spanned both objects and returned 'wait'; one step runs one action, the first."""
        data = self.action_for('First {"action": "click", "ref": "e1"} then {"action": "done"}')
        self.assertEqual(data['action'], {'action': 'click', 'ref': 'e1'})
        data = self.action_for('[{"action": "scroll", "value": "UP"}, {"action": "done"}]')
        self.assertEqual(data['action'], {'action': 'scroll', 'value': 'up'})

    def test_braces_inside_strings_do_not_break_parsing(self):
        """The object scan must respect JSON strings, or a typed value containing } would cut the action short."""
        data = self.action_for('{"action": "type", "ref": "e1", "value": "a}b{c"}')
        self.assertEqual(data['action']['value'], 'a}b{c')

    def test_invalid_json_becomes_wait_with_reason(self):
        """An unparseable reply must not crash or execute anything; the loop sees 'wait' and the reason."""
        for reply in ('{action: click, target: Submit', '', 'I cannot help with that.', '{"target": "Submit"}'):
            data = self.action_for(reply)
            self.assertEqual(data['action'], llm.INVALID_ACTION, reply)
            self.assertTrue(data['invalid_reason'], reply)

    def test_ref_and_verb_spellings_are_normalised(self):
        """Small models write refs loosely; the extension reads all of these as e7, so the server must too."""
        for ref in ('"e7"', '"[e7]"', '"E7"', '7'):
            self.assertEqual(self.action_for('{"action": " CLICK ", "ref": %s}' % ref)['action'],
                             {'action': 'click', 'ref': 'e7'})
        self.assertEqual(self.action_for('{"action": "click", "target": "[e12]"}')['action']['ref'], 'e12')

    def test_targets_and_values_are_checked(self):
        """click/type without a usable target would hit whatever element is first or focused on the page."""
        for reply in ('{"action": "click", "coordinates": ["a", null]}', '{"action": "click", "coordinates": [-1, 5]}',
                      '{"action": "click", "ref": "first input"}', '{"action": "type", "ref": "e1"}',
                      '{"action": "type", "ref": "e1", "value": 5}'):
            self.assertEqual(self.action_for(reply)['action'], llm.INVALID_ACTION, reply)
        self.assertEqual(self.action_for('{"action": "click", "coordinates": [10, 20.5]}')['action'],
                         {'action': 'click', 'coordinates': [10, 20.5]})
        self.assertEqual(self.action_for('{"action": "scroll", "value": "sideways"}')['action']['value'], 'down')
        long = self.action_for('{"action": "done", "thought": "%s"}' % ('x' * 5000))['action']
        self.assertEqual(len(long['thought']), 1000)


class LLMFailureTests(ServerTestCase):
    def failing_step(self, **post_kwargs):
        with mock.patch('llm.requests.post', **post_kwargs), self.assertLogs('privag', 'WARNING') as logs:
            res = self.client.post('/api', json=step_body())
        return res, '\n'.join(logs.output)

    def test_unreachable_llm_gives_502_without_host_names(self):
        """Echoing the upstream URL and exception text turned the server into an internal port-scan oracle; the
        client gets a short reason, the details stay in the server log."""
        self.write_config({'llm_url': f'http://{LLM_HOST}:11434/v1'})
        error = requests.exceptions.ConnectionError(f"HTTPConnectionPool(host='{LLM_HOST}', port=11434): refused")
        res, log_text = self.failing_step(side_effect=error)
        self.assertEqual(res.status_code, 502)
        self.assertTrue(res.get_json()['error'].startswith('LLM request failed: '))
        self.assertNotIn(LLM_HOST, res.get_data(as_text=True))
        self.assertIn(LLM_HOST, log_text)

    def test_failure_log_never_contains_the_payload(self):
        """The server log may hold the URL and error, never the task, history, manifest or image."""
        res, log_text = self.failing_step(side_effect=requests.exceptions.ConnectionError('refused'))
        self.assertEqual(res.status_code, 502)
        for secret in (TASK, IMAGE, 'Scrolled down', 'user_0001@example.com'):
            self.assertNotIn(secret, log_text)

    def test_timeout_http_error_and_non_json_answers_give_502(self):
        """None of these is a model answer; a 200 'wait' would make the extension retry a dead endpoint."""
        http_error = mock.Mock()
        http_error.raise_for_status.side_effect = requests.exceptions.HTTPError(
            f'503 for url: http://{LLM_HOST}/v1', response=mock.Mock(status_code=503))
        html = mock.Mock()
        html.json.side_effect = requests.exceptions.JSONDecodeError('Expecting value', '<html>', 0)
        no_choices = mock.Mock()
        no_choices.json.return_value = {'error': {'message': 'model not found'}}
        cases = [dict(side_effect=requests.exceptions.ReadTimeout(f'{LLM_HOST} read timed out')),
                 dict(return_value=http_error), dict(return_value=html), dict(return_value=no_choices)]
        for kwargs in cases:
            res, _ = self.failing_step(**kwargs)
            self.assertEqual(res.status_code, 502, kwargs)
            self.assertNotIn(LLM_HOST, res.get_data(as_text=True))


class EnvFileTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = os.path.join(tmp.name, '.env')
        # Whatever load_env_file adds to the environment is removed again after each test
        patcher = mock.patch.dict(os.environ, {})
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in ('PRIVAG_PORT', 'PRIVAG_LLM_MODEL', 'PRIVAG_HOST'):
            os.environ.pop(name, None)

    def write(self, text):
        with open(self.path, 'w', encoding='utf-8') as f:
            f.write(text)

    def test_env_file_settings_reach_the_server(self):
        """.env.example tells users to copy it to server/.env: the values there must take effect, including the
        port and host that are read before the server starts."""
        self.write('PRIVAG_PORT=5123\nPRIVAG_LLM_MODEL=gemma4:12b\n')
        self.assertTrue(server.load_env_file(self.path))
        self.assertEqual(os.environ['PRIVAG_PORT'], '5123')
        self.assertEqual(llm.env_overrides()['llm_model'], 'gemma4:12b')

    def test_real_environment_wins_over_env_file(self):
        """A variable set for one run ($env:PRIVAG_PORT=5001) must not be undone by an old value in the file."""
        os.environ['PRIVAG_PORT'] = '5001'
        self.write('PRIVAG_PORT=5123\n')
        server.load_env_file(self.path)
        self.assertEqual(os.environ['PRIVAG_PORT'], '5001')

    def test_empty_entries_count_as_unset(self):
        """A copied .env.example has every variable empty; that must keep the defaults, not blank them out."""
        self.write('PRIVAG_HOST=\nPRIVAG_LLM_MODEL=\n')
        server.load_env_file(self.path)
        self.assertNotIn('llm_model', llm.env_overrides())
        self.assertEqual(os.environ.get('PRIVAG_HOST') or '127.0.0.1', '127.0.0.1')

    def test_missing_env_file_is_fine(self):
        """server/.env is optional."""
        self.assertFalse(server.load_env_file(self.path))


class FilesTests(ServerTestCase):
    def test_static_config_json_is_gone(self):
        """server/static/ is served to anyone; the old config.json there leaked the API key at /static/config.json."""
        self.assertFalse(os.path.exists(os.path.join(server.app.static_folder, 'config.json')))
        self.assertEqual(self.client.get('/static/config.json').status_code, 404)
        self.assertNotEqual(os.path.dirname(llm.DEFAULT_CONFIG_PATH), server.app.static_folder)

    def test_templates_folder_resolves_case_sensitively(self):
        """Flask looks for "templates"; "Templates" only worked on case-insensitive Windows/macOS volumes and gave
        a 500 TemplateNotFound on Linux."""
        entries = os.listdir(SERVER_DIR)
        self.assertIn('templates', entries)
        self.assertNotIn('Templates', entries)
        self.assertTrue(os.path.isfile(os.path.join(SERVER_DIR, 'templates', 'index.html')))
        res = self.client.get('/')
        self.assertEqual(res.status_code, 200)
        self.assertIn(b'Privag AI', res.data)


if __name__ == '__main__':
    unittest.main()
