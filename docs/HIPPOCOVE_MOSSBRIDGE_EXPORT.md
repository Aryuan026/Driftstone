# Hippocove / Driftstone Mossbridge Export

这份说明是给后续接 Mossbridge 的 agent 看的。

它要守住一个边界：

**Notion 是人读和 ChatGPT 端复核投影，Mossbridge ingest bundle 才是机读接收位。**

也就是说，Notion 的价值不是变成主库，而是反过来帮助我们确认哪些字段对人、对 Chat、对前台召回真的有用。真正给 Mossbridge / MCP / 网关吃的，应当是稳定 JSON。

## 当前出口

生成脚本：

```bash
node scripts/debug/build_mossbridge_ingest_bundle.mjs --months 2025-02,2025-03,2025-04
```

默认输出：

```text
output/mossbridge_ingest/driftstone_2025-02_to_2025-04_mossbridge_ingest_bundle/
  manifest.json
  normalized/
    warm_memory.jsonl
    ongoing_tracks.jsonl
    episode_journal.jsonl
    observation_journal.jsonl
    case_index.jsonl
    memory_tree_roots.jsonl
    memory_tree_edges.jsonl
  evidence/
    source_traces.jsonl
    source_spans.jsonl
  qa/
    sample_queries.jsonl
    quality_report.json
```

bundle schema：

```text
driftstone_mossbridge_ingest_bundle_v0.1
```

这还不是 Mossbridge live data-root bundle。它是中间接收包，给 Mossbridge adapter 做显式映射用。

## 安全口径

当前 profile 是保守准备层：

- `writes_to_notion: false`
- `writes_to_mossbridge_warm_memory: false`
- `direct_runtime_activation: false`
- `imports_overflow_links: false`
- `accepted_records: 0`

没有任何记录会被标成 `accepted`。旧历史只会进入：

- `candidate`
- `rejected`
- `evidence_only`

Mossbridge 接收端后续必须自己复核、映射、确认，不能把这个包直接当运行态记忆激活。

## 字段映射原则

Driftstone 的主链是：

```text
23_asheriehome_memory_nodes.jsonl
24_source_trace_index.jsonl
16_normalized_source_span_candidates.jsonl
13_normalized_relation_root_candidates.jsonl
14_normalized_tree_edge_candidates.jsonl
```

Mossbridge export profile 会把它们分成三层。

### 1. 记忆候选层

来自 `23_asheriehome_memory_nodes.jsonl`。

输出到：

- `normalized/warm_memory.jsonl`
- `normalized/episode_journal.jsonl`
- `normalized/observation_journal.jsonl`
- `normalized/case_index.jsonl`

每条会带：

- `material_id`
- `source_entry_id`
- `target_layer`
- `import_status`
- `review_status`
- `title`
- `summary`
- `body_markdown`
- `front_recall_text`
- `source_trace_ids`
- `source_span_ids`
- `provenance_refs`

`warm_memory.jsonl` 这个文件名只是 Mossbridge 目标层名，不代表里面的旧历史可以直接进 warm memory。当前全部仍是 candidate / evidence-only / rejected。

### 2. 关系树候选层

来自 relation root / edge candidates。

输出到：

- `normalized/memory_tree_roots.jsonl`
- `normalized/memory_tree_edges.jsonl`

关系边必须带：

- `from_ref`
- `to_ref`
- `relation_type`
- `confidence`
- `source_trace_ids`
- `no_recall_boost_before_review: true`
- `requires_confirmation: true`

背景共现、弱边、审计边不能当稳定语义事实。

### 3. 原文证据层

来自 source trace / source span。

输出到：

- `evidence/source_traces.jsonl`
- `evidence/source_spans.jsonl`

它们固定是：

- `target_layer: raw_transcript_archive`
- `import_status: evidence_only`
- `expose_to_front_model_by_default: false`

source trace 是核验证据仓，不是前台人格文本。

## 对 Notion 人读版本的影响

这个 profile 不要求把 Mossbridge 字段塞进 Notion 页面。

Notion 仍然保持轻投影：

- `node_path`
- `anchor_name`
- `living_fragment`
- `project_fact`
- `relationship_significance`
- `feeling_as_fact`
- `review_status`
- `recall_guard`
- `frontend_delivery_tier`
- `source_trace_count`

Mossbridge 需要的运行层字段，例如：

- `target_layer`
- `import_status`
- `provenance_refs`
- `source_trace_ids`
- `source_span_ids`
- `certainty_state`
- `pinned`

应该优先留在 JSON bundle 里，而不是挤进人类默认阅读页。

前台读取还有一条硬规则：

**如果一条记录同时有 `frontend_delivery_tier` 和 `recall_guard`，读取器必须优先按 `frontend_delivery_tier` 决定是否递送。**

`recall_guard` 只保留为历史字段 / 兼容参考，不能单独决定默认召回。比如旧字段仍写着 `normal_candidate`，但 `frontend_delivery_tier` 已经是 `explicit_context_only` 时，前台必须按 `explicit_context_only` 收紧。

## 接收端建议

Mossbridge adapter 不要直接吃 Notion projection。

推荐顺序：

1. 读取 `manifest.json`，确认 schema 是 `driftstone_mossbridge_ingest_bundle_v0.1`。
2. 读取 `qa/quality_report.json`，确认 `accepted_count` 是 0。
3. 只把 `candidate` 放入候选审查区。
4. 只把 `evidence_only` 放入 evidence / raw transcript archive。
5. `rejected` 只做审计，不进入前台召回。
6. 关系边在人工或 adapter 规则确认前，不允许提升 recall weight。
7. source trace / source span 只在核验、回溯、冷兜底时展开。

## 这一步解决什么

它不是为了多做一份导出。

它是在 Hippocove / Driftstone 与 Mossbridge 之间加一层明确的翻译层：

- Driftstone 继续负责多轮提炼、去重、字段质检、原文回溯。
- Notion 继续负责人类和 ChatGPT 端可视复核。
- Mossbridge 接收稳定 JSON，并自己决定哪些能变成运行态记忆。

这样后面就不会因为 Notion 页面看起来好读，就误把人读投影当成记忆运行库。
