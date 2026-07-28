# Driftstone Portable Memory Artifact v1

Status: local, read-only candidate contract.

The canonical artifact is versioned JSON/JSONL. Notion fields, Markdown files,
other memory-system formats, and cloud-drive copies are downstream projections.
They do not become memory authority, write receipts, graph edges, episodes, or
destination truth.

## Input boundary

This checkpoint consumes the existing processed layers. It does not rerun the
13-month extraction.

The CLI has two explicit, non-fallback input modes:

- `staging` (also the legacy default when `--mode` is omitted) reads the
  four-file Notion staging set;
- `processed` requires exact `--prepared-file`, `--workbench-file`,
  `--source-index-file`, and `--reviewed-csv` arguments.

Processed mode never scans a directory to guess a month or silently falls back
to staging. It does not read `00_bundle_raw` and it does not write Home, Notion,
Hippocove, a cloud drive, or any other destination. Canonicalized input paths
inside `00_bundle_raw` are rejected before file content is read, and the
prepared input must satisfy the prepared-bundle structural boundary.

- `persona` remains the persona candidate lane.
- `sql` / `fact` becomes the domain-neutral fact candidate lane.
- Historical CASE extraction is
  `not_applicable_by_owner_decision`. Text heuristics must not reconstruct it.

The artifact keeps the exact upstream reviewed row, memory node, normalized
candidate, source trace, and source span. In direct processed mode it instead
keeps the exact reviewed row, workbench row, source-index anchor/topic records,
and source-index metadata. Prepared-window source fields are kept with a
SHA-256/character-count binding; the prepared `text` body is deliberately not
copied into every artifact. Convenience indexes for labels, original IDs,
state, authority claims, review fields, text fields, and graph hints are
additive; they do not replace those payloads.

Missing fields remain listed in `missing_fields`. Builders must not invent
source IDs, month keys, atomic facts, authority, receipts, episodes, or edges.
The thin CLI uses reviewed persona/sql rows as the conservation base. Duplicate
join identities and processed nodes without a reviewed row enter the rejected
ledger instead of disappearing.

`input.layer` and `input.month_key` are caller assertions, not override
authority. Conflicts among reviewed rows, nodes, normalized candidates, and
caller input are rejected. A caller cannot hide an upstream historical CASE
label by supplying `persona`.

Every source trace/span ID referenced by a node is resolved. Successful
artifacts preserve all matched trace/span payloads as arrays. Ambiguous or
unresolved IDs reject the source unit; trace/span totals, ambiguous IDs,
unresolved IDs, and unreferenced/orphan IDs remain visible in `source_join`.
Normalized candidates without either a reviewed row or node also become
rejected inputs.

Direct processed mode uses reviewed `record_id` as the candidate conservation
key. A workbench row missing from reviewed CSV becomes
`processed_workbench_without_reviewed_row`; a source-index-only anchor becomes
`source_index_anchor_orphan`. Neither disappears. Prepared chunks and
source-index topics are auxiliary evidence rows rather than memory candidates;
their referenced, unresolved, ambiguous, and orphan IDs remain in
`source_join`. This also preserves the known shape in which one month may have
one more source-index anchor than workbench rows.

Reviewed/workbench topic IDs are memory-taxonomy labels. Only
`source_index.anchors[].topic_ids` address `source_topic_index`; the two
namespaces must not be cross-joined merely because both are called topic IDs.
The artifact therefore persists them separately as
`memory_taxonomy_topic_ids` and `source_index_topic_ids`, even when the same
textual ID happens to occur in both namespaces.

## Fact boundary

`content.atomic_fact` is deliberately domain-neutral. Existing SQL/fact fields
may describe a creative-world fact, plot development, preference, viewpoint,
relationship evolution, or later work fact. The adapter does not rename these
as project reports and does not use text regexes to decide the lane.

Only structured fact carriers are eligible: reviewed/workbench `fact_value`,
normalized `raw_machine_fact` / `facts`, and the explicitly named node
`project_fact`. The direct processed corpus has a narrower legacy SQL
structure: when and only when the source row is explicitly `layer=sql`,
`sql_row_kind=card_master`, and both `fact_keys` and `fact_role` are nonempty,
that same row's explicit `text` is eligible as the atomic fact candidate. Its
source field is recorded. This prevents all legacy SQL cards from becoming
empty while still forbidding persona text, untyped prose, status notes, and
generic summary fields from impersonating facts. Object-shaped facts remain
structured objects; they are never stringified as `[object Object]`. Multiple
existing fact fields are conserved as candidates. The primary field is a
structural projection only and never receives canonical fact authority.

