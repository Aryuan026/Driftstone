# Driftstone Agent Headless Workflow

This is the canonical public guide for agents that run Driftstone without
opening the human UI.

Older docs may still use `HIPPOCOVE_*` filenames for compatibility. Public
product language should say Driftstone. The public endpoint is a portable Warm
bundle and reversible local projections, not a Cold tree writer.

## Boundary

Driftstone is a local-first historical memory extraction workbench.

Canonical artifact:

```text
driftstone_portable_warm_bundle_v0
+ manifest
+ source occurrences / source spans / digests
+ rejected ledger
+ HOLD ledger
```

Allowed local projections:

```text
Markdown / Obsidian / Notion-ready JSONL
```

Not allowed in the public workflow:

```text
Home writes
Hippocove writes
Cold roots / vines / relation graph writes
Notion API writes without a current explicit human action
private paths, private corpus, credentials, or production receipts
```

## Start The MCP Server

From the repository root:

```bash
cd server
npm run mcp
```

MCP clients should register this process as `driftstone`. Existing clients that
still call it `hippocove` can keep that alias, but new instructions should use
`driftstone`.

```json
{
  "mcpServers": {
    "driftstone": {
      "command": "node",
      "args": ["server/mcp-server.js"]
    }
  }
}
```

## Verb Map

Agents should think in these verbs. The human UI should eventually observe the
same state machine instead of inventing another path.

| verb | use | primary MCP tools |
| --- | --- | --- |
| `prepare` | Ingest local files, build translation packets and task queue. | `prepare_history_source`, `inspect_pipeline_scope` |
| `run` | Pull one task, have the model produce entries, write reviewed rows. | `pull_translation_task`, `submit_translation_entries`, `fail_translation_task` |
| `resume` | Continue from the same `owner_id + realm_id + bot_id` scope. | `inspect_pipeline_scope`, `pull_translation_task` |
| `inspect` | Read state, API profile availability, growth context and ledgers. | `list_api_profiles`, `get_persona_workspace_state`, `get_growth_context`, `get_card_registry`, `get_growth_ledger` |
| `review` | Inspect reviewed clusters and growth drafts before export. | `list_reviewed_clusters`, `list_growth_drafts`, `get_growth_draft` |
| `export` | Emit the canonical portable bundle and local projections. | `export_portable_warm_bundle`, `export_portable_warm_projection` |
| `validate` | Check the bundle contract, ledgers and source completeness. | `get_portable_warm_bundle_contract`, `inspect_portable_warm_bundle` |

Legacy compatibility tools remain callable but should not be presented as the
normal public endpoint. The MCP `tools/list` response now hides them by default;
maintenance clients can pass `include_legacy_tools: true` when they explicitly
need old diagnostics.

| legacy tool | current role |
| --- | --- |
| `run_history_pipeline` | Local smoke / compatibility pipeline. Prefer the stepwise workflow for real agent work. |
| `finalize_reviewed_entries` | Old roots/vines materialization. Not a Home/Hippocove write and not the public endpoint. |
| `get_memory_context` | Old compact context reader. Useful for diagnostics, not canonical memory truth. |

## Recommended Agent Loop

Use a stable scope for one batch, such as one month or one exported window pack.
Do not create a new `realm_id` every time the agent reconnects.

1. Call `inspect_pipeline_scope`.
2. If no ingest or task packet exists, call `prepare_history_source`.
3. Call `pull_translation_task`.
4. Read only the returned task packet and its `ai_contract`.
5. Submit entries with `submit_translation_entries`, or call
   `fail_translation_task` with a clear reason.
6. Repeat until `pull_translation_task` reports no pending task.
7. Run `list_reviewed_clusters` if semantic merge review is needed.
8. Use growth tools only after reviewed material and persona workspace are in
   place.
9. Call `export_portable_warm_bundle`.
10. Call `inspect_portable_warm_bundle`.
11. If projection readiness is acceptable, call `export_portable_warm_projection`.

The portable bundle is the truth. Projection files are views of that bundle.

## Growth And Warm Cards

When using growth tools, keep the writing target clear:

- `build_growth_task` creates the current card-growth task packet.
- `generate_growth_draft` creates a draft; it is not a private Home canonical
  warm write.
- `commit_growth_decision` updates Driftstone's local registry and growth
  ledger only.
- `export_portable_warm_bundle` is the public stable export point.

Warm-card text should be inner-perspective memory material, not a work report.
For model instructions, keep this sentence close to the task:

```text
不是只要第一人称，而是要从内位视角写：人在里面经历，不在外面总结。
```

## Bundle Inspection Rules

`inspect_portable_warm_bundle` is intentionally conservative:

- It can read a bundle directory or `portable_warm_bundle.json`.
- It reports source completeness and ledger summaries.
- It does not return full card bodies or full source excerpts.
- It does not write Notion, Home, Hippocove, Obsidian or legacy roots/vines.

If inspection returns `projection_readiness` as `blocked_by_read_error`,
`blocked_by_input_error`, or `nothing_to_project`, stop and report the reason
instead of pretending a projection was made.

## Projection Rules

`export_portable_warm_projection` creates a local package with:

```text
00_chat_human_entry.md
01_warm_cards.md
02_review_ledger.md
obsidian/
notion/*.jsonl
projection_manifest.json
```

Projection safety:

- Notion-ready JSONL is not a Notion write.
- `candidate_id`, `notion_sync_hash`, and empty `notion_page_id` support a
  future explicit roundtrip.
- Output is limited to the repository `output/` directory or the system temp
  directory.
- Obvious private absolute paths and secret-like API keys are blocked before
  projection.

If a human later asks an agent to write Notion, that should be a separate
current action that reads the projection package and records page ids back by
`candidate_id + notion_sync_hash`. Do not treat Notion pages as canonical
memory.

## Source And Privacy Rules

Agents must keep source state honest:

- Bounded source spans can support audit and review.
- Source-incomplete rows stay visible in HOLD/rejected/quality flags.
- A readable quote is not automatically final answer evidence.
- Missing source does not mean the memory candidate must disappear; it means
  authority must stay lower and visible.
- Never print API keys, private paths, raw corpora, or full private excerpts in
  reports.

## Minimal Agent Prompt

Use this when asking another tool-capable agent to process a batch:

```text
You are running Driftstone locally through MCP. Use the stepwise workflow:
inspect -> prepare if needed -> pull one task -> submit entries or fail the task
-> repeat -> export portable_warm_bundle -> inspect bundle -> export local
projection only if ready. The public endpoint is the portable Warm bundle, not
roots/vines, Home, Hippocove, or Notion. Keep the same scope for resume. Do not
invent paths, do not print private source text, and do not write external
systems unless the human explicitly asks for that action now.
```

## Success Criteria

An agent run is acceptable when:

- The scope can be inspected and resumed.
- Every processed task ends as submitted or explicitly failed.
- The portable bundle validates.
- Rejected and HOLD rows remain visible.
- Projection files, if generated, are local and reversible.
- No private system write or external projection write happened silently.
