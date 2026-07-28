# Driftstone Private Source Review v1

This is the local human-review face for a small, already-generated portable
source-packet canary. It does not reread the thirteen-month corpus and does not
run extraction again.

The first review bundle is deliberately limited to the 36 candidates already
frozen in the March, August, and November terminal canaries.

## Reused interaction contract

The repository already has card/list review and JSON download interactions in
the legacy workbench. That implementation is embedded in one large runtime
HTML file and is not a reusable source-packet renderer.

This review face keeps the same human model—candidate list, visible evidence,
decision buttons, notes, and JSON download—but renders a self-contained static
bundle. It does not add a second backend, destination writer, or model path.

## What the reviewer can see

- candidate body and reviewed text;
- month, native lane, full tags, and full fact keys;
- `source_bound` or `source_incomplete`, including every incomplete reason;
- exact workbench evidence and raw-message references;
- reviewed ranges;
- prepared context in a visibly separate context-only panel;
- source-index anchor ranges;
- Hippocove graph hints, with canonical writes and receipts fixed at zero;
- the complete candidate JSON for forensic review.

For `source_incomplete`, the browser draft supports:

- `approve` as `human_attested`;
- `approve` as `legacy_import`;
- `hold`;
- `reject`;
- a reviewer name and free-text note.

`source_bound` already carries explicit source evidence, so its review controls
offer only hold, reject, or no decision. The UI does not downgrade it to
`human_attested` / `legacy_import`.

Browser downloads are temporary transport files and commonly inherit `0644`
from the download directory. They are not sealed durable truth.

Exports are one file per month and use exactly
`driftstone_portable_source_decisions_v1`. Every decision binds `record_id`,
`candidate_id`, and the frozen candidate `canonical_payload_sha256`. A decision
from an altered candidate fails closed instead of being replayed by record ID.
A decision is still only input to a later source-packet rebuild and Hippocove
pre-admission review. It is not a canonical memory or graph decision.

## Privacy boundary

- Generated review directories are `0700`.
- Generated HTML and manifest files are `0600`.
- The private review bundle JSON is `0600` and lets the decision sealer verify
  every decision against the exact frozen candidate.
- Generated HTML contains private candidate text and must stay outside Git.
- The CLI refuses an output path inside this worktree.
- The page is self-contained, has no network calls, and uses a CSP that blocks
  connections and external resources.
- Browser draft state stays in local browser storage under the bundle ID and
  can be cleared from the page.
- No model, Home, Hippocove, Notion, Obsidian, or cloud writer is called.

## Build the frozen 36-candidate review

```bash
node scripts/debug/build_private_source_review_v1.mjs \
  --packet-dir /private/tmp/driftstone-source-canary-terminal2-2025-03 \
  --packet-dir /private/tmp/driftstone-source-canary-terminal2-2025-08 \
  --packet-dir /private/tmp/driftstone-source-canary-terminal2-2025-11 \
  --out /private/tmp/driftstone-private-source-review-v1
```

Open `index.html` locally. Export decisions separately for each month; those
browser downloads must be sealed before durable use:

```bash
node scripts/debug/seal_private_source_decisions_v1.mjs \
  --review-dir /private/tmp/driftstone-private-source-review-v1 \
  --decision-file /private/downloads/driftstone-portable-source-decisions-2025-03.json \
  --out /private/tmp/driftstone-private-source-decisions-sealed-v1
```

The seal step rechecks the decision schema, `record_id`, `candidate_id`, and
canonical candidate digest against the current review bundle. It atomically
publishes a `0700` directory with `0600` decisions and a seal manifest. Only
that sealed monthly file should later be passed to the source-packet builder
with `--human-decisions`.
