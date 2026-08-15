# Driftstone

Driftstone is a local-first memory extraction workbench: it turns a user's own conversation history into portable Warm cards with source occurrence, bounded source spans, digests, manifests, and rejected/HOLD ledgers.

It is not a Home/Hippocove writer, not a Cold tree, and not a second truth layer. JSON/JSONL, Markdown/Obsidian, and Notion-ready exports are projections of the portable Warm bundle.

## Five-Minute Start

Requirements:

- Node.js 20+
- A local OpenAI-compatible API endpoint if you want AI generation
- Your own exported chat/history files

From the repository root:

```bash
cd server
npm install
npm run start
```

Open:

- Front UI: <http://127.0.0.1:3460/>
- Legacy lab: <http://127.0.0.1:3460/legacy/index.html>
- Health check: <http://127.0.0.1:3460/api/health>

Desktop helper scripts are also included:

- macOS: `00_双击启动_Driftstone.command`
- Windows: `00_双击启动_Driftstone.cmd`

The old `Hippocove`-named launch scripts remain compatibility aliases; Driftstone is the public product name.

## Human Path

1. Import or prepare your source history.
2. Build Persona/Soul and language fingerprint first. They are quality inputs, not decorative settings.
3. Run extraction/growth review.
4. Inspect source traces, rejected/HOLD rows, and generated Warm cards.
5. Export a portable Warm bundle and optional Markdown/Obsidian/Notion-ready projection.

If your input is a large ChatGPT `conversations.json`, use the legacy lab's conversation exporter first. The newer front UI is better for already prepared text, markdown, or Driftstone source packages.

## Agent Path

Driftstone exposes a headless MCP workflow for agents such as Codex:

```bash
cd server
npm run mcp
```

Recommended agent verbs converge on:

```text
prepare -> run/pull -> submit/review -> inspect -> validate -> export
```

Read the agent guide:

- [docs/DRIFTSTONE_AGENT_HEADLESS_WORKFLOW.md](./docs/DRIFTSTONE_AGENT_HEADLESS_WORKFLOW.md)

Public headless export should end at portable Warm bundles and local projections. Legacy root/vine/finalize tools are hidden from the default catalog and are only diagnostic compatibility surfaces.

## Canonical Output

The canonical public artifact is:

```text
portable_warm_bundle/
  portable_warm_bundle.json
  source occurrences
  source spans
  manifest digests
  conservation counts
  rejected/HOLD ledger
```

The bundle is built to be portable:

- source paths are sanitized before entering the bundle
- source occurrence/span ids and digests remain checkable
- candidate identity is based on stable source lineage, not per-run task ids or local file locations
- source-incomplete rows stay visible instead of pretending to be accepted

Markdown, Obsidian, and Notion-ready exports are local projections. They are useful for reading and review, but they are not canonical truth.

## Inputs And Projections

Typical inputs:

- ChatGPT export-derived windows or month packs
- `.txt` / `.md` conversation logs
- reviewed CSV/JSON/JSONL artifacts from an existing Driftstone run
- optional Persona/Soul and language fingerprint workspace state

Typical outputs:

- portable Warm bundle JSON
- source occurrence/span JSON or JSONL
- rejected/HOLD/conservation ledgers
- Markdown or Obsidian staging files
- Notion-ready CSV/Markdown/JSON projection files

Notion support is intentionally projection-only today. Provider writes, Notion patch apply, and Notion-to-bundle roundtrip are not enabled in the public product path yet.

## Privacy And Boundaries

Driftstone is local-first. It should not commit source history, API keys, private runtime state, generated private memory, or provider responses to Git.

Public Driftstone does not:

- write Home memory
- write Hippocove Cold tree / roots / relations / vines / cases
- include private AsherieSystem schemas, credentials, paths, or corpora
- treat Notion as canonical truth
- turn historical bulk material into direct warm memory writes

Private downstream systems may consume reviewed Driftstone artifacts, but that is outside this public repository.

## Current Status

Usable now:

- local backend and front UI
- legacy lab for source import and inspection
- Persona/Soul and language fingerprint workspace
- reviewed/growth workflow
- portable Warm bundle builder, validator, inspector, and projection exporter
- MCP/headless workflow
- source conservation, rejected/HOLD ledger, and identity regression tests

Still pending:

- final human UI polish
- provider-backed Notion write and patch-apply loop
- production release decision

## License

Driftstone is licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Provenance

Driftstone was shaped through human/AI pair development.

- Product direction, review, tuning, and owner decisions: Aryuan026
- Implementation collaboration: Codex in the OpenAI desktop agent environment
- Earlier Obsidian memory-card, Persona memo, and language-fingerprint design work: Claude Code / Anthropic-assisted collaboration

Please preserve this provenance if you study or adapt the project.
