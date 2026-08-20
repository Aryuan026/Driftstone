# Driftstone

**Your AI can change. Your history shouldn't have to start over.**

Driftstone turns your own conversation history into **portable, reviewable Warm memory** — while keeping the source evidence attached.

Bring in exported conversations. Let a configured API or an MCP-capable agent help organize them. Review the uncertain pieces instead of silently losing them, then carry the result forward as a portable Warm bundle or a human-readable projection.

**Change the AI. Change the system. Keep the past.**

<!-- UI preview: replace this comment with the live Memory Star Map screenshot/GIF after the final UI lands. -->

The local UI now includes a **Demo / Synthetic data** mode that loads a safe
Memory Star Map without private history or API calls. It also includes a
body-safe cold-start guide for the shared Persona/Soul and language fingerprint
workspace, so source preparation can begin before voice authority is ready.

```text
Conversation history
        ↓
  read · trace · review
        ↓
 Portable Warm memory
        ↓
Markdown / Obsidian · Notion-ready · JSON/JSONL
```

## Why Driftstone?

Most history tools can summarize a conversation. Driftstone is interested in what happens **after** the summary.

### It keeps the evidence

A memory should not become true merely because a model wrote it down. Driftstone keeps bounded source spans, occurrences, digests, and provenance so accepted memory can still point back to where it came from.

### It keeps uncertainty visible

Incomplete, rejected, conflicting, or source-weak material does not need to masquerade as finished memory. Rejected/HOLD ledgers keep those decisions inspectable.

### It treats memory as something you can carry

The public truth is a portable Warm bundle, not a database owned by one chat product, one note app, or one private memory system. Markdown/Obsidian and Notion-ready files are projections of the same underlying artifact.

### It works with humans and agents

You can use the local UI and a configured OpenAI-compatible API, or run the same public workflow headlessly through MCP with an agent such as Codex.

## What is a Warm card?

A Warm card is more than a bag of user facts.

It is a portable memory unit shaped to preserve what may matter later: lived context, a bounded source trail, review state, and a readable memory fragment that can travel without pretending to be a complete private memory system.

Driftstone currently stops at **portable Warm cards + source evidence + review/provenance data**.

## What do you actually get?

The canonical public artifact is a portable Warm bundle:

```text
portable_warm_bundle/
  portable_warm_bundle.json
  source occurrences
  source spans
  manifest digests
  conservation counts
  rejected/HOLD ledger
```

From that same truth, Driftstone can produce local human-readable projections such as:

- Markdown / Obsidian staging files
- Notion-ready CSV / Markdown / JSON files
- portable JSON / JSONL for downstream tools and agents

Synthetic showcase outputs:

- [Demo overview](./examples/synthetic-demo/README.md)
- [Portable Warm preview](./examples/synthetic-demo/portable-warm/portable-warm-preview.json)
- [Markdown / Obsidian projection](./examples/synthetic-demo/obsidian/synthetic-warm-cards.md)
- [Notion-ready CSV](./examples/synthetic-demo/notion-ready.csv)
- [Spreadsheet-style CSV](./examples/synthetic-demo/spreadsheet/warm-cards.csv)

The bundle is designed to stay inspectable:

- source paths are sanitized before entering the portable bundle
- source occurrence/span ids and digests remain checkable
- candidate identity follows stable source lineage rather than per-run task ids or local file locations
- source-incomplete material remains visible instead of pretending to be accepted

## Five-Minute Start

Requirements:

- Node.js 20+
- an OpenAI-compatible API endpoint if you want model-backed generation
- your own exported chat/history files

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

## Human Path

The current human workflow is:

1. Import or prepare your source history.
2. Confirm or draft Persona/Soul and language fingerprint inputs when you want them to guide extraction quality.
3. Run extraction and growth review.
4. Inspect source traces, rejected/HOLD rows, and generated Warm cards.
5. Export the portable Warm bundle and any local projections you want.

