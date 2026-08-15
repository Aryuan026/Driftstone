import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNotFoundPayload, buildRouteCatalog } from '../routes/registry.js';

function routePaths(groups) {
  return groups.flatMap((group) => group.routes.map((route) => route.path));
}

test('route catalog hides diagnostic and legacy routes by default', () => {
  const groups = buildRouteCatalog();
  const paths = routePaths(groups);

  assert.equal(groups.some((group) => group.lane === 'diagnostic'), false);
  assert.equal(paths.includes('/api/memory/reviewed/finalize'), false);
  assert.equal(paths.includes('/api/memory/write'), false);
  assert.equal(paths.includes('/api/memory/root'), false);
  assert.equal(paths.includes('/api/memory/ingest'), true);
});

test('route catalog can include legacy diagnostics explicitly', () => {
  const groups = buildRouteCatalog({ includeDiagnostic: true });
  const paths = routePaths(groups);

  assert.equal(groups.some((group) => group.lane === 'diagnostic'), true);
  assert.equal(paths.includes('/api/memory/reviewed/finalize'), true);
  assert.equal(paths.includes('/api/memory/write'), true);
  assert.equal(paths.includes('/api/memory/root'), true);
  assert.equal(groups.some((group) => group.routes.some((route) => Object.prototype.hasOwnProperty.call(route, 'legacy'))), false);
});

test('not found payload does not advertise legacy write paths', () => {
  const payload = buildNotFoundPayload();

  assert.equal(payload.diagnostic_hidden, true);
  assert.equal(payload.routes.includes('POST /api/memory/reviewed/finalize'), false);
  assert.equal(payload.routes.includes('POST /api/memory/write'), false);
  assert.match(payload.diagnostic_hint, /include_diagnostic=true/);
});
