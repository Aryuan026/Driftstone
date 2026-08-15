# Driftstone Public Productization Roadmap 2026-08-15

This roadmap is for the public Driftstone repository. It is local-first,
agent-friendly, and bounded to portable Warm memory extraction. It must not
import private AsherieSystem, Home, Hippocove Cold tree, or production memory
state into the public product.

## Owner-Locked Product Shape

Driftstone is a general memory extraction workbench for humans and agents.

Canonical public truth:

```text
portable_warm_bundle JSON/JSONL + manifest + source occurrences/spans/digests + rejected/HOLD ledger
```

Allowed projections:

```text
Markdown / Obsidian / Notion / human web UI
```

Projection rule:

```text
Projections are local views of the bundle with review-backflow anchors. They are
not canonical truth, and this public build does not yet apply projection review
patches back to the bundle.
```

Out of public scope:

```text
Home writes
Hippocove Cold tree writes
Cold roots / relation graph / clusters / snapshots / vines
private Asherie schema, paths, receipts, or data
```

Future export adapters such as RikkaHub or ombre-brain may consume portable
Warm cards, but they are not part of the current implementation phase.

Private downstream rule:

```text
Driftstone Studio is a private full-source downstream/superset, not a runtime
dependency shell. It imports one complete runnable public Driftstone
checkpoint, records the upstream commit, and selectively syncs future public
changes inside the private repo. Public Driftstone remains the generic
upstream; Studio import waits for an explicit reviewed public checkpoint.
```

## Operating Rules

- Work in the clean carrier worktree:
  `<clean-public-driftstone-worktree>`
- Do not edit the dirty main checkout:
  `<legacy-dirty-driftstone-checkout>`
- Do not commit raw history, private corpora, API keys, runtime cache, Notion
  credentials, or generated private memory.
- External API validation is allowed only as a runtime secret. Keys must be
  supplied through environment/config at run time and must never be committed or
  printed in reports.
- The owner's first-month history may be used for local experimental validation,
  but reports must summarize counts and quality findings without reproducing
  private source text.
- After a phase passes local checks, the controller may commit and push the
  public branch without asking for repeated authorization.

## Controller / Sub-Agent Model

The main Codex window acts as controller:

- keeps product boundary and phase order stable
- assigns narrow, disjoint tasks to sub-agents
- reviews every patch before integration
- runs focused checks
- decides whether a phase is checkpoint-ready
- commits and pushes only after a phase is Green

Sub-agents should receive bounded tasks with disjoint write scopes. They should
not independently change product boundaries, import private data, write Notion,
call Home/Hippocove, or push.

Recommended sub-agent lanes:

- `server-modularization`: MCP catalog/dispatch/transport and tool facade split
- `bundle-contract-export`: portable Warm bundle builder, validator, ledger,
  source occurrence/span/digest
- `agent-workflow-docs`: MCP/CLI/skill-facing instructions and examples
- `projection-exporters`: Markdown/Obsidian/Notion local projection exports
- `ui-cleanup`: human UI after core and agent workflow stabilize

## Phase 0 - Stabilize Public Boundary Checkpoint

Goal:

Turn the current local public-boundary patch into a clean checkpoint.

Current known dirty scope:

```text
server/mcp-server.js
server/core/mcp-tool-service.js
server/package.json
server/core/portable-warm-bundle-contract.js
server/tests/portable-warm-bundle-contract.test.js
docs/DRIFTSTONE_PUBLIC_PRODUCTIZATION_BLOCK_20260815.md
docs/DRIFTSTONE_PRODUCTIZATION_ROADMAP_20260815.md
```

Acceptance:

- `get_portable_warm_bundle_contract` is available through MCP.
- `validatePortableWarmBundle` rejects Home/Hippocove direct-write authority and
  Cold graph lineage fields.
- No private text, key, or production path is committed.
- Focused checks pass:
  - `npm run test:contracts`
  - `node --check server/mcp-server.js`
  - `node --check server/core/mcp-tool-service.js`
  - `node --check server/core/portable-warm-bundle-contract.js`
  - `git diff --check`

Checkpoint:

Commit and push after Green.

## Phase 1 - Modularize Agent Entry Without Behavior Change

Goal:

