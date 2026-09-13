#!/usr/bin/env python3
"""Private deployment checks. No canvas writes, account creation, or paid jobs.

Run on the deployment host with access to /opt/selfcanvas-private/.env.
Only the newly provisioned admin password and MCP token are read. Credentials,
HTTP bodies, canvas names, and exception messages are never printed or saved.
"""
from __future__ import annotations

import http.cookiejar
from html.parser import HTMLParser
import json
from pathlib import Path
import secrets
import urllib.error
import urllib.parse
import urllib.request


ENV_PATH = Path('/opt/selfcanvas-private/.env')
CANVAS = 'http://10.66.66.1:5190'
GATEWAY = 'http://10.66.66.1:8080'
MCP = 'http://10.66.66.1:8790/mcp'
MAX_BODY = 16 * 1024 * 1024


class CheckFailed(Exception):
    """Only fixed, non-sensitive error codes belong in this exception."""


def require(condition, code='unexpected_response'):
    if not condition:
        raise CheckFailed(code)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward an Authorization header to another endpoint.


class Http:
    def __init__(self):
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect(),
            urllib.request.HTTPCookieProcessor(self.cookies),
        )

    def request(self, url, *, payload=None, headers=None):
        data = None if payload is None else json.dumps(payload).encode('utf-8')
        request_headers = {'Accept': 'application/json', **(headers or {})}
        if data is not None:
            request_headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(url, data=data, headers=request_headers)
        try:
            response = self.opener.open(request, timeout=25)
        except urllib.error.HTTPError as error:
            response = error
        except (urllib.error.URLError, OSError, TimeoutError):
            raise CheckFailed('connection_failed') from None
        with response:
            body = response.read(MAX_BODY + 1)
            require(len(body) <= MAX_BODY, 'response_too_large')
            return response.code, response.headers, body

    def json(self, url, **kwargs):
        status, headers, body = self.request(url, **kwargs)
        require(status == 200, f'http_{status}')
        try:
            value = json.loads(body)
        except (ValueError, UnicodeError):
            raise CheckFailed('invalid_json') from None
        require(isinstance(value, dict), 'invalid_json_shape')
        return value, headers


def read_credentials():
    require(ENV_PATH.is_file(), 'credentials_missing')
    require(ENV_PATH.stat().st_mode & 0o077 == 0, 'credentials_permissions_not_private')
    wanted = {'SELF_CANVAS_MCP_TOKEN', 'SUB2API_ADMIN_PASSWORD'}
    result = {}
    for line in ENV_PATH.read_text(encoding='utf-8').splitlines():
        name, separator, value = line.strip().partition('=')
        if separator and name in wanted:
            result[name] = value.strip().strip('"\'')
    require(all(len(result.get(name, '')) >= 32 for name in wanted), 'credentials_incomplete')
    return result


class AssetParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.assets = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        raw = attrs.get('src') if tag == 'script' else attrs.get('href') if tag == 'link' else None
        if raw and urllib.parse.urlparse(raw).path.endswith(('.js', '.css')):
            self.assets.add(urllib.parse.urljoin(CANVAS + '/', raw))


def check_static(http):
    status, headers, body = http.request(CANVAS + '/', headers={'Accept': 'text/html'})
    require(status == 200 and 'text/html' in headers.get('Content-Type', ''), 'html_unavailable')
    parser = AssetParser()
    parser.feed(body.decode('utf-8'))
    require(0 < len(parser.assets) <= 64, 'asset_references_missing_or_excessive')
    require(any(urllib.parse.urlparse(url).path.endswith('.js') for url in parser.assets), 'javascript_reference_missing')
    require(any(urllib.parse.urlparse(url).path.endswith('.css') for url in parser.assets), 'stylesheet_reference_missing')
    for url in sorted(parser.assets):
        parsed = urllib.parse.urlparse(url)
        require(f'{parsed.scheme}://{parsed.netloc}' == CANVAS, 'external_asset_reference')
        status, headers, body = http.request(url)
        mime = headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
        expected = {'text/css'} if parsed.path.endswith('.css') else {'text/javascript', 'application/javascript'}
        require(status == 200 and mime in expected and bool(body), 'asset_missing_or_wrong_mime')
    return f'{len(parser.assets)} assets'


def check_health(http, base):
    value, _ = http.json(base + '/api/health' if base == CANVAS else base + '/health')
    require(value.get('status') == 'ok', 'health_not_ok')
    return 'HTTP 200'


def check_browser(http):
    headers = {'Origin': CANVAS, 'Sec-Fetch-Site': 'same-origin'}
    session, response_headers = http.json(CANVAS + '/api/browser/session', headers=headers)
    csrf = session.get('csrfToken')
    cookie = response_headers.get('Set-Cookie', '').lower()
    require(isinstance(csrf, str) and len(csrf) >= 20, 'csrf_missing')
    require('httponly' in cookie and 'samesite=strict' in cookie, 'cookie_security_missing')
    canvases, _ = http.json(CANVAS + '/api/v2/canvases', headers={**headers, 'X-SelfCanvas-CSRF': csrf})
    require(isinstance(canvases.get('canvases'), list), 'canvas_list_invalid')
    return f'{len(canvases["canvases"])} canvases'


