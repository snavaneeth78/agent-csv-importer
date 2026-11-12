# Submission Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the 7 workspace packages into one `csv-importer/` library, move the demo to `demo/`, run it with `docker compose up`, shorten the README, and build a secret-free zip.

**Architecture:** One package `@distru/csv-importer` with subpath exports per module (`/core`, `/scorers`, `/pg`, `/workers`, `/langgraph`, `/distru`, `/ui`, `/ui/styles.css`). Inside the library, modules import each other by relative path; demo, tests and scripts import by subpath. No behaviour change: tests and eval must match a pre-merge baseline.

**Tech Stack:** npm workspaces, TypeScript source (no build), tsx, Vite, Vitest, Docker Compose, Postgres 16, Node 22.

**Spec:** `docs/superpowers/specs/2026-11-12-submission-packaging-design.md`

## Global Constraints

- Package name `@distru/csv-importer`; subpaths exactly `core`, `scorers`, `pg`, `workers`, `langgraph`, `distru`, `ui`, `ui/styles.css`.
- `react` and `react-dom` are `peerDependencies` of the library (and `devDependencies` of the root so tests/typecheck work); the demo lists them as its own dependencies.
- Top-level layout: `README.md`, `docs/`, `csv-importer/`, `demo/`, `fixtures/`, `tests/`, `scripts/`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`, `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`.
- Docker demo uses stub models unless `USE_REAL_MODELS=1` and keys are passed on the command line.
- The zip never contains `.env`, `demo/.data/`, `node_modules/`, `.git/`, `docs/superpowers/`.
- No git commits unless the user asks; each task ends with a verification checkpoint instead.

## Review Focus

1. **Fresh install from the zip** (no `node_modules`, regenerated lockfile) must install and run — Task 5 verifies from an unzipped temp dir.
2. **Reviewer has `.env`-less checkout** — demo must start with stubs, no crash on missing keys — Task 3 runs compose without any env.
3. **Migrations path after the move** (`store.ts` resolves `../migrations` relative to its own file) — integration tests in Task 2 exercise it.
4. **Server binds `127.0.0.1`; Vite must bind `0.0.0.0` in the container** or the host can't reach :5173 — Task 3 curls from the host.
5. **Eval baseline must be deterministic** — run with `USE_REAL_MODELS=0` before and after, or numbers differ for reasons unrelated to the merge.

---

### Task 1: Record baseline

**Files:**
- Create: `<scratchpad>/baseline/{typecheck,test,eval}.txt` (outside the repo)

- [ ] **Step 1:** `npm run typecheck > baseline/typecheck.txt 2>&1; echo $?` — expected exit 0.
- [ ] **Step 2:** `npm run db:up && USE_REAL_MODELS=0 TEST_DATABASE_URL=postgres://distru:distru@localhost:54329/csv_import npm test > baseline/test.txt 2>&1` — expected `133 passed` (112 unit, 21 integration). If the count differs, record the actual count; that is the baseline.
- [ ] **Step 3:** `USE_REAL_MODELS=0 npm run eval > baseline/eval.txt 2>&1` — record per-fixture precision/recall lines.

### Task 2: Merge packages into `csv-importer/`

**Files:**
- Move: `packages/<m>/src/*` → `csv-importer/src/<m>/` for m in core, scorers, pg, workers, langgraph, distru, ui
- Move: `packages/pg/migrations/` → `csv-importer/migrations/`
- Create: `csv-importer/package.json`; delete `packages/*/package.json` and `packages/`
- Modify: `csv-importer/src/pg/store.ts:24` — `join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations")`
- Modify: every `@distru/csv-importer-<m>` import (51 sites) — inside `csv-importer/src/**` → relative `../<m>/index.ts`; in `apps/`, `tests/`, `scripts/` → `@distru/csv-importer/<m>`; `@distru/csv-importer-ui/styles.css` → `@distru/csv-importer/ui/styles.css`
- Modify: root `package.json` workspaces → `["csv-importer", "apps/*"]`; add `react`, `react-dom`, `@tanstack/react-virtual` to root devDependencies only if typecheck needs them
- Modify: `tsconfig.json` include → `["csv-importer/src", "apps/demo/src", "apps/demo/server", "scripts", "tests"]`

