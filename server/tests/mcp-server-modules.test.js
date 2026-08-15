import assert from 'node:assert/strict';
import test from 'node:test';

import { listMcpTools, TOOLS } from '../mcp/tool-catalog.js';
import { callTool } from '../mcp/tool-dispatch.js';

const EXPECTED_ALL_TOOL_NAMES = [
  'list_api_profiles',
  'get_portable_warm_bundle_contract',
  'export_portable_warm_bundle',
  'inspect_portable_warm_bundle',
  'export_portable_warm_projection',
  'get_growth_context',
  'build_growth_task',
  'generate_growth_draft',
  'list_growth_drafts',
  'get_growth_draft',
  'export_growth_draft_to_obsidian',
  'get_card_registry',
  'upsert_card_registry_entry',
  'get_growth_ledger',
  'append_growth_ledger_entry',
  'commit_growth_decision',
  'get_persona_workspace_state',
  'save_persona_workspace_state',
  'build_language_fingerprint_candidates',
  'generate_soul_draft',
  'generate_language_fingerprint',
  'run_history_pipeline',
  'prepare_history_source',
  'pull_translation_task',
  'submit_translation_entries',
  'fail_translation_task',
  'list_reviewed_clusters',
  'finalize_reviewed_entries',
  'inspect_pipeline_scope',
  'get_memory_context'
];

const LEGACY_TOOL_NAMES = [
  'run_history_pipeline',
  'finalize_reviewed_entries',
  'get_memory_context'
];

const EXPECTED_PUBLIC_TOOL_NAMES = EXPECTED_ALL_TOOL_NAMES.filter((name) => !LEGACY_TOOL_NAMES.includes(name));

test('MCP tool catalog preserves callable tool names and order', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), EXPECTED_ALL_TOOL_NAMES);
});

test('MCP tools/list hides legacy routes unless explicitly requested', () => {
  const publicTools = listMcpTools();
  const allTools = listMcpTools({ includeLegacy: true });

  assert.deepEqual(publicTools.map((tool) => tool.name), EXPECTED_PUBLIC_TOOL_NAMES);
  assert.deepEqual(allTools.map((tool) => tool.name), EXPECTED_ALL_TOOL_NAMES);
  assert.equal(publicTools.some((tool) => LEGACY_TOOL_NAMES.includes(tool.name)), false);
  assert.equal(allTools.some((tool) => Object.prototype.hasOwnProperty.call(tool, 'legacy')), false);
});

test('MCP dispatch can call the portable warm bundle contract tool', async () => {
  const packet = await callTool('get_portable_warm_bundle_contract', {});
  assert.equal(packet.ok, true);
  assert.equal(packet.product_boundary.projections_are_truth, false);
  assert.equal(packet.notion_projection_proposal.canonical_truth, false);
});

test('MCP dispatch can export a portable warm bundle without writing files', async () => {
  const packet = await callTool('export_portable_warm_bundle', {
    owner_id: 'synthetic-owner-with-no-runtime-data',
    realm_id: 'synthetic-realm',
    write_files: false
  });
  assert.equal(packet.ok, true);
  assert.equal(packet.bundle.schema, 'driftstone_portable_warm_bundle_v0');
  assert.equal(packet.output.dir, '');
  assert.equal(packet.conservation.accepted_rows, 0);
});

test('MCP dispatch can inspect a missing portable warm bundle without pretending success', async () => {
  const packet = await callTool('inspect_portable_warm_bundle', {
    bundle_path: '/tmp/driftstone-synthetic-missing-portable-warm-bundle.json'
  });
  assert.equal(packet.ok, false);
  assert.equal(packet.artifact_status, 'unreadable_bundle');
  assert.equal(packet.projection_readiness, 'blocked_by_read_error');
});

test('MCP dispatch can export a projection without pretending a missing bundle succeeded', async () => {
  const packet = await callTool('export_portable_warm_projection', {
    bundle_path: '/tmp/driftstone-synthetic-missing-projection-bundle.json'
  });
  assert.equal(packet.ok, false);
  assert.equal(packet.projection_status, 'blocked_by_read_error');
});

test('MCP dispatch keeps unknown tool calls explicit', async () => {
  await assert.rejects(
    () => callTool('missing_tool', {}),
    /Unknown tool: missing_tool/
  );
});

test('MCP dispatch rejects hidden legacy tools on the public surface', async () => {
  for (const name of LEGACY_TOOL_NAMES) {
    await assert.rejects(
      () => callTool(name, {}),
      /legacy\/compat-only/
    );
  }
});

test('MCP dispatch allows legacy tools only when server compatibility is explicit', async () => {
  await assert.doesNotReject(() => callTool('get_memory_context', {
    owner_id: 'synthetic-owner',
    realm_id: 'synthetic-realm'
  }, {
    includeLegacy: true
  }));
});
