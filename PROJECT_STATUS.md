# Driftstone Project Status

Last updated: 2026-08-15

## Release Position

- Stage: Open alpha / experimental workbench
- Release gate: HOLD until owner chooses the final open-source license; no license grant is committed for formal release yet.
- Intended publish folder: public Driftstone repo
- Intended publish style: repo + GitHub Pages + local backend + MCP
- Public product boundary: portable Warm bundle + source occurrence/span/digest + manifest + rejected/HOLD ledger
- Private boundary: Home/Hippocove cold tree, root/vine/case graph, private runtime data, and canonical memory writes stay outside this repo

## What Is Stable Enough To Publish

- Local-first front page and legacy workbench coexist
- Runtime backend serves UI, API, and MCP from one local entry
- Ingest -> reviewed -> growth -> export main chain is connected
- Persona workspace is backend-backed, not only browser-local
- Growth draft / registry / ledger are connected
- Trace + discard report + human merge guidance exist
- Obsidian markdown export works
- MCP can drive the workflow as tools instead of manual rereading
- Portable Warm bundle contract is documented and exposed to agents

## What Is Still Intentionally Experimental

- UI is still being tuned for human feel
- Model-specific warmth / voice quality is not universal
- Legacy workbench still carries real production weight
- Some SQL / Persona alignment is heuristic rather than fully semantic
- Old roots/vines/finalize paths still exist as legacy/diagnostic compatibility
- Open-source defaults should be treated as starting points, not final taste

## Publish Intention

This repo is being published as a half-finished but already working memory workbench.
The point is not “perfect defaults.”
The point is to let other people:
- understand the architecture,
- keep the trace chain intact,
- swap in their own models and prompts,
- and continue tuning for their own memory style.

The public repo should not be read as a Home/Hippocove cold-tree product. Markdown,
Obsidian, and Notion are projections of Driftstone artifacts, not canonical truth.

## Main Entry Points

- `docs/index.html` — GitHub Pages landing page
- `index.html` — front page UI
- `legacy/index.html` — old workbench for inspection and tuning
- `server/index.js` — local unified backend entry
- `server/mcp-server.js` — MCP entry for agents

## Authorship

- Human lead / tuning / direction: 阿鸢
- AI co-developer / implementation partner: Codex（OpenAI GPT-5，桌面代理协作环境）
