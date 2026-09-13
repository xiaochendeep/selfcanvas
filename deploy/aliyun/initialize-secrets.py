"""One-time private deployment credentials; never prints secret values."""
import os
from pathlib import Path
import secrets

root = Path('/opt/selfcanvas-private')
env_path = root / '.env'
credentials = root / 'ACCESS.txt'
if env_path.exists() or credentials.exists():
    raise SystemExit('Credentials already exist; refusing to overwrite.')
os.umask(0o077)
values = {name: secrets.token_hex(32) for name in (
    'POSTGRES_PASSWORD', 'GATEWAY_REDIS_PASSWORD', 'CANVAS_REDIS_PASSWORD',
    'SELF_CANVAS_API_TOKEN', 'SELF_CANVAS_MCP_TOKEN', 'SUB2API_ADMIN_PASSWORD',
    'SUB2API_JWT_SECRET', 'SUB2API_TOTP_KEY',
)}
env_path.write_text(''.join(f'{key}={value}\n' for key, value in values.items()), encoding='utf-8')
credentials.write_text(
    'SelfCanvas / Sub2API private deployment\n'
    'Connect the existing WireGuard or Tailscale first. No public web access.\n\n'
    'SelfCanvas: http://10.66.66.1:5190/ or http://100.78.18.60:5190/\n'
    'Sub2API: http://10.66.66.1:8080/ or http://100.78.18.60:8080/\n'
    'Admin email: admin@selfcanvas.local\n'
    f'Admin password: {values["SUB2API_ADMIN_PASSWORD"]}\n\n'
    'SelfCanvas MCP (read-only initially): http://10.66.66.1:8790/mcp\n'
    f'MCP Bearer Token: {values["SELF_CANVAS_MCP_TOKEN"]}\n\n'
    'No upstream model accounts or API keys have been imported.\n'
    'Do not share this file or commit it to Git.\n', encoding='utf-8')
print('Created private .env and ACCESS.txt with mode 0600; no upstream credentials imported.')
