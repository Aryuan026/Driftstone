# Driftstone Public Productization Block 2026-08-15

This block is local-only and code-grounded. It does not read private corpus text,
write Notion, write Home, write Hippocove, deploy, commit, or publish.

## Product Boundary

Public Driftstone is the portable history-processing workbench. It may read a
user's own history plus optional persona and language fingerprint, then produce
reviewable portable Warm cards with source occurrence/span/digest, manifest, and
rejected/HOLD ledger.

Public Driftstone must not own or imply ownership of Hippocove Cold tree
structures: no Cold root/relation/cluster/snapshot/vine writer, no Home or
Hippocove writes, and no private Asherie schema/path/data.

Canonical truth for the public product is:

```text
portable_warm_bundle JSON/JSONL + manifest + rejected/HOLD ledger
```

Markdown, Obsidian, Notion, and human web views are reversible projections, not a
second source of truth.

## Files Read

- `README.md`
- `server/README.md`
- `package.json`
- `server/package.json`
- `server/index.js`
- `server/mcp-server.js`
- `server/routes/registry.js`
- `server/routes/product/memory-reviewed.js`
- `server/routes/product/memory-write.js`
- `server/core/mcp-tool-service.js`
- `server/core/memory-reviewed-service.js`
- `server/core/memory-write-service.js`
- `server/core/translation-contract.js`
- `server/core/translation-ai-contract.js`
- `server/core/persona-workspace-service.js`
- `server/core/growth-generate-service.js`
- `server/core/obsidian-export-service.js`
- `server/core/reviewed-store.js`
- `server/core/path-config.js`
- `legacy/index.html` targeted Notion split/placeholder ranges
- `docs/HIPPOCOVE_MCP_AGENT_HANDOFF.md`
- `docs/HIPPOCOVE_TECH_HANDOFF.md`
- `data/README.md`

No license file was found under the public worktree root at max depth 3.

## Retain / Adapt / Archive / Remove

| Surface | Verdict | Why |
| --- | --- | --- |
| Raw ingest, source normalization, translation tasks | Retain | This is the real local-state pipeline and agent handoff base. |
| Persona workspace and language fingerprint | Retain | Public Driftstone needs optional persona/fingerprint as input authority for Warm extraction. |
| Growth task/generate draft chain | Retain | This is the stress-tested Warm-card generation path; do not replace with a parallel summarizer. |
| Obsidian export and memo compaction | Adapt | Reuse as Markdown/Obsidian projection, but rename/reshape around portable Warm cards and source spans. |
| Reviewed clustering / source preservation | Adapt | Keep as review/dedup/conservation layer; do not let finalize imply Cold tree write. |
| MCP prepare/pull/submit/inspect tools | Adapt | Keep headless state machine; add portable bundle inspect/export/review tools. |
| UI front page and legacy workbench | Adapt | Human UI should observe/review the same owner service used by MCP, not duplicate algorithm flow. |
| Notion split/profile placeholder in legacy UI | Adapt | Keep as projection planning surface; no Notion write until projection contract and explicit user connection exist. |
| `memory-write-service` roots/vines materialization | Archive from public main path | It writes SQL roots/vines and belongs to old Cold-ish lineage, not public Warm bundle truth. |
| `finalize_reviewed_entries` writing roots/vines | Archive from public main path | Safe only as old compatibility/debug path; public headless flow should export review bundles instead. |
| `root-store`, `vine-store`, materializers | Archive or isolate | Useful migration reference, but must not be advertised as public Driftstone destination. |
| `family`/`case`/`fact` card type names in projections | Adapt | Can survive as local labels only; must not imply private Hippocove graph types. |
| Home/Hippocove destination chain | Remove from public product scope | Private AsherieSystem owns canonical review/routing/apply; Hippocove owns typed Cold/Case graph. |

## Human / Agent Gap Map

| Need | Current code-grounded state | Gap |
| --- | --- | --- |
| Human can start local app | Present via README scripts and desktop shell docs | Product name/docs still say Hippocove and mix workbench/cold-tree language. |
| Human can inspect card/source projections | Present for Obsidian; partial for legacy reviewed split | No public portable Warm bundle index; Notion only placeholder/split profile. |
| Agent can prepare/pull/submit tasks | Present in MCP | Finalize still points to roots/vines; no portable Warm bundle export caller yet. |
| Agent can inspect product contract | Added in this block via `get_portable_warm_bundle_contract` | Export/review/run/resume tool names still need public Driftstone naming pass. |
| Agent can validate portable bundle | Added in this block as focused core validator | Existing generators do not yet emit this bundle shape. |
| Source readback | Present in rows/snippets/Obsidian traces | Needs a public occurrence/span/digest bundle writer and conservation ledger. |
| Privacy and local default | Mostly present as local backend | `path-config` imports create local directories; pure inspect/export should avoid incidental writes. |
| Notion review backflow | Not implemented | Need candidate_id/page_id/sync_hash review patch roundtrip before any provider write. |

## Frozen Public Artifact Contract

The first public contract is implemented in:

```text
server/core/portable-warm-bundle-contract.js
```

Public schema:

```text
driftstone_portable_warm_bundle_v0
```

Required top-level shape:

```text
schema
manifest
source_manifest
persona_authority
warm_cards
source_occurrences
source_spans
rejected_ledger
hold_ledger
projection_roundtrip
conservation
```

Each Warm card must carry:

```text
candidate_id
title
archive_bucket
frontend_delivery_tier
portable_warm_card
source_refs
privacy
quality
home_import_policy
```

`portable_warm_card` is a portable card, not Home canonical memory:

```text
body_markdown
living_fragment
feeling_as_fact
future_use_hint
voice_fingerprint_refs
persona_refs
```

The validator rejects public bundles that carry Cold graph writer lineage fields
such as roots/vines/relation/cluster/snapshot, or any Home/Hippocove direct-write
authority.

## Notion Projection Proposal

Notion remains a reversible projection. Suggested databases:

- `Driftstone Bundle Index`
- `Portable Warm Cards`
- `Source Occurrences`
- `Source Spans`
- `Review Ledger`

Roundtrip identity:

```text
candidate_id -> notion_page_id / notion_sync_hash / last_synced_at
```

Review backflow must return:

```text
candidate_id
base_digest
patch fields
review state
review note
```

The core validates a review patch locally before changing the bundle projection.
Notion never becomes canonical truth and never grants Home/Hippocove write
authority.

## First Implementation Block

Smallest real caller added:

```text
MCP tool: get_portable_warm_bundle_contract
```

This gives headless agents a stable way to inspect the public bundle contract and
Notion projection boundary before they touch any user material.

Focused validation:

```text
server/tests/portable-warm-bundle-contract.test.js
npm run test:contracts
```

## P0 / P1 From This Block

P0:

- Public MCP and HTTP route catalog still advertise finalize/write paths that
  materialize roots/vines.
- Existing generators do not yet emit `driftstone_portable_warm_bundle_v0`.
- Notion has only split/placeholder UI; no provider-safe projection writer or
  review-backflow import.

P1:

- Public docs/package naming still says Hippocove in many places.
- `path-config` creates runtime/staging directories on import, which is too eager
  for pure inspect/export tools.
- There is no root `LICENSE`/`NOTICE` file in the inspected public worktree.
- Agent tools need public Driftstone verbs: prepare/run/resume/inspect/review/export.

## Explicit Holds

- No private Phase 2 / Hippocove destination chain is imported into public main.
- No Home write, Hippocove write, Notion write, provider call, deployment, commit,
  or push happened in this block.