Make MCP/agent work maintainable before adding more product behavior.

Refactor targets:

```text
server/mcp-server.js
server/core/mcp-tool-service.js
```

Proposed shape:

```text
server/mcp/tool-catalog.js
server/mcp/tool-dispatch.js
server/mcp/stdio-transport.js
server/mcp/tools/runtime-tools.js
server/mcp/tools/persona-tools.js
server/mcp/tools/growth-tools.js
server/mcp/tools/review-tools.js
server/mcp/tools/contract-tools.js
```

Rules:

- Preserve existing MCP tool names and schemas unless explicitly deprecated.
- Do not add a parallel summarizer.
- Do not change runtime behavior in this phase.
- Mark old root/vine write tools as legacy/compat in descriptions, but do not
  delete them until replacement export path exists.

Acceptance:

- MCP list/call smoke still works.
- Contract tests still pass.
- Diffs are mostly file moves and import rewiring.

Checkpoint:

Commit and push after Green.

## Phase 2 - Public Route And Tool Boundary Cleanup

Goal:

Stop advertising old Cold-ish write paths as the public product route.

Targets:

```text
server/routes/registry.js
server/routes/product/README.md
docs/HIPPOCOVE_MCP_AGENT_HANDOFF.md
docs/HIPPOCOVE_TECH_HANDOFF.md
README.md
server/README.md
```

Work:

- Rename public-facing language from Hippocove/Cold/root/vine where it describes
  the public product.
- Move `memory-write`, `finalize_reviewed_entries`, roots/vines materialization
  to legacy/diagnostic/compat wording.
- Keep compatibility routes alive until replacement export is available.
- Document that public Driftstone emits portable Warm bundles, not Home or Cold
  tree writes.

Acceptance:

- Agent route catalog no longer tells callers that Driftstone's public endpoint
  writes final roots/vines.
- Human docs describe local app + portable Warm bundle + projections.
- No behavior-breaking route deletion.

Checkpoint:

Commit and push after Green.

## Phase 3 - Bring In CSV Conservation Green Patch

Goal:

Port the proven generic CSV/conservation hardening into the public product.

Source checkpoint:

```text
codex/driftstone-csv-ledger@042764d
```

Likely reusable files:

```text
server/core/csv-reader.js
scripts/debug/regression_reviewed_csv_conservation.mjs
scripts/debug/build_home_import_review_rows.mjs
```

Adaptation rules:

- Keep generic CSV parsing and conservation logic.
- Do not import private Home-specific packet semantics into public main.
- Replace any Home import naming with public review/export naming.
- Fail closed on malformed CSV and JSON/JSONL parse errors.
- Write rejected/conservation ledger instead of silently carrying bad rows.
- Require explicit source directory/month; no default fake all-month input.

Public implementation scope:

- `server/core/csv-reader.js` owns quoted multiline parsing and malformed CSV
  diagnostics.
- `scripts/debug/regression_reviewed_csv_conservation.mjs` is a local diagnostic
  for user-supplied reviewed CSV directories only.
- The script may verify private 13-month counts when the owner points it at
  private data, but those paths and counts are not public fixtures or canonical
  repo truth.
- Home import review-row/customs packet generation is not part of public main.

Acceptance:

- Quoted multiline CSV passes.
- Malformed CSV fails closed with diagnostics.
- Conservation counts are stable for synthetic fixtures.
- Old successful output cannot masquerade as a failed current run.

Checkpoint:

Commit and push after Green.

## Phase 4 - Portable Warm Bundle Builder

Goal:

Make existing extraction results emit the canonical public artifact.

Targets:

```text
server/core/portable-warm-bundle-contract.js
server/core/portable-warm-bundle-builder.js
server/core/source-occurrence-service.js
server/core/source-span-service.js
server/core/review-ledger-service.js
server/tests/portable-warm-bundle-builder.test.js
```

Work:

- Convert reviewed/growth outputs into `driftstone_portable_warm_bundle_v0`.
- Preserve original source occurrence, bounded span, digest, and rejected/HOLD
  entries.
- Keep `portable_warm_card` fields stable:
  `body_markdown`, `living_fragment`, `feeling_as_fact`, `future_use_hint`,
  `voice_fingerprint_refs`, `persona_refs`.
