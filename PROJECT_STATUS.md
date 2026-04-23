# Hippocove Project Status

Last updated: 2026-04-19

## Release Position

- Stage: Open alpha / experimental workbench
- Intended publish folder: `0-github/202604-Hippocove`
- Intended publish style: repo + GitHub Pages + local backend + MCP

## What Is Stable Enough To Publish

- Local-first front page and legacy workbench coexist
- Runtime backend serves UI, API, and MCP from one local entry
- Ingest -> reviewed -> growth -> export main chain is connected
- Persona workspace is backend-backed, not only browser-local
- Growth draft / registry / ledger are connected
- Trace + discard report + human merge guidance exist
- Obsidian markdown export works
- MCP can drive the workflow as tools instead of manual rereading

## What Is Still Intentionally Experimental

- UI is still being tuned for human feel
- Model-specific warmth / voice quality is not universal
- Legacy workbench still carries real production weight
- Some SQL / Persona alignment is heuristic rather than fully semantic
- Open-source defaults should be treated as starting points, not final taste

## Publish Intention

This repo is being published as a half-finished but already working memory workbench.
The point is not “perfect defaults.”
The point is to let other people:
- understand the architecture,
- keep the trace chain intact,
- swap in their own models and prompts,
- and continue tuning for their own memory style.

## Main Entry Points

- `docs/index.html` — GitHub Pages landing page
- `index.html` — front page UI
- `legacy/index.html` — old workbench for inspection and tuning
- `server/index.js` — local unified backend entry
- `server/mcp-server.js` — MCP entry for agents

## Authorship

- Human lead / tuning / direction: 阿鸢
- AI co-developer / implementation partner: Codex（OpenAI GPT-5，桌面代理协作环境）
