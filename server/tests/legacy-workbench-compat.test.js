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

function legacyMemoGeometryHarness(options = {}) {
  const strategy = options.strategy || 'window';
  const targetChars = Number(options.targetChars || 20000);
  const overlapChars = Number(options.overlapChars || 0);
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    [
      `globalThis.getMemoJsonStrategy = () => ${JSON.stringify(strategy)};`,
      `globalThis.getMemoChunkParams = () => ({ targetChars: ${targetChars}, overlapChars: ${overlapChars} });`,
      "globalThis.parseOpenAIJson = (value) => value;",
      "globalThis.getMessageDateRange = () => ({ startDate: '2025-02-01', endDate: '2025-02-01', startCompact: '20250201', endCompact: '20250201' });",
      "globalThis.slugifySourceToken = (value) => String(value || 'conversation').replace(/[^A-Za-z0-9]+/g, '-');",
      "globalThis.stableSourceHash = (value) => String(value.length).padStart(10, '0');",
      "globalThis.buildExportText = (conversations) => conversations.flatMap((conversation) => conversation.messages || []).map((message) => `[SRC window_id=\"${message.source_window_id}\" window_title=\"${message.source_window_title || ''}\" msg=${message.source_msg_index}]\n${String(message.role || 'assistant').toUpperCase()}:\n${message.content}`).join('\\n');",
      extractFunction(legacyHtml, 'createImportError'),
      extractFunction(legacyHtml, 'normalizeSourceMessageRole'),
      extractFunction(legacyHtml, 'normalizeBodyFreeSourceId'),
      extractFunction(legacyHtml, 'normalizePositiveSourceMsgIndex'),
      extractFunction(legacyHtml, 'buildSourceMessageRoleCensus'),
      extractFunction(legacyHtml, 'toSafeInt'),
      extractFunction(legacyHtml, 'estimateMessageSize'),
      extractFunction(legacyHtml, 'splitMessagesByCharBudget'),
      extractFunction(legacyHtml, 'partitionMessagesByExactSourceWindow'),
      extractFunction(legacyHtml, 'collectChunkSourceRanges'),
      extractFunction(legacyHtml, 'buildMemoChunkId'),
      extractFunction(legacyHtml, 'buildConversationChunkText'),
      extractFunction(legacyHtml, 'parseExtractMetaBlock'),
      extractFunction(legacyHtml, 'projectPreparedTextSourceGeometry'),
      extractFunction(legacyHtml, 'readJsonText'),
      extractFunction(legacyHtml, 'readMemoFileEntries').replace(/^function /, 'async function '),
      'globalThis.partitionMessagesByExactSourceWindow = partitionMessagesByExactSourceWindow;',
      'globalThis.projectPreparedTextSourceGeometry = projectPreparedTextSourceGeometry;',
      'globalThis.readMemoFileEntries = readMemoFileEntries;'
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
    declared_source_ref: 'window_20250201_window-a_msg_012'
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
    declared_source_ref: 'window_20250201_window-a_msg_011 | window_20250201_window-a_msg_012'
  }, census, { user_name: 'A-Yuan', bot_name: 'Companion' });
  assert.equal(exactUser.ok, true);
  assert.equal(exactUser.status, 'source_role_lineage_exact');
  assert.equal(exactUser.primary_source_role, 'user');
  const legacyUnbound = projectSqlSourceRoleLineage({
    ...exactUser,
    record: {
      fact_id: 'fact-legacy-unbound',
      fact_key: 'user_prefers_exact_receipts',
      anchor_name: 'A-Yuan',
      source_window_id: 'window-a',
      source_msg_start: 11,
      source_msg_end: 11
    },
    declared_source_ref: 'window_20250201_msg_011'
  }, census, { user_name: 'A-Yuan', bot_name: 'Companion' });
  assert.equal(legacyUnbound.ok, false);
  assert.equal(legacyUnbound.status, 'source_ref_window_unbound');
});