**Interfaces:**
- Produces: `@distru/csv-importer/{core,scorers,pg,workers,langgraph,distru,ui}` and `@distru/csv-importer/ui/styles.css`, each exporting exactly what the old package's `index.ts` / `styles.css` did.

`csv-importer/package.json`:
```json
{
  "name": "@distru/csv-importer",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    "./core": "./src/core/index.ts",
    "./scorers": "./src/scorers/index.ts",
    "./pg": "./src/pg/index.ts",
    "./workers": "./src/workers/index.ts",
    "./langgraph": "./src/langgraph/index.ts",
    "./distru": "./src/distru/index.ts",
    "./ui": "./src/ui/index.ts",
    "./ui/styles.css": "./src/ui/styles.css"
  },
  "dependencies": { "<union of the 7 old dependency maps, minus react/react-dom>": "" },
  "peerDependencies": { "react": "^19.3.1", "react-dom": "^19.3.1" }
}
```

- [ ] **Step 1:** Do the moves with `git mv` where tracked, `mv` otherwise. Rewrite imports with a script; then `grep -rn "csv-importer-" csv-importer apps tests scripts` — expected: no matches except `csv-importer-demo`.
- [ ] **Step 2:** `rm -rf node_modules package-lock.json && npm install` — expected: `node_modules/@distru/csv-importer -> ../../csv-importer`.
- [ ] **Step 3:** `npm run typecheck` — expected exit 0.
- [ ] **Step 4:** Same test command as Task 1 Step 2 — expected same pass count as baseline.
- [ ] **Step 5:** `USE_REAL_MODELS=0 npm run eval | diff - baseline/eval.txt` — expected: only timing/latency lines differ.

### Task 3: Move demo to `demo/` and add Docker

**Files:**
- Move: `apps/demo/` → `demo/` (excluding `.data/`, which is deleted locally — it holds old uploads); remove `apps/`
- Modify: `demo/server/index.ts:19` — env path `../../.env`; comment on line 27 → `demo/.data`
- Modify: `demo/package.json` dev script → `concurrently -k -n server,web "tsx watch server/index.ts" "vite --host ${VITE_HOST:-127.0.0.1}"` (or read host from env in `vite.config.ts`: `server.host: process.env.VITE_HOST ?? "127.0.0.1"` — pick the vite.config one)
- Modify: root `package.json` workspaces → `["csv-importer", "demo"]`; `tsconfig.json` include `demo/src`, `demo/server`; `.gitignore` `.data/` stays
- Modify: `.claude/launch.json` in the parent folder is outside the repo — leave it (it calls `npm run demo`, still valid)
- Create: `Dockerfile`, `.dockerignore`
- Modify: `docker-compose.yml` — add `demo` service

`Dockerfile`: `FROM node:22-slim`, `WORKDIR /app`, copy `package.json package-lock.json csv-importer/package.json demo/package.json` first, `npm ci`, then copy the rest, `EXPOSE 5173`, `CMD ["npm","run","-w","@distru/csv-importer-demo","dev"]`.

`.dockerignore`: `node_modules`, `**/node_modules`, `.env`, `demo/.data`, `.git`, `docs/superpowers`.

