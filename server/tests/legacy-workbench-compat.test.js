import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const legacyHtml = readFileSync(join(repoRoot, 'legacy', 'index.html'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const argsStart = source.indexOf('(', start);
  let argsDepth = 0;
  let argsEnd = -1;
  for (let index = argsStart; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '(') argsDepth += 1;
    if (ch === ')') argsDepth -= 1;
    if (argsDepth === 0) {
      argsEnd = index;
      break;
    }
  }
  const braceStart = source.indexOf('{', argsEnd);
  assert.notEqual(braceStart, -1, `${name} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} body was not closed`);
}

function legacyCsvHarness() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    [
      extractFunction(legacyHtml, 'parseCsvRows'),
      extractFunction(legacyHtml, 'parseCsvObjects'),
      'globalThis.parseCsvRows = parseCsvRows;',
      'globalThis.parseCsvObjects = parseCsvObjects;'
    ].join('\n'),
    context
  );
  return context;
}

function legacySourceRoleHarness() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    [
      'globalThis.parseFlexibleTimestamp = (value) => Number(value) || 0;',
      'globalThis.normalizeTimestamp = (value) => Number(value) || 0;',
      "globalThis.formatDate = () => '2025-02-01';",
      "globalThis.buildMergedSourceBundleMeta = () => ({ source_bundle_id: 'src.synthetic', source_md_ref: 'synthetic.md', source_manifest_kind: 'merged_bundle' });",
      "globalThis.buildSourceBundleId = (month) => `src.${month}.bundle`;",
      "globalThis.buildSourceBundleBaseName = (month) => `memsrc_${month}`;",
      extractFunction(legacyHtml, 'extractOpenAIContent'),
      extractFunction(legacyHtml, 'normalizeSourceMessageRole'),
      extractFunction(legacyHtml, 'normalizeBodyFreeSourceId'),
      extractFunction(legacyHtml, 'normalizePositiveSourceMsgIndex'),
      extractFunction(legacyHtml, 'normalizeMessage'),
      extractFunction(legacyHtml, 'buildSourceMessageRoleCensus'),
      extractFunction(legacyHtml, 'inferSqlSourceSubjectRole'),
      extractFunction(legacyHtml, 'parseSourceRoleRef'),
      extractFunction(legacyHtml, 'projectSqlSourceRoleLineage'),
      extractFunction(legacyHtml, 'partitionSqlFactsBySourceRoleLineage'),
      extractFunction(legacyHtml, 'buildMergedTimelineConversation'),
      extractFunction(legacyHtml, 'buildMonthlyNodeConversations'),
      extractFunction(legacyHtml, 'buildSelectedJsonPayload'),
      'globalThis.normalizeMessage = normalizeMessage;',
      'globalThis.buildSourceMessageRoleCensus = buildSourceMessageRoleCensus;',
      'globalThis.projectSqlSourceRoleLineage = projectSqlSourceRoleLineage;',
      'globalThis.partitionSqlFactsBySourceRoleLineage = partitionSqlFactsBySourceRoleLineage;',
      'globalThis.buildMergedTimelineConversation = buildMergedTimelineConversation;',
      'globalThis.buildMonthlyNodeConversations = buildMonthlyNodeConversations;',
      'globalThis.buildSelectedJsonPayload = buildSelectedJsonPayload;'
    ].join('\n'),
    context
  );
  return context;
}

function legacySqlPromptHarness() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    [
      extractFunction(legacyHtml, 'buildSqlSystemPrompt'),
      'globalThis.buildSqlSystemPrompt = buildSqlSystemPrompt;'
    ].join('\n'),
    context
  );
  return context;
}