test('legacy SQL prompt requires every semantic claim to mirror its exact source messages', () => {
  const { buildSqlSystemPrompt } = legacySqlPromptHarness();
  const prompt = buildSqlSystemPrompt('BASE PROMPT');
  assert.match(prompt, /`source_ref` 不是“主要出处”，而是这条 fact 的完整证据清单/);
  assert.match(prompt, /fact_value、note、recurrence_rule、因果、状态变化或结果/);
  assert.match(prompt, /多条引用用 ` \| ` 分隔/);
  assert.match(prompt, /同一 chunk 不能替代逐条来源/);
  assert.match(prompt, /不能挂到更早消息的 source_ref 上/);
  assert.match(prompt, /source_ref_hint.*exact window token/);
  assert.match(prompt, /旧示例 `window_YYYYMMDD_msg_XXX`.*不得用于本轮新输出/);
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
    { record: { ...base, fact_id: 'fact-valid' }, declared_source_ref: 'window_20250201_window-a_msg_011' },
    { record: { ...base, fact_id: 'fact-invalid' }, declared_source_ref: 'window_20250201_window-a_msg_012' }
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
    declared_source_ref: 'window_20250201_window-a_msg_012'
  };
  const unknown = projectSqlSourceRoleLineage(generic, census, {
    user_name: 'A-Yuan', bot_name: 'Companion'
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, 'source_subject_role_unknown');
  const explicitOther = projectSqlSourceRoleLineage({
    ...generic,
    record: { ...generic.record, source_subject_role: 'other' }
  }, census, { user_name: 'A-Yuan', bot_name: 'Companion' });
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

test('legacy memo producer emits exact single-window chunks with complete source conservation', async () => {
  const { readMemoFileEntries } = legacyMemoGeometryHarness();
  const buildMessages = (sourceWindowId, sourceWindowTitle, start, count) => Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `${sourceWindowId}-${start + index}`,
    ts: 1,
    source_window_id: sourceWindowId,
    source_window_title: sourceWindowTitle,
    source_msg_index: start + index
  }));
  const messagesA = buildMessages('window-a', 'Shared title', 918, 37);
  const messagesB = buildMessages('window-b', 'Shared title', 201, 27);
  const conversation = {
    id: 'month-bundle-202502',
    title: '2025-02 · 2 windows',
    source_bundle_id: 'src.2025-02.bundle',
    source_window_count: 2,
    source_window_ranges: [
      { source_window_id: 'window-a', source_window_title: 'Shared title', start_msg_index: 918, end_msg_index: 954, message_count: 37 },
      { source_window_id: 'window-b', source_window_title: 'Shared title', start_msg_index: 201, end_msg_index: 227, message_count: 27 }
    ],
    messages: messagesA.concat(messagesB)
  };
  const before = JSON.stringify(conversation);
  const entries = await readMemoFileEntries({
    name: 'memsrc_2025-02_bundle.json',
    text: async () => JSON.stringify([conversation])
  });
  assert.equal(entries.length, 2);
  assert.deepEqual(Array.from(entries, entry => entry.source_window_id), ['window-a', 'window-b']);
  assert.deepEqual(Array.from(entries, entry => [entry.source_msg_start, entry.source_msg_end]), [[918, 954], [201, 227]]);
  assert.deepEqual(Array.from(entries, entry => entry._source_message_census.message_count), [37, 27]);
  assert.equal(entries.reduce((sum, entry) => sum + entry._source_message_census.message_count, 0), 64);
  assert.equal(entries[0].source_ref, 'window_20250201_window-a_msg_918');
  assert.equal(entries[1].source_ref, 'window_20250201_window-b_msg_201');
  assert.equal(entries.every(entry => entry._source_message_census.window_count === 1), true);
  const coordinates = entries.flatMap(entry => Array.from(
    entry._source_message_census.messages,
    row => `${row.source_window_id}:${row.source_msg_index}`
  ));
  assert.equal(new Set(coordinates).size, 64);
  entries.forEach((entry) => {
    const markerIndexes = [...entry.text.matchAll(/^\[SRC\s+[^\]]*msg=(\d+)[^\]]*\]$/gm)].map(match => Number(match[1]));
    assert.equal(markerIndexes.length, entry._source_message_census.message_count);
    assert.equal(markerIndexes.every(index => index >= entry.source_msg_start && index <= entry.source_msg_end), true);
    assert.equal(entry.text.includes(`window_id="${entry.source_window_id}"`), true);
    assert.equal(entry.text.includes('window_title="Shared title"'), true);
  });
  assert.equal(JSON.stringify(conversation), before);
});