If your input is a large ChatGPT `conversations.json`, the current build still uses the legacy lab's conversation exporter for preprocessing. The newer front UI is better suited to already prepared text, Markdown, or Driftstone source packages until the final UI cleanup lands.

For structured ChatGPT JSON, the legacy SQL pass now checks a body-free census
of message coordinates and speaker roles before a user- or assistant-owned fact
can join card aggregation. A model-generated summary from the other speaker is
not silently shifted to an adjacent message: missing, ambiguous, duplicate, or
role-mismatched lineage stays in a local HOLD count. Existing exports are not
rewritten; older artifacts without this census remain unverified when a later
consumer requires exact speaker lineage. SQL facts whose subject cannot be
resolved also stay on HOLD; the legacy non-speaker path remains available only
when the producer explicitly classifies the subject as `other` without
conflicting with its anchor or entity aliases.

The SQL producer contract also treats `source_ref` as the complete evidence
set, not a representative citation. Every message used for a value, note,
causal claim, state change, correction, or outcome must be listed explicitly;
sharing a prepared chunk does not let a later statement inherit an earlier
message's lineage. This strengthens new extraction behavior but does not
retroactively certify old artifacts: semantic support still requires review,
and source-weak historical rows remain reconciliation candidates.

The front UI reads the existing shared persona workspace instead of creating a
second identity store. If that workspace is empty or partial, Driftstone still
allows source preparation, but persona/voice-dependent Warm-card growth stays
guarded until role, Persona/Soul, and language fingerprint authority are ready.

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

Public headless export ends at portable Warm bundles and local projections. Legacy root/vine/finalize tools are hidden from the default catalog and remain diagnostic compatibility surfaces only.

## Inputs And Projections

Typical inputs:

- ChatGPT export-derived windows or month packs
- `.txt` / `.md` conversation logs
- reviewed CSV/JSON/JSONL artifacts from an existing Driftstone run
- optional Persona/Soul and language fingerprint workspace state

Current output/projection surfaces include:

- portable Warm bundle JSON
- source occurrence/span JSON or JSONL
- rejected/HOLD/conservation ledgers
- Markdown or Obsidian staging files
- Notion-ready CSV/Markdown/JSON projection files

Notion support is intentionally projection-only today. Provider writes, Notion patch apply, and Notion-to-bundle roundtrip are not enabled in the public product path yet.

## Privacy And Product Boundaries

Driftstone is local-first. It should not commit source history, API keys, private runtime state, generated private memory, or provider responses to Git.

Public Driftstone does not:

- write Home memory
- write Hippocove Cold tree / roots / relations / vines / cases
- claim Hippocove-compatible memory output without an explicit tested adapter
- include private AsherieSystem schemas, credentials, paths, or corpora
- treat Notion, Obsidian, or any other projection as canonical truth
- turn historical bulk material into unreviewed direct memory writes

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
- synthetic Memory Star Map demo and projection examples

Still pending:

- final human UI / live Memory Star Map polish
- provider-backed Notion write and patch-apply loop
- production release decision

## License

The code and documentation distributed in this repository are licensed under the
Apache License, Version 2.0. Apache-2.0 was chosen to provide clear reuse,
contribution, copyright, and patent terms for this public implementation. The
[LICENSE](./LICENSE) file controls.

## Provenance

Driftstone is an independent public product for extracting and organizing
materials from personal history. Its information-organization approach is
informed in part by concepts developed by A-Yuan through long-term-memory
research.

Separate private datasets, systems, implementations, Hippocove/Cold work, and
unpublished research artifacts are not included in this Work.

Secondary implementation provenance:

- Product direction, review, tuning, and owner decisions: Aryuan026
- Implementation collaboration: Codex in the OpenAI desktop agent environment
- Earlier Obsidian memory-card, Persona memo, and language-fingerprint design work: Claude Code / Anthropic-assisted collaboration