`docker-compose.yml` `demo` service: `build: .`, `depends_on: postgres: condition: service_healthy`, `ports: ["5173:5173"]`, environment `DATABASE_URL: postgres://distru:distru@postgres:5432/csv_import`, `VITE_HOST: 0.0.0.0`, `USE_REAL_MODELS: ${USE_REAL_MODELS:-0}`, and pass-through `OPENAI_API_KEY`, `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `LLM_PROVIDER`, `LLM_MODEL`, `JEV_PROVIDER`, `JEV_MODEL`, `LLM_STAGE` as `${VAR:-}`.

- [ ] **Step 1:** Local path still works: `npm run demo`, then `curl -s localhost:5173 | grep -c "Distru CSV Importer"` → `1`; `curl -s localhost:5173/api/...` health or any GET route → 200. Stop it.
- [ ] **Step 2:** `docker compose down && docker compose up --build -d`, wait for healthy, `curl -s localhost:5173 | grep -c "Distru CSV Importer"` → `1`.
- [ ] **Step 3:** In the browser pane at http://localhost:5173: drop `fixtures/messy-200.csv`, say "accept suggestions", "yes", "yes" — expected: card reaches finished, right pane shows the upload JSON. `docker compose logs demo` shows stub models loaded.
- [ ] **Step 4:** `docker compose down`.

### Task 4: README, decisions doc, screenshots

**Files:**
- Create: `docs/decisions.md` — the "Decisions the spec left open" list moved verbatim from README, with a one-line intro
- Create: `docs/screenshots/{1-gate1-mapping,2-gate2-review,3-finished}.png` (+ optional `4-dev-mode-off.png`) taken from the running demo (Task 3 flow), browser pane ~1440 wide
- Rewrite: `README.md` — one screen, in this order:
  1. Title + one sentence on what it is.
  2. **Deliverables** table: UX mockup → `docs/screenshots/` (inline the Gate 1 image) and "the demo is the working mockup"; System design → `docs/system-design.md`; Tech spec → `docs/tech-spec.md`; Loom → `<LOOM_LINK>` placeholder.
  3. **Run it**: `docker compose up` → http://localhost:5173; one line for real models: `USE_REAL_MODELS=1 OPENAI_API_KEY=… TYPESAFE_API_KEY=… docker compose up`; without Docker: Node 22, `npm install && npm run demo`.
  4. **Try it**: 4 short steps with `fixtures/messy-200.csv`; one line listing the other fixtures.
  5. **Use the library**: copy `csv-importer/`, import `@distru/csv-importer/core` etc.; table of the 7 subpaths with one line each (from the old Layout table).
  6. **Tests and eval**: the 3–4 commands.
  7. **Built / not built / next**: short bullets from the current README, paths updated.
  8. Links: `docs/decisions.md`, `docs/api-integration.md`.
- Modify: `docs/*.md` — update any `packages/<m>/...` or `apps/demo` paths to `csv-importer/src/<m>/...` and `demo/` (`grep -rn "packages/\|apps/demo" docs README.md` → no matches outside `docs/superpowers` and `docs/handoffs`).

- [ ] **Step 1:** Write files. **Step 2:** grep above → no matches. **Step 3:** README rendered length ≤ ~120 lines; every relative link resolves (`for each link: test -e`).

### Task 5: Zip script and clean-room check

**Files:**
- Create: `scripts/package.sh`; add `"package": "bash scripts/package.sh"` to root scripts

`scripts/package.sh`: `git ls-files --cached --others --exclude-standard` (respects `.gitignore`, so `.env`, `node_modules`, `.data` are out), filter out `docs/superpowers/`, write `dist/distru-csv-importer.zip` with top folder `distru-csv-importer/`. Then fail if `zipinfo -1` lists any of `.env`, `.data/`, `node_modules/`, `docs/superpowers/`, or if any file contains a line matching `^(OPENAI|TYPESAFE|OPENROUTER|ANTHROPIC)_API_KEY=.+`.

- [ ] **Step 1:** `npm run package` → prints the zip path and size; exit 0.
- [ ] **Step 2:** Unzip into a fresh temp dir; `docker compose up --build -d` there (stop the repo's compose first — same ports); `curl -s localhost:5173 | grep -c "Distru CSV Importer"` → `1`; `docker compose down -v`.
- [ ] **Step 3:** In the same temp dir: `npm ci && npm run typecheck` → exit 0 (proves the lockfile and layout travel).