test('legacy memo char splitting never crosses an exact source window', async () => {
  const { readMemoFileEntries } = legacyMemoGeometryHarness({ strategy: 'chunk', targetChars: 1000, overlapChars: 0 });
  const messages = [];
  for (const sourceWindowId of ['window-a', 'window-b']) {
    for (let index = 1; index <= 6; index += 1) {
      messages.push({
        role: 'user',
        content: `${sourceWindowId}-${index}-${'x'.repeat(420)}`,
        ts: index,
        source_window_id: sourceWindowId,
        source_window_title: 'Same display title',
        source_msg_index: index
      });
    }
  }
  const entries = await readMemoFileEntries({
    name: 'two-windows.json',
    text: async () => JSON.stringify([{
      id: 'month-bundle',
      title: 'Two windows',
      source_window_count: 2,
      source_window_ranges: [
        { source_window_id: 'window-a', source_window_title: 'Same display title', start_msg_index: 1, end_msg_index: 6, message_count: 6 },
        { source_window_id: 'window-b', source_window_title: 'Same display title', start_msg_index: 1, end_msg_index: 6, message_count: 6 }
      ],
      messages
    }])
  });
  assert.ok(entries.length > 2);
  assert.equal(entries.every(entry => entry._source_message_census.window_count === 1), true);
  assert.equal(entries.every(entry => (
    entry._source_message_census.messages.every(row => row.source_window_id === entry.source_window_id)
  )), true);
  assert.deepEqual([...new Set(entries.map(entry => entry.source_window_id))], ['window-a', 'window-b']);
  assert.equal(entries.reduce((sum, entry) => sum + entry._source_message_census.message_count, 0), 12);
});

test('legacy memo producer fails closed when a multi-window message lacks exact geometry', async () => {
  const { readMemoFileEntries } = legacyMemoGeometryHarness();
  const file = {
    name: 'invalid-month.json',
    text: async () => JSON.stringify([{
      id: 'month-bundle',
      title: 'Invalid month',
      source_window_count: 2,
      source_window_ranges: [
        { source_window_id: 'window-a', source_window_title: 'A', start_msg_index: 1, end_msg_index: 1, message_count: 1 },
        { source_window_id: 'window-b', source_window_title: 'B', start_msg_index: 1, end_msg_index: 1, message_count: 1 }
      ],
      messages: [
        { role: 'user', content: 'exact', source_window_id: 'window-a', source_window_title: 'A', source_msg_index: 1 },
        { role: 'assistant', content: 'missing id', source_window_title: 'B', source_msg_index: 1 }
      ]
    }])
  };
  await assert.rejects(() => readMemoFileEntries(file), error => error && error.code === 'MEMO_SOURCE_GEOMETRY_INVALID');
});

test('legacy memo producer rejects partial window and message coordinates', async () => {
  const { readMemoFileEntries } = legacyMemoGeometryHarness();
  const read = (messages) => readMemoFileEntries({
    name: 'partial-coordinates.json',
    text: async () => JSON.stringify([{ id: 'ordinary-window', title: 'Ordinary', messages }])
  });
  await assert.rejects(() => read([
    { role: 'user', content: 'first', source_window_id: 'window-a', source_msg_index: 1 },
    { role: 'assistant', content: 'second', source_msg_index: 2 }
  ]), error => error && error.code === 'MEMO_SOURCE_GEOMETRY_INVALID');
  await assert.rejects(() => read([
    { role: 'user', content: 'first', source_window_id: 'window-a', source_msg_index: 1 },
    { role: 'assistant', content: 'second', source_window_id: 'window-a' }
  ]), error => error && error.code === 'MEMO_SOURCE_GEOMETRY_INVALID');
  const raw = await read([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' }
  ]);
  assert.equal(raw.length, 1);
  assert.equal(raw[0].source_window_id, 'ordinary-window');
  assert.deepEqual(Array.from(raw[0]._source_message_census.messages, row => row.source_msg_index), [1, 2]);
});

test('legacy memo producer rejects gapped and out-of-order physical message indexes', async () => {
  const { readMemoFileEntries } = legacyMemoGeometryHarness();
  const read = (indexes) => readMemoFileEntries({
    name: 'invalid-index-order.json',
    text: async () => JSON.stringify([{
      id: 'window-a',
      title: 'Window A',
      source_window_count: 1,
      source_window_ranges: [{
        source_window_id: 'window-a',
        source_window_title: 'Window A',
        start_msg_index: 1,
        end_msg_index: 3,
        message_count: indexes.length
      }],
      messages: indexes.map(index => ({
        role: 'user',
        content: `message-${index}`,
        source_window_id: 'window-a',
        source_window_title: 'Window A',
        source_msg_index: index
      }))
    }])
  });
  for (const indexes of [[1, 3], [2, 1, 3]]) {
    await assert.rejects(
      () => read(indexes),
      error => error && error.code === 'MEMO_SOURCE_GEOMETRY_INVALID'
    );
  }
});

