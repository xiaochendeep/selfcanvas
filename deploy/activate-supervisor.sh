#!/usr/bin/env bash
set -euo pipefail

REMOTE_DIR="${SELF_CANVAS_REMOTE_DIR:-/home/deploy/selfcanvas}"

install -m 0644 "$REMOTE_DIR/deploy/supervisor-selfcanvas.conf" /etc/supervisor/conf.d/selfcanvas.conf
if ! supervisorctl pid >/dev/null 2>&1; then
  supervisord -c /etc/supervisor/supervisord.conf
fi
supervisorctl reread
supervisorctl update
supervisorctl restart selfcanvas:

for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/api/health >/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:8787/api/health >/dev/null
curl -fsS http://127.0.0.1:8790/health >/dev/null
supervisorctl status selfcanvas:
echo "SelfCanvas deployment healthy on ports 8787 and 8790."