def check_bad_origin(http):
    status, _, _ = http.request(CANVAS + '/api/browser/session', headers={
        'Origin': 'https://untrusted.invalid', 'Sec-Fetch-Site': 'cross-site',
    })
    require(status == 403, 'untrusted_origin_not_denied')
    return 'HTTP 403'


def check_gateway_setup(http):
    value, _ = http.json(GATEWAY + '/setup/status')
    data = value.get('data', value)
    require(isinstance(data, dict) and data.get('needs_setup') is False and data.get('step') == 'completed', 'setup_incomplete')
    return 'initialized'


def check_gateway_login(http, credentials):
    value, _ = http.json(GATEWAY + '/api/v1/auth/login', payload={
        'email': 'admin@selfcanvas.local', 'password': credentials['SUB2API_ADMIN_PASSWORD'],
    })
    data = value.get('data', value)
    require(isinstance(data, dict), 'login_response_invalid')
    token = data.get('access_token') or data.get('accessToken') or data.get('token')
    require(isinstance(token, str) and len(token) >= 20, 'login_token_missing')
    # No speculative admin endpoints; receiving the access token verifies login.
    return 'admin authenticated; token not displayed'


def rpc(http, credentials, method, params, request_id, protocol='2025-03-26'):
    result, _ = http.json(MCP, payload={'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params}, headers={
        'Authorization': 'Bearer ' + credentials['SELF_CANVAS_MCP_TOKEN'],
        'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': protocol,
    })
    require(result.get('id') == request_id and isinstance(result.get('result'), dict) and 'error' not in result, 'mcp_rpc_failed')
    return result['result']


def check_mcp(http, credentials):
    status, _, _ = http.request(MCP, payload={})
    require(status == 401, 'mcp_unauthenticated_not_denied')
    initialized = rpc(http, credentials, 'initialize', {
        'protocolVersion': '2025-03-26', 'capabilities': {},
        'clientInfo': {'name': 'selfcanvas-private-verifier', 'version': '1.0.0'},
    }, 1)
    protocol = initialized.get('protocolVersion')
    require(isinstance(protocol, str) and isinstance(initialized.get('serverInfo'), dict), 'mcp_initialize_invalid')
    tools = rpc(http, credentials, 'tools/list', {}, 2, protocol).get('tools')
    require(isinstance(tools, list), 'mcp_tools_invalid')
    listing = next((tool for tool in tools if tool.get('name') == 'canvas_list_canvases'), {})
    require(listing.get('annotations', {}).get('readOnlyHint') is True, 'mcp_read_tool_missing')
    result = rpc(http, credentials, 'tools/call', {'name': 'canvas_list_canvases', 'arguments': {'limit': 20}}, 3, protocol)
    require(not result.get('isError') and isinstance(result.get('structuredContent', {}).get('result', {}).get('canvases'), list), 'mcp_read_call_failed')

    # tools/list intentionally includes scope-protected tools. Test denial with
    # fresh, nonexistent IDs, never with an actual user node. canvas_run_node has
    # no `confirmed` field (its input schema is strict). Even an incorrectly
    # privileged token cannot generate from this nonexistent canvas/node pair.
    probe = 'deploy_probe_' + secrets.token_hex(16)
    denied = rpc(http, credentials, 'tools/call', {'name': 'canvas_run_node', 'arguments': {
        'canvasId': probe, 'nodeId': probe, 'baseRevision': 0, 'requestId': probe,
    }}, 4, protocol)
    errors = []
    for item in denied.get('content', []):
        if item.get('type') == 'text':
            try:
                errors.append(json.loads(item['text']).get('error', {}))
            except (ValueError, AttributeError, TypeError):
                pass
    require(denied.get('isError') is True and any(error.get('code') == 'insufficient_scope' and error.get('status') == 403 for error in errors), 'mcp_generation_scope_not_denied')
    return f'401 enforced; initialized; {len(tools)} tools; canvas read OK; generation scope denied'


def main():
    try:
        credentials = read_credentials()
    except Exception:
        print('FAIL credentials: unavailable or unsafe permissions', flush=True)
        return 1
    http = Http()
    checks = [
        ('SelfCanvas HTML and JS/CSS', lambda: check_static(http)),
        ('SelfCanvas health', lambda: check_health(http, CANVAS)),
        ('SelfCanvas cookie/CSRF read', lambda: check_browser(http)),
        ('SelfCanvas untrusted Origin', lambda: check_bad_origin(http)),
        ('Sub2API health', lambda: check_health(http, GATEWAY)),
        ('Sub2API setup', lambda: check_gateway_setup(http)),
        ('Sub2API admin login', lambda: check_gateway_login(http, credentials)),
        ('MCP authorization and read-only access', lambda: check_mcp(Http(), credentials)),
    ]
    failures = 0
    for label, check in checks:
        try:
            detail = check()
            print(f'PASS {label}: {detail}', flush=True)
        except CheckFailed as error:
            failures += 1
            print(f'FAIL {label}: {error}', flush=True)
        except Exception:
            failures += 1
            print(f'FAIL {label}: check_error (details suppressed)', flush=True)
    print(f'RESULT {len(checks) - failures}/{len(checks)} passed; no media generation or canvas writes performed', flush=True)
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