## Graph boundary

Entity, predicate, frame, claim, citation, concept, reply, previous/next,
scope, support, and negative fields are named as candidates or hints.

Every artifact states:

- `runtime_effect: none`
- `canonical_edges_created: 0`
- `canonical_episodes_created: 0`
- `canonical_authority_granted: false`
- `canonical_receipts_created: 0`

Hippocove must validate and admit reviewed evidence separately.

## Projection and round-trip boundary

Notion and Markdown projections carry:

- the portable artifact ID;
- the canonical artifact SHA-256;
- source and label conservation counts;
- an explicit `projection_only` marker;
- no destination write or authority grant.

The JSON artifact remains the round-trip source. “Round trip” means a consumer
can use the ID/hash to read the canonical JSON again; it does **not** mean a
Notion or Markdown projection is independently canonical or can reconstruct
authority by itself. Projection verification derives the complete expected
projection from the canonical artifact. Any changed label field, atomic text,
Markdown body, join key, hash, or conservation count fails.

`labels.source_fields` keeps known label fields. New or unknown taxonomy fields
remain in `labels.unclassified_label_fields`, while
`labels.exact_field_audit` binds every upstream leaf field to an exact value
hash. The hardcoded convenience list therefore cannot silently erase new
metadata. Duplicate reviewed-CSV headers reject the generation before
last-wins object parsing can occur.

Canonical JSON rejects `NaN`, positive/negative infinity, `undefined`,
functions, symbols, non-plain objects, and circular references.

Projection files are not generated by default. The canonical artifact,
rejection ledger, conservation ledger, and generation manifest are the default
file set. `--with-projections` explicitly adds the Notion and Markdown
projection JSONL files. This keeps “can be converted to Notion/Markdown”
separate from “duplicate every monthly generation by default.”

## Generation and ledger truth

The CLI refuses a nonempty output directory by default. `--replace` is accepted
only when the existing generation manifest is valid, all listed output digests
still match, and the new input generation ID is identical. Replacement is
written to a sibling temporary directory and published by rename.
The generated directory is private (`0700`) and every output file is created
with mode `0600`.

The output profile (`canonical_only` or `canonical_plus_projections`) is part of
the generation identity and manifest. Replacement also verifies the exact
directory file set; unlisted extras or missing listed files fail closed.

The persisted conservation-ledger digest is computed only after source-join and
generation fields are present. Verification excludes only the digest field
itself.

Example direct processed invocation:

```bash
node scripts/debug/build_portable_memory_artifacts_v1.mjs \
  --mode processed \
  --prepared-file /private/path/month-prepared.json \
  --workbench-file /private/path/month-workbench.json \
  --source-index-file /private/path/month-source-index.json \
  --reviewed-csv /private/path/month-reviewed.csv \
  --month YYYY-MM \
  --out /private/tmp/driftstone-portable-YYYY-MM
```

The output path is a local candidate-generation boundary, not a destination
memory write. Add `--with-projections` only when a downstream review actually
needs the Notion/Markdown views.

## Hippocove read-only handoff

`exportPortableArtifactsJsonl()` emits the same
`driftstone_portable_memory_artifact_v1` objects after verifying each canonical
artifact hash. This is the minimal direct-consumption fixture/helper for
Hippocove. It does not create a Hippocove-specific canonical schema; admission,
translation, and durable graph writing remain Hippocove responsibilities.

## Temporal coverage

The default sample plan records owner-supplied sampling metadata:

- 2025-02 through 2025-04: early evolution / creation / story-or-plot cohort;
- 2025-08 onward: viewpoint / expression cohort.

These are review strata, not hardcoded content classifications. Row types must
come from explicit metadata. Full-corpus acceptance conserves
`month × observed dialogue type`; it does not require every month to contain
every type.

The corpus row field `time` is memory/event time, not the extraction bundle
month. Corpus-month truth therefore comes from explicit `month_key`,
source-file identity, and the CLI `--month` assertion. A September row
describing a February memory must remain in the September processing cohort
without losing its February event time.

## Safety

The builder and projections:

- do not read the Home persona prompt;
- do not write Home, Notion, Hippocove, or cloud storage;
- do not generate final warm-card prose;
- do not grant answer-evidence authority;
- do not auto-merge rows that share a dedupe candidate hash.