- Add a local export path and MCP caller.

Rules:

- Driftstone may create portable Warm cards.
- Driftstone must not create Home canonical `body_markdown` with private persona
  authority.
- Driftstone must not claim source evidence if the source span is not bounded
  and recoverable.

Acceptance:

- Synthetic bundle validates.
- Source-incomplete rows are visible in rejected/HOLD or quality flags.
- No Cold graph fields appear in bundle output.

Checkpoint:

Commit and push after Green.

## Phase 5 - Agent Workflow First

Goal:

Make Codex/Hermes-style agents able to run Driftstone headlessly.

Workflow verbs:

```text
prepare
run
resume
inspect
review
export
validate
```

Work:

- Expose the verbs through MCP and, where useful, a local CLI wrapper.
- Add agent-readable docs/skill instructions.
- Keep human approval before Notion write.
- Keep API use optional and runtime-configured.

Acceptance:

- An agent can start from user files, inspect status, resume interrupted work,
  export a portable bundle, and summarize rejected/HOLD rows without opening the
  human UI.
- Agent docs do not contain private endpoints, keys, or corpus text.

Checkpoint:

Commit and push after Green.

## Phase 6 - Local Projection Exporters

Goal:

Generate human/Chat-readable projections from the same bundle.

Projection targets:

```text
Markdown / Obsidian
Notion-ready CSV or JSONL
optional local HTML preview
```

Notion rule:

Notion is a projection and review surface. It is not canonical truth.

Notion planning requirements:

- stable candidate id to notion page id identity map
- projection sync hash
- local review patch import by candidate id + base digest
- source occurrences/spans visible as bounded evidence only
- no provider write unless the human explicitly requests that action in the
  current runtime flow

Acceptance:

- Bundle can regenerate projection deterministically.
- Review patch validation/apply is not implemented in this public build; until
  it lands, projection exports are one-way local files with candidate_id/sync
  hash anchors only.
- No Notion write occurs during ordinary export.

Checkpoint:

Commit and push after Green.

## Phase 7 - Human UI Cleanup

Goal:

Make the UI good-looking and maintainable after the core workflow is stable.

Targets:

```text
ui/app.js
ui/bridges/*
legacy/index.html
```

Direction:

- Human UI observes the same state machine used by agent tools.
- Avoid a second processing path.
- Gradually split `ui/app.js` into state, API client, render panels, and export
  helpers.
- Freeze or archive legacy workbench surfaces that are no longer primary.

Acceptance:

- UI can run the same prepare/run/resume/inspect/review/export flow.
- Visual language improves without changing artifact semantics.
- Human actions and agent actions leave the same ledgers.

Checkpoint:

Commit and push after Green.

## Phase 8 - Future Format Adapters

Goal:

Let other memory systems consume portable Warm cards without changing the core.

Possible adapters:

```text
RikkaHub import format
ombre-brain batch import
Claude/exported history adapters
plugin-specific source adapters
```

Rules:

- Adapters consume `portable_warm_bundle`.
- Adapters do not fork extraction, review, source binding, or quality algorithms.
- Source adapters may normalize input format, but the core owns review and
  conservation.

## Checkpoint Report Template

Each pushed phase should report:

```text
Branch:
Commit:
Files changed:
What changed:
What did not change:
Checks:
Known risks:
Next phase:
```

## Current P0/P1 Risks

P0:

- None known for the current local export-only public endpoint after the
  portable Warm bundle, inspector, local projection exporter and Driftstone
  agent workflow docs landed.

P1:

- The CSV/conservation Green patch from `codex/driftstone-csv-ledger@042764d`
  still needs a public-product port before Driftstone can claim hardened
  all-month CSV import quality.
- Product naming still has legacy `HIPPOCOVE_*` filenames and double-click
  scripts for compatibility; current entry docs now route agents through
  Driftstone-named workflow docs.
- `path-config` creates runtime directories on import, which is awkward for pure
  inspect/validate tools.
- No root `LICENSE` or `NOTICE` file is present in the inspected public worktree.
  Release remains HOLD until owner chooses and adds licensing files.
- UI and legacy workbench remain large monoliths, but should wait until agent
  workflow stabilizes.
