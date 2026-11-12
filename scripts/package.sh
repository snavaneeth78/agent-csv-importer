#!/usr/bin/env bash
# Builds dist/distru-csv-importer.zip from an allowlist of paths, taking only files git would track (so .env,
# node_modules and demo/.data stay out), then checks that no env files or secret values made it in.
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=distru-csv-importer
OUT="dist/$NAME.zip"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p dist "$STAGE/$NAME"
# Allowlist: only these paths ship, and only files git would track (so ignored files stay out).
ALLOW='^(csv-importer|demo|fixtures|scripts|tests)/|^docs/[^/]+\.md$|^docs/screenshots/|^(README\.md|Dockerfile|\.dockerignore|docker-compose\.yml|\.env\.example|\.gitignore|package\.json|package-lock\.json|tsconfig\.json|vitest\.config\.ts)$'
git ls-files --cached --others --exclude-standard | grep -E "$ALLOW" | while IFS= read -r f; do
  if [ -e "$f" ]; then mkdir -p "$STAGE/$NAME/$(dirname "$f")"; cp -p "$f" "$STAGE/$NAME/$f"; fi
done

rm -f "$OUT"
(cd "$STAGE" && zip -qr - "$NAME") > "$OUT"

# Secret checks: no env files or local data, and no real key value from a local .env.
bad=$(zipinfo -1 "$OUT" | grep -E '(^|/)\.env($|\.)|/\.data/|node_modules/|/docs/(superpowers|handoffs)/|\.superpowers/|(^|/)(CLAUDE|AGENTS)\.md$|/\.claude/' | grep -v "^$NAME/\.env\.example$" || true)
if [ -n "$bad" ]; then echo "refusing: zip contains:"; echo "$bad"; rm -f "$OUT"; exit 1; fi
if [ -f .env ]; then
  while IFS='=' read -r k v; do
    v="${v%%#*}"; v="$(echo "$v" | tr -d '[:space:]')"
    [[ "$k" == *_KEY && ${#v} -ge 8 ]] || continue
    if grep -rqF -- "$v" "$STAGE/$NAME"; then echo "refusing: value of $k found in the zip"; rm -f "$OUT"; exit 1; fi
  done < <(grep -E '^[A-Z_]+=' .env)
fi

grep -q "<LOOM_LINK>" README.md && echo "warning: README.md still has the <LOOM_LINK> placeholder"
echo "$OUT ($(du -h "$OUT" | cut -f1), $(zipinfo -1 "$OUT" | grep -vc '/$') files)"
