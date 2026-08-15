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
  const braceStart = source.indexOf('{', start);
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
