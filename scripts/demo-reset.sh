#!/usr/bin/env bash
# Wipes everything the local demo (`npm run demo`) remembers, so the next start is a first run:
#   - Postgres: every import, its rows and events, the mapping memory, and the job queue (the container and its volume)
#   - demo/.data: the chat history and uploaded files
# Run: npm run demo:reset   (or npm run demo:fresh to reset and start). Stop `npm run demo` first.
# The Docker-only demo (`bash start.sh`) is a separate compose project; reset it with `docker compose down -v`.
set -euo pipefail
cd "$(dirname "$0")/.."

if (exec 3<>/dev/tcp/127.0.0.1/8787) 2>/dev/null; then
  echo "The demo server is still running on port 8787. Stop it (Ctrl+C in its terminal), then run this again."
  exit 1
fi

docker compose -f docker-compose.yml -f docker-compose.dev.yml down -v --remove-orphans
rm -rf demo/.data
echo "Demo reset: database and chat cleared. Start it with: npm run demo"
echo "Already have the demo open in a browser tab? Reload it once it's running."
