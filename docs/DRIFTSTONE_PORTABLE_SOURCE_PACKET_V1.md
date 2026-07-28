# Driftstone Portable Source Packet v1

Status: local/private candidate contract. No destination writer is attached.

## Why this exists

The thirteen monthly corpora have already been extracted. This adapter does not
ask a model to summarize, classify, or extract them again. It turns the five
existing layers for one month into a checksummed, reviewable source packet:

1. raw bundle;
2. prepared bundle;
3. workbench;
4. source index;
5. reviewed CSV.

The packet is a source-supply boundary for later Home review and Hippocove
pre-admission. It is not a warm card, cold-tree commit, graph write, Notion
write, source-of-truth replacement, or proof that a claim is already
canonical.

`build_portable_memory_artifacts_v1.mjs` remains a frozen compatible
four-layer/staging adapter for its existing consumers. The source-packet CLI is
the five-layer historical-intake path; it does not delete or silently change
the older artifact.

## Owner decisions encoded in the contract

- Native historical lanes are `persona` and domain-neutral `fact`
  (`sql` normalizes to `fact`).
- Historical CASE extraction is
  `not_applicable_by_owner_decision`.
- The adapter never reconstructs CASE from keywords, titles, or prose.
- A missing raw/source match is normal for imported historical material. It
  remains a human-visible `source_incomplete` candidate rather than being
  deleted or globally blocked.
- A human may explicitly approve such a candidate as `human_attested` or
  `legacy_import`. Approval makes it eligible for Hippocove **pre-admission
  review**; it does not grant cold-tree authority or create a writer receipt.

An optional decisions file uses:

```json
{
  "schema": "driftstone_portable_source_decisions_v1",
  "month_key": "2025-08",
  "decisions": [
    {
      "record_id": "exact-upstream-record-id",
      "candidate_id": "dspc_0123456789abcdef0123456789abcdef",
      "canonical_payload_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "decision": "approve",
      "authority": "human_attested",
      "reviewer": "owner",
      "decided_at": "2026-07-28T00:00:00Z",
      "note": ""
    }
  ]
}
```

Allowed decisions are `approve`, `hold`, and `reject`. Approved decisions
require exactly `human_attested` or `legacy_import`. The decision file digest
is bound into the packet generation identity. Every row must also bind the
reviewed `candidate_id` and its `integrity.canonical_payload_sha256`; a decision
from an older or altered candidate fails closed instead of being replayed by
`record_id`. A `source_bound` candidate already has source authority and cannot
be downgraded through either human approval authority; it may remain undecided,
be held, or be rejected.

## Conservation model

### Five-layer manifest

Every input role records:

- file name, byte count, and SHA-256 over exact bytes;
- top-level shape;
- row/message/topic/anchor counts as appropriate;
- a key/header schema fingerprint;
- explicitly observed structured lanes.

Canonical input paths must be distinct. Each role also has a minimum semantic
shape: a workbench file cannot impersonate prepared input merely because it is
valid JSON and happens to contain a `chunk_id`.

The packet binds the exact builder, source-packet library, and reviewed-CSV
parser source digests. This keeps `--replace` from treating outputs made by
changed code or changed CSV parsing as the same generation. Absolute local
paths and raw message text are not copied into the manifest.

### Raw → prepared

Every raw message gets a `driftstone_raw_message_disposition_v1` ledger row.

- Covered messages list the exact prepared chunk IDs.
- Uncovered messages are
  `not_covered_pending_review`.
- Their available choices are explicit, including context-only, low-signal,
  overlap/duplicate, source-incomplete candidate, or later reprocessing.
- The adapter never calls an uncovered message “lost.”
- Raw text is not copied into this ledger; identity metadata, character count,
  and content SHA-256 remain available.

Prepared chunks with no raw match are also visible as
`prepared_without_raw_match_pending_review`.

### Workbench → reviewed

The conservation base is every workbench row. Mapping by exact `record_id` is
zero-to-many:

- zero reviewed rows remains
  `zero_reviewed_rows_pending_review`;
- one reviewed row remains one;
- duplicate/multiple reviewed rows are preserved as arrays rather than
  overwritten.

Duplicate workbench `record_id` values fail the generation boundary. This
prevents one reviewed row from being fanned out into multiple candidates under
an ambiguous source identity.

Reviewed rows without a workbench row, source-index anchors without a
workbench row, and prepared chunks unused by any candidate enter the rejection
ledger. They do not disappear.

## Canonical labels versus bounded projections

The canonical candidate keeps every parsed upstream tag and fact key, plus the
exact field-level source list. It has no tag or fact-key limit.

The old runtime and downstream UI boundaries remain bounded views:

- runtime atomic-fact key view: 64;
- Notion tag view: 24.

`portable_source_bounded_projections_v1.jsonl` makes those limits explicit. A
truncated projection records retained count, omitted count, and a SHA-256 of
the omitted values. It is marked `projection_only`, cannot mutate the
candidate, and writes neither runtime nor Notion.

This isolates the existing `splitFactKeys(..., 64)` and Notion `tags[:24]`
behavior from source truth. A downstream consumer may keep a bounded UI or
runtime budget, but it can no longer mistake that bounded view for the
complete historical record.

## Hippocove graph boundary

Each candidate carries
`driftstone_hippocove_pre_admission_graph_hints_v1`:

- source record, bundle, window, chunk, anchor, and source-span references;
- exact candidate source-span content hashes when the workbench range resolves;
- structured entity/topic/tag/fact-key candidates;
- source authority candidate and human review state.

