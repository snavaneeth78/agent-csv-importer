# Handoff: System Design Doc

**Goal:** write `docs/system-design.md`, deliverable #2 of the Distru take-home.

## Read first

1. The brief: `../../distru-take-home.pdf`, i.e. `5_distru/distru-take-home.pdf`.
2. The approved importer spec: `docs/tech-spec.md`. It is final. Don't change it; link to it.

## What the brief asks for

> "describe how you would architect the harness to support this use case (and beyond)" — the reviewer is
> judging **agentic harness design**.

The harness has to power two products:
1. **Automated workflows:** cron or user-action triggers, connected to the customer's operational software
   (Distru, QuickBooks, Calendar, Sheets…).
2. **A Copilot chat** (Claude Cowork style), using the Distru MCP plus the customer's connected MCP servers.

The CSV importer is the first feature. The design has to show how it plugs in, and how the next ten
features would plug in the same way.

The reviewer looks for: product taste, edge-case thinking, MVP pragmatism, agentic harness design,
engineering fundamentals, and clear convictions. **No "up to the product team" decisions. No LLM prose
bloat.** The doc should be short, with diagrams that carry the weight.

## Already decided (from the tech spec, don't re-litigate)

- **Stack:** TypeScript, LangGraph.js, Postgres. Distru's app is React + GraphQL.
- **Importer shape:** a schema-agnostic library exposed as `import_csv_*` LangGraph tools.
  - Deterministic matching first, then **Jev** (TypeSafe's fast decision model) for scoring, then a
    bring-your-own LLM as the last resort.
  - The LLM produces a plan; code applies it to every row.
- **Durability:** pg-boss jobs on Postgres. Tool calls return immediately; the UI polls by `importId` and
  resumes after a reload.
- **Gates:** two required human gates, mapping and import. The library never auto-approves. The harness
  only decides how the confirmation is collected (a card button or a chat "yes"). Workflows park at the
  gate and notify the user.
- **Tenancy:** `tenantId` and `actor` come from the harness run context, never from model arguments.
- **No new API is built.** The importer ships SQL migrations plus an integration guide for Distru's
  existing API.
- **Distru MCP gaps:** no SKU filter and no batch update. The importer works around them with a catalog
  snapshot and rate-limited follow-up calls. Proposed cheap MCP additions: `find-products-by-skus` and a
  batch update.

## What the doc must cover

1. **Harness architecture diagram** (Mermaid): entry points (chat, triggers), agent runtime, tool layer
   (Distru MCP, customer MCPs, first-party tools like the importer), job queue, Postgres, event stream to
   the UI.
2. **One runtime, two modes.** How Copilot and Workflows share the same graph, tools and gates, and what
   differs: who answers a gate, notifications, timeouts.
3. **Tool model.** First-party library tools vs MCP tools. Naming, per-tenant tool registry, auth and
   credential scoping per connected MCP, tool result size limits.
4. **Durable execution and human in the loop.** LangGraph checkpointer + `interrupt()` vs pg-boss jobs:
   which handles what, and how a parked gate resumes (chat reload, workflow notification).
5. **The CSV import walkthrough**, end to end through the harness:
   - a sequence diagram for the Copilot case;
   - the "nightly Google Sheet → new products" workflow case.
6. **Model strategy.** Jev for routing and scoring decisions, the LLM for open-ended work, BYO model,
   cost and latency reasoning.
7. **Safety.** Tenant isolation, prompt injection from tool output and files, confirmation for
   side-effecting tools, audit log.
8. **Observability.** Run traces, events table, metrics, evals (the importer's matching eval as the
   template).
9. **Extending it.** A short list of the next features and how each reuses these pieces, e.g. a lab result
   PDF attached to inventory (the brief's example), or vendor import.
10. **MVP cut vs later**, as a short table.

## Decisions still open (ask the user; recommend first)

- Workflow definition format: (rec) a typed graph template plus parameters, rather than free-form agent
  plans.
- Where the harness runs: (rec) a separate Node service next to the Distru API, sharing Postgres.
- Gate notifications for workflows: (rec) an in-app inbox plus email.
- LangGraph checkpointer: (rec) `PostgresSaver` in the same database.

## Output and process

- Write `docs/system-design.md`, about 3–5 pages, using Mermaid for every diagram.
- Show the user the outline first, then iterate section by section.
- Commit with git when the user approves (one commit per new deliverable).
