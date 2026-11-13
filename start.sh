#!/usr/bin/env bash
# Starts the demo in Docker, waits until it answers, and opens it in your browser.
# Uses port 5173, or the next free one if that's taken (WEB_PORT=... to choose). Ctrl+C stops it.
# Run: bash start.sh            (same as `docker compose up --build`, plus the port pick and the browser tab)
set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null || { echo "Docker is needed: https://docs.docker.com/get-docker/"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is installed but not running. Start Docker Desktop and try again."; exit 1; }

in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# Already running from this folder? Keep its port. Otherwise take 5173 or the next free port.
running=$(docker compose port demo 5173 2>/dev/null | sed 's/.*://' || true)
if [ -n "${WEB_PORT:-}" ]; then PORT=$WEB_PORT
elif [ -n "$running" ]; then PORT=$running
else
  PORT=5173
  while in_use "$PORT"; do
    PORT=$((PORT + 1))
    [ "$PORT" -gt 5199 ] && { echo "Ports 5173-5199 are all in use. Set WEB_PORT to a free port."; exit 1; }
  done
  [ "$PORT" != 5173 ] && echo "Port 5173 is in use, so the demo will use $PORT."
fi
URL="http://localhost:$PORT"

# Not running? Clear containers left by an earlier failed start (they can come back without their network).
[ -z "$running" ] && WEB_PORT=$PORT docker compose down --remove-orphans >/dev/null 2>&1 || true
WEB_PORT=$PORT docker compose up -d --build
trap 'echo; echo "Stopping the demo..."; WEB_PORT=$PORT docker compose stop; exit 0' INT TERM

# The container starts before the app inside it: wait for the web page and the API behind it.
printf "Waiting for the demo at %s " "$URL"
for _ in $(seq 1 120); do
  if curl -fs -o /dev/null "$URL/" && curl -fs -o /dev/null "$URL/api/threads/startup-check/messages"; then ready=1; break; fi
  printf "."; sleep 1
done
echo
if [ -z "${ready:-}" ]; then echo "The demo didn't answer within 2 minutes. Logs: docker compose logs demo"; exit 1; fi

echo "Demo ready: $URL"
if command -v open >/dev/null; then open "$URL"                    # macOS
elif command -v xdg-open >/dev/null; then xdg-open "$URL" >/dev/null 2>&1 &   # Linux
elif command -v cmd.exe >/dev/null; then cmd.exe /c start "$URL"    # WSL
else echo "Open $URL in your browser."; fi

echo "Showing logs. Ctrl+C stops the demo."
WEB_PORT=$PORT docker compose logs -f --since 0s demo