The same object states:

- `candidate_only: true`;
- `hippocove_pre_admission_required: true`;
- canonical edges/episodes/receipts created: `0`;
- canonical authority granted: `false`.

A candidate is `source_bound` only when workbench, reviewed rows, source-index
anchors, prepared rows, and raw-message references carry compatible explicit
bundle/window/range evidence. Anchor `source_msg_*` values are source-reference
message indices and resolve only against raw `source_msg_index`; they are not
raw-array ordinals. Upstream anchor `0/0` means unknown and is kept as visible
`source_incomplete`, never accepted through an ordinal-zero coincidence.
Anchor source-reference ranges and window-local `chunk_msg_*` ranges remain
separate namespaces. Unknown ranges are not emitted as graph expansion hints.
The candidate workbench span, reviewed spans, and wider prepared context spans
are emitted in separate fields. Prepared context may cover the candidate, but
it never expands the candidate's exact raw-message references or exact
source-span hash.
Missing or conflicting evidence downgrades the candidate to
`source_incomplete`; it does not erase the row or prevent an owner from
choosing `human_attested` / `legacy_import`.

Hippocove remains the canonical writer and decides whether reviewed graph
evidence is admitted. Home remains responsible for later companion-memory
interpretation and warm-card metabolism.

## Output files

All generated files use mode `0600`; the output directory uses `0700`.
Generated outputs contain private memory material and are ignored local data,
not Git artifacts.

`--replace` first atomically claims the current output into a unique backup
name, then re-verifies the manifest, exact file set, and every digest on that
claimed object. A concurrent/substituted directory fails verification, is
restored when the output path is still empty, and is never deleted as if it
were owned output.

| File | Purpose |
|---|---|
| `portable_source_packet_v1.json` | control packet, five-layer manifest, counts, boundaries |
| `portable_source_candidates_v1.jsonl` | canonical private candidates with full labels and lineage |
| `portable_source_raw_disposition_v1.jsonl` | raw→prepared message conservation |
| `portable_source_prepared_coverage_v1.jsonl` | prepared chunk raw-match audit |
| `portable_source_workbench_review_ledger_v1.jsonl` | workbench→reviewed zero-to-many ledger |
| `portable_source_human_review_queue_v1.jsonl` | visible source-incomplete choices |
| `portable_source_bounded_projections_v1.jsonl` | explicit runtime/Notion bounded views |
| `portable_source_rejected_v1.jsonl` | preserved orphan/incompatible rows |
| `portable_source_generation_manifest_v1.json` | output digests and private-mode contract |

## Representative canaries

The first code/data canaries are deliberately small and cover different
conversation strata:

- 2025-03: early evolution / creation / plot-heavy material;
- 2025-08: viewpoint and expression-heavy material;
- 2025-11: later mixed conversation material.

`--canary-limit 12` is deterministic and boundary-aware. It preferentially
includes source-incomplete, highest-tag, and highest-fact-key rows across
observed lanes before filling the remaining slots. This prevents a canary from
accidentally sampling only easy rows.

The 2026-07-28 read-only canaries produced:

| Month | Full workbench candidates | Emitted | Source-bound | Source-incomplete | Raw messages pending disposition | Workbench rows without reviewed row | Max full tags in canary | Max full fact keys in canary |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2025-03 | 319 | 12 | 168 | 151 | 185 | 11 | 64 | 70 |
| 2025-08 | 1,964 | 12 | 581 | 1,383 | 1,169 | 187 | 103 | 282 |
| 2025-11 | 2,449 | 12 | 803 | 1,646 | 423 | 251 | 48 | 74 |

All three conservations passed. These counts describe candidate/readiness
state, not imported memories. No model, Home, Hippocove, Notion, or cloud
writer was called.

The canaries also demonstrated the known projection headroom:

- March: up to 40 tags and 6 fact keys omitted from the bounded views;
- August: up to 79 tags and 218 fact keys omitted;
- November: up to 24 tags and 10 fact keys omitted.

The omitted values remain intact in the canonical candidates and are bound by
the projection audit.

## Commands

Focused synthetic regression:

```bash
node scripts/debug/regression_portable_source_packet_v1.mjs
```

Representative real-month canary:

```bash
node scripts/debug/build_portable_source_packet_v1.mjs \
  --raw-file /private/corpus/00_bundle_raw/memsrc_2025-08_bundle.json \
  --prepared-file /private/corpus/01_prepared_bundle/memsrc_2025-08_bundle-prepared.json \
  --workbench-file /private/corpus/01_workbench/month-workbench.json \
  --source-index-file /private/corpus/01_source_index/month-source-index.json \
  --reviewed-csv /private/corpus/02_reviewed/month-reviewed.csv \
  --month 2025-08 \
  --canary-limit 12 \
  --out /private/output/driftstone-source-canary-2025-08
```

Omit `--canary-limit` only after representative review is accepted and a full
month packet is actually wanted. This still reuses the existing five layers;
it never reruns model extraction.

## Explicit non-goals

- No 13-month model rerun.
- No batch prose rewrite or inner-view warm-card generation.
- No keyword CASE extraction.
- No automatic human attestation.
- No automatic source-incomplete rejection.
- No Home, Hippocove, Notion, Obsidian, or cloud write.
- No canonical graph edge, authority, episode, or receipt.
- No generated private text committed to Git.
