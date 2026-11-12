# Submission packaging — design (approved 2026-11-12)

## Why
Reviewer should see the four deliverables first, run the demo with one command, and be able to copy the library into
their own repo. README short and human.

## Goals / non-goals
- Goals: one library folder; `docker compose up` runs the demo; one-screen README with deliverables first; reproducible zip
  with no secrets.
- Non-goals: publishing to npm; a build step; changing library behaviour.
- Anti-goals: shipping `.env` keys or old uploads; a merge that changes test or eval results.

## Approaches
1. **One package, subpath exports per module (picked).** `@distru/csv-importer/{core,scorers,pg,workers,langgraph,distru,ui}`.
   Keeps the server/browser split (no React in the server, no pg in the browser).
2. One package, single `index.ts` — rejected: mixes React and pg into every import.
3. Keep 7 packages under a `csv-importer/packages/` folder — rejected: not really one thing to copy.

## Design
- `csv-importer/`: `package.json` (name `@distru/csv-importer`, union of deps, react/react-dom as peer deps),
  `migrations/`, `src/<module>/`. Inside the library, modules import each other relatively; outside, by subpath.
- Top level: `README.md`, `docs/` (+ `decisions.md`, `screenshots/`), `csv-importer/`, `demo/` (moved from `apps/demo`),
  `fixtures/`, `tests/`, `scripts/`, `Dockerfile`, `docker-compose.yml`, `.env.example`.
- Docker: compose runs postgres + demo (Node 22). Stub models by default; real ones via env keys on the command line.
  `npm install && npm run demo` still works.
- README: deliverables (mockup screenshots, system design, tech spec, Loom placeholder) → run → built / not built / next.
  "Decisions the spec left open" moves to `docs/decisions.md`.
- `npm run package`: allowlisted zip (no `.env`, `.data/`, `node_modules/`, `.git/`, `docs/superpowers/`), then
  unzip to a temp dir and `docker compose up` to verify.
- Verify after the merge: typecheck, all tests, eval numbers equal to the pre-merge baseline.

## Left to the builder
Exact Dockerfile details, screenshot choice, script language for packaging.