test('legacy workbench visible buttons are uniquely identified and wired', () => {
  const staticButtons = [...legacyHtml.matchAll(/<button\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)]
    .map((match) => ({
      id: match[1],
      text: match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    }))
    .filter((button) => !button.id.includes('${'));

  const counts = new Map();
  for (const button of staticButtons) {
    counts.set(button.id, (counts.get(button.id) || 0) + 1);
  }
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
  assert.deepEqual(duplicates, []);

  const unwired = staticButtons.filter((button) => {
    const single = `getElementById('${button.id}')`;
    const double = `getElementById("${button.id}")`;
    return !legacyHtml.includes(single) && !legacyHtml.includes(double) && !legacyHtml.includes(`#${button.id}`);
  });
  assert.deepEqual(unwired, []);
});

test('legacy workbench literal DOM references resolve to static elements', () => {
  const domIds = new Set(
    [...legacyHtml.matchAll(/\bid="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((id) => !id.includes('${'))
  );
  const literalRefs = [...legacyHtml.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)]
    .map((match) => match[1])
    .filter((id) => !id.includes('${'));
  const missing = [...new Set(literalRefs.filter((id) => !domIds.has(id)))].sort();
  assert.deepEqual(missing, []);
});

test('legacy workbench runtime endpoints are still served by product routes', () => {
  const routeSource = [
    readFileSync(join(repoRoot, 'server', 'routes', 'product', 'runtime-api-profiles.js'), 'utf8'),
    readFileSync(join(repoRoot, 'server', 'routes', 'product', 'runtime-persona-workspace.js'), 'utf8')
  ].join('\n');

  const rootEndpoints = [...legacyHtml.matchAll(/const\s+(runtime\w+Endpoint)\s*=\s*`\$\{window\.location\.origin\}([^`]+)`/g)]
    .map((match) => ({ name: match[1], path: match[2] }));
  const endpointByName = new Map(rootEndpoints.map((endpoint) => [endpoint.name, endpoint.path]));
  const derivedEndpoints = [...legacyHtml.matchAll(/const\s+(runtime\w+Endpoint)\s*=\s*`\$\{(runtime\w+Endpoint)\}([^`]+)`/g)]
    .map((match) => ({
      name: match[1],
      path: `${endpointByName.get(match[2]) || ''}${match[3]}`
    }));

  const missing = [...rootEndpoints, ...derivedEndpoints]
    .filter((endpoint) => endpoint.path && !routeSource.includes(endpoint.path));
  assert.deepEqual(missing, []);
});

test('legacy workbench no longer exposes abandoned CASE promotion controls', () => {
  const removedControls = [
    'casePromoteScope',
    'inspectCasePromoteBtn',
    'runCasePromoteBtn',
    'savePromptCaseBtn',
    'resetPromptCaseBtn',
    'exportCaseTxtBtn',
    'exportCaseJsonBtn'
  ];
  for (const id of removedControls) {
    assert.equal(legacyHtml.includes(`id="${id}"`), false, `${id} should stay removed`);
  }
  assert.equal(legacyHtml.includes('CASE 升格'), false);
});

test('legacy workbench CSV import preserves quoted multiline rows', () => {
  const { parseCsvObjects } = legacyCsvHarness();
  const rows = parseCsvObjects('layer,title,text\npersona,"snow day","line 1\nline 2"\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, 'line 1\nline 2');
});

test('legacy workbench CSV import fails closed on malformed input', () => {
  const { parseCsvObjects } = legacyCsvHarness();
  assert.throws(
    () => parseCsvObjects('layer,title,text\npersona,"snow day,line\n'),
    /引号未闭合/
  );
  assert.throws(
    () => parseCsvObjects('layer,title\npersona,a,b\n'),
    /字段数不一致/
  );
});

test('legacy SQL source lineage requires the exact primary speaker instead of an adjacent message', () => {
  const { buildSourceMessageRoleCensus, projectSqlSourceRoleLineage } = legacySourceRoleHarness();
  const census = buildSourceMessageRoleCensus([
    { role: 'user', content: 'private user text', source_window_id: 'window-a', source_msg_index: 11 },
    { role: 'assistant', content: 'private assistant text', source_window_id: 'window-a', source_msg_index: 12 }
  ]);
  assert.equal(census.observation_complete, true);
  assert.equal(JSON.stringify(census).includes('private user text'), false);

  const assistantSummary = projectSqlSourceRoleLineage({
    record: {
      fact_id: 'fact-user-preference',
      fact_key: 'user_prefers_exact_receipts',
      anchor_name: 'A-Yuan',
      source_window_id: 'window-a',
      source_msg_start: 11,
      source_msg_end: 12
    },
    declared_source_ref: 'window_20250201_msg_012'
  }, census, { user_name: 'A-Yuan', bot_name: 'Companion' });
  assert.equal(assistantSummary.ok, false);
  assert.equal(assistantSummary.status, 'source_primary_role_mismatch');
  assert.equal(assistantSummary.primary_source_role, 'assistant');
  assert.equal(assistantSummary.body_included, false);

  const exactUser = projectSqlSourceRoleLineage({
    record: {
      fact_id: 'fact-user-preference',
      fact_key: 'user_prefers_exact_receipts',
      anchor_name: 'A-Yuan',
      source_window_id: 'window-a',
      source_msg_start: 11,
      source_msg_end: 12
    },
    declared_source_ref: 'window_20250201_msg_011 | window_20250201_msg_012'
  }, census, { user_name: 'A-Yuan', bot_name: 'Companion' });
  assert.equal(exactUser.ok, true);
  assert.equal(exactUser.status, 'source_role_lineage_exact');
  assert.equal(exactUser.primary_source_role, 'user');
});

test('legacy SQL prompt requires every semantic claim to mirror its exact source messages', () => {
  const { buildSqlSystemPrompt } = legacySqlPromptHarness();
  const prompt = buildSqlSystemPrompt('BASE PROMPT');
  assert.match(prompt, /`source_ref` 不是“主要出处”，而是这条 fact 的完整证据清单/);
  assert.match(prompt, /fact_value、note、recurrence_rule、因果、状态变化或结果/);
  assert.match(prompt, /多条引用用 ` \| ` 分隔/);
  assert.match(prompt, /同一 chunk 不能替代逐条来源/);
  assert.match(prompt, /不能挂到更早消息的 source_ref 上/);
});

test('legacy SQL source lineage fails closed on incomplete or ambiguous physical census', () => {
  const { buildSourceMessageRoleCensus, projectSqlSourceRoleLineage } = legacySourceRoleHarness();
  const candidate = {
    record: {
      fact_id: 'fact-user-preference',
      fact_key: 'user_prefers_exact_receipts',
      anchor_name: 'A-Yuan',
      source_window_id: 'window-a',
      source_msg_start: 11,
      source_msg_end: 11
    },
    declared_source_ref: 'window_20250201_msg_011'
  };
  const missing = buildSourceMessageRoleCensus([
    { role: 'user', source_window_id: 'window-a' }
  ]);
  assert.equal(missing.observation_complete, false);
  assert.equal(projectSqlSourceRoleLineage(candidate, missing, {
    user_name: 'A-Yuan', bot_name: 'Companion'
  }).status, 'source_role_census_incomplete');

  const duplicate = buildSourceMessageRoleCensus([
    { role: 'user', source_window_id: 'window-a', source_msg_index: 11 },
    { role: 'assistant', source_window_id: 'window-a', source_msg_index: 11 }
  ]);
  assert.equal(duplicate.observation_complete, false);
  assert.equal(duplicate.duplicate_count, 1);
  const repeated = buildSourceMessageRoleCensus([
    { role: 'user', source_window_id: 'window-a', source_msg_index: 11 },
    { role: 'user', source_window_id: 'window-a', source_msg_index: 11 }
  ]);
  assert.equal(repeated.observation_complete, false);
  assert.equal(repeated.duplicate_count, 1);

  const multiWindow = buildSourceMessageRoleCensus([
    { role: 'user', source_window_id: 'window-a', source_msg_index: 11 },
    { role: 'user', source_window_id: 'window-b', source_msg_index: 11 }
  ]);
  const noWindowCandidate = {
    record: { ...candidate.record, source_window_id: '' },
    declared_source_ref: candidate.declared_source_ref
  };
  assert.equal(projectSqlSourceRoleLineage(noWindowCandidate, multiWindow, {
    user_name: 'A-Yuan', bot_name: 'Companion'
  }).status, 'source_window_ambiguous');
});

test('legacy SQL source lineage holds invalid facts before card aggregation', () => {
  const { buildSourceMessageRoleCensus, partitionSqlFactsBySourceRoleLineage } = legacySourceRoleHarness();
  const census = buildSourceMessageRoleCensus([
    { role: 'user', source_window_id: 'window-a', source_msg_index: 11 },
    { role: 'assistant', source_window_id: 'window-a', source_msg_index: 12 }
  ]);
  const base = {
    fact_key: 'user_prefers_exact_receipts',
    anchor_name: 'A-Yuan',
    source_window_id: 'window-a',
    source_msg_start: 11,
    source_msg_end: 12
  };
  const partition = partitionSqlFactsBySourceRoleLineage([
    { record: { ...base, fact_id: 'fact-valid' }, declared_source_ref: 'window_20250201_msg_011' },
    { record: { ...base, fact_id: 'fact-invalid' }, declared_source_ref: 'window_20250201_msg_012' }
  ], census, { user_name: 'A-Yuan', bot_name: 'Companion' });
  assert.deepEqual(Array.from(partition.accepted, (item) => item.fact_id), ['fact-valid']);
  assert.equal(partition.holds.length, 1);
  assert.equal(partition.holds[0].fact_id, 'fact-invalid');
  assert.equal(partition.holds[0].status, 'source_primary_role_mismatch');
  assert.equal(partition.holds[0].body_included, false);
  assert.equal(Object.hasOwn(partition.holds[0], 'fact_value'), false);
});

test('legacy SQL source lineage holds unknown subjects and preserves explicit other facts', () => {
  const { buildSourceMessageRoleCensus, projectSqlSourceRoleLineage } = legacySourceRoleHarness();
  const census = buildSourceMessageRoleCensus([
    { role: 'assistant', source_window_id: 'window-a', source_msg_index: 12 }
  ]);
  const generic = {
    record: {
      fact_id: 'fact-weather',
      fact_key: 'weather_state',
      anchor_name: 'weather',
      source_window_id: 'window-a',
      source_msg_start: 12,
      source_msg_end: 12
    },
    declared_source_ref: 'window_20250201_msg_012'
  };
  const unknown = projectSqlSourceRoleLineage(generic, census, {
    user_name: 'A-Yuan', bot_name: 'Companion'
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, 'source_subject_role_unknown');
  const explicitOther = projectSqlSourceRoleLineage({
    ...generic,
    record: { ...generic.record, source_subject_role: 'other' }
  }, null, { user_name: 'A-Yuan', bot_name: 'Companion' });
  assert.equal(explicitOther.ok, true);
  assert.equal(explicitOther.status, 'source_subject_role_other');
  const conflict = projectSqlSourceRoleLineage({
    ...generic,
    record: {
      ...generic.record,
      fact_key: 'user_weather_state',
      anchor_name: 'A-Yuan',
      source_subject_role: 'other'
    }
  }, census, { user_name: 'A-Yuan', bot_name: 'Companion' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 'source_subject_role_conflict');
});

test('legacy SQL source census stays process-local and gates before card aggregation', () => {
  const checkpointSource = extractFunction(legacyHtml, 'cloneMemoTaskForCheckpoint');
  assert.match(checkpointSource, /delete safeEntry\._source_message_census/);
  const runSource = extractFunction(legacyHtml, 'runExtraction');
  const gateIndex = runSource.indexOf('partitionSqlFactsBySourceRoleLineage');
  const aggregateIndex = runSource.indexOf('deriveSqlCardsFromFacts');
  assert.ok(gateIndex >= 0);
  assert.ok(aggregateIndex > gateIndex);
  assert.equal(extractFunction(legacyHtml, 'buildPreparedMemoSourceJson').includes('_source_message_census'), false);
  assert.equal(extractFunction(legacyHtml, 'buildPreparedMemoSourceMarkdown').includes('_source_message_census'), false);
});

test('legacy SQL source lineage projections reject body-shaped identifiers', () => {
  const { buildSourceMessageRoleCensus, projectSqlSourceRoleLineage } = legacySourceRoleHarness();
  const census = buildSourceMessageRoleCensus([
    { role: 'user', content: 'private body', source_window_id: 'window-a', source_msg_index: 11 }
  ]);
  const projection = projectSqlSourceRoleLineage({
    record: {
      fact_id: 'PRIVATE BODY',
      fact_key: 'user_prefers_exact_receipts',
      anchor_name: 'A-Yuan',
      source_window_id: 'window-a',
      source_msg_start: 11,
      source_msg_end: 11
    },
    declared_source_ref: 'PRIVATE BODY_msg_011'
  }, census, { user_name: 'A-Yuan', bot_name: 'Companion' });
  assert.equal(projection.ok, false);
  assert.equal(projection.status, 'source_ref_invalid');
  assert.equal(projection.fact_id, '');
  assert.equal(JSON.stringify(projection).includes('PRIVATE BODY'), false);
  assert.equal(JSON.stringify(census).includes('private body'), false);
  const badWindow = projectSqlSourceRoleLineage({
    record: {
      fact_id: 'fact-user-preference',
      fact_key: 'user_prefers_exact_receipts',
      anchor_name: 'A-Yuan',
      source_window_id: 'PRIVATE BODY',
      source_msg_start: 11,
      source_msg_end: 11
    },
    declared_source_ref: 'window_20250201_msg_011'
  }, census, { user_name: 'A-Yuan', bot_name: 'Companion' });
  assert.equal(badWindow.status, 'source_window_invalid');
  assert.equal(JSON.stringify(badWindow).includes('PRIVATE BODY'), false);
});

test('legacy JSON export preserves an inexact source role across reimport', () => {
  const {
    normalizeMessage,
    buildMergedTimelineConversation,
    buildMonthlyNodeConversations,
    buildSelectedJsonPayload,
    buildSourceMessageRoleCensus
  } = legacySourceRoleHarness();
  const missingRole = normalizeMessage({
    content: { parts: ['assistant-looking summary'] },
    source_window_id: 'window-a',
    source_msg_index: 12
  });
  assert.equal(missingRole.role, 'assistant');
  assert.equal(missingRole._source_role_exact, false);
  const source = {
    id: 'window-a',
    title: 'Synthetic',
    month: '2025-02',
    messages: [missingRole]
  };
  const payload = buildSelectedJsonPayload([source]);
  assert.equal(payload[0].messages[0].source_role_exact, false);
  const reparsed = normalizeMessage(payload[0].messages[0]);
  assert.equal(reparsed._source_role_exact, false);
  const census = buildSourceMessageRoleCensus([reparsed]);
  assert.equal(census.observation_complete, false);
  assert.equal(census.invalid_count, 1);
  const mergedPayload = buildSelectedJsonPayload([buildMergedTimelineConversation([source])]);
  assert.equal(mergedPayload[0].messages[0].source_role_exact, false);
  assert.equal(normalizeMessage(mergedPayload[0].messages[0])._source_role_exact, false);
  const monthlyPayload = buildSelectedJsonPayload(buildMonthlyNodeConversations([source]));
  assert.equal(monthlyPayload[0].messages[0].source_role_exact, false);
  assert.equal(normalizeMessage(monthlyPayload[0].messages[0])._source_role_exact, false);
});