test('legacy memo source refs bind the exact window even at the same date and message index', async () => {
  const { readMemoFileEntries } = legacyMemoGeometryHarness();
  const { parseSourceRoleRef, buildSourceMessageRoleCensus, projectSqlSourceRoleLineage } = legacySourceRoleHarness();
  const entries = await readMemoFileEntries({
    name: 'same-coordinate.json',
    text: async () => JSON.stringify([{
      id: 'month-bundle',
      title: 'Same coordinate',
      source_window_count: 2,
      source_window_ranges: [
        { source_window_id: 'window-a', source_window_title: 'Same', start_msg_index: 1, end_msg_index: 1, message_count: 1 },
        { source_window_id: 'window-b', source_window_title: 'Same', start_msg_index: 1, end_msg_index: 1, message_count: 1 }
      ],
      messages: [
        { role: 'user', content: 'a', ts: 1, source_window_id: 'window-a', source_window_title: 'Same', source_msg_index: 1 },
        { role: 'user', content: 'b', ts: 1, source_window_id: 'window-b', source_window_title: 'Same', source_msg_index: 1 }
      ]
    }])
  });
  assert.deepEqual(Array.from(entries, entry => entry.source_ref), [
    'window_20250201_window-a_msg_001',
    'window_20250201_window-b_msg_001'
  ]);
  assert.notEqual(entries[0].source_ref, entries[1].source_ref);
  assert.equal(parseSourceRoleRef(entries[0].source_ref).ok, true);
  assert.equal(parseSourceRoleRef(entries[0].source_ref).window_token, 'window-a');
  assert.equal(parseSourceRoleRef('window_20250201_msg_001').ok, true);
  assert.equal(parseSourceRoleRef('window_20250201_msg_001').window_token, '');
  const census = buildSourceMessageRoleCensus([
    { role: 'user', source_window_id: 'window-b', source_msg_index: 1 }
  ]);
  const mismatch = projectSqlSourceRoleLineage({
    record: {
      fact_id: 'fact-window-mismatch',
      fact_key: 'user_preference',
      anchor_name: 'A-Yuan',
      source_window_id: 'window-b',
      source_msg_start: 1,
      source_msg_end: 1
    },
    declared_source_ref: entries[0].source_ref
  }, census, { user_name: 'A-Yuan', bot_name: 'Companion' });
  assert.equal(mismatch.status, 'source_ref_window_mismatch');
});

test('legacy mixed prepared chunks remain invalid instead of being migrated', async () => {
  const { readMemoFileEntries } = legacyMemoGeometryHarness();
  const mixed = [
    '[EXTRACT_META]',
    'chunk_id_hint: chunk.legacy.mixed',
    'source_window_id_hint: window-a',
    'source_window_title_hint: Window A',
    'source_msg_start_hint: 10',
    'source_msg_end_hint: 11',
    '[/EXTRACT_META]',
    '',
    '[SRC window="Window A" msg=10]',
    'USER:',
    'first',
    '[SRC window="Window B" msg=20]',
    'ASSISTANT:',
    'second'
  ].join('\n');
  await assert.rejects(
    () => readMemoFileEntries({ name: 'legacy-mixed.md', text: async () => mixed }),
    error => error && error.code === 'MEMO_SOURCE_GEOMETRY_INVALID'
  );
  assert.equal(mixed.includes('Window B'), true);
});

test('legacy prepared chunk geometry rejects duplicate, missing, and out-of-order markers', async () => {
  const { readMemoFileEntries } = legacyMemoGeometryHarness();
  const prepared = (indexes) => [
    '[EXTRACT_META]',
    'chunk_id_hint: chunk.legacy.geometry',
    'source_window_id_hint: window-a',
    'source_window_title_hint: Window A',
    'source_msg_start_hint: 1',
    'source_msg_end_hint: 3',
    '[/EXTRACT_META]',
    '',
    ...indexes.flatMap(index => [
      `[SRC window_id="window-a" window_title="Window A" msg=${index}]`,
      'USER:',
      `message-${index}`
    ])
  ].join('\n');
  for (const indexes of [[1, 1, 3], [1, 3], [1, 3, 2]]) {
    await assert.rejects(
      () => readMemoFileEntries({ name: 'legacy-geometry.md', text: async () => prepared(indexes) }),
      error => error && error.code === 'MEMO_SOURCE_GEOMETRY_INVALID'
    );
  }
  const exact = await readMemoFileEntries({ name: 'legacy-exact.md', text: async () => prepared([1, 2, 3]) });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].source_msg_start, 1);
  assert.equal(exact[0].source_msg_end, 3);
  const crossWindow = prepared([1, 2, 3]).replace(/window_id="window-a"/, 'window_id="window-b"');
  await assert.rejects(
    () => readMemoFileEntries({ name: 'legacy-cross-window.md', text: async () => crossWindow }),
    error => error && error.code === 'MEMO_SOURCE_GEOMETRY_INVALID'
  );
});
