#!/bin/sh
set -eu
cd /opt/selfcanvas-private
# Both VPN addresses must exist. Never fall back to binding the public interface.
attempt=0
while ! ip -4 address show dev wg0 | grep -q '10.66.66.1/24' || ! ip -4 address show dev tailscale0 | grep -q '100.78.18.60/32'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo 'Private VPN addresses are not ready; refusing public fallback.' >&2
    exit 1
  fi
  sleep 2
done
docker compose config --quiet
exec docker compose up -d --no-build
