import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataRoot = await mkdtemp(join(tmpdir(), 'driftstone-memory-read-empty-'));
process.env.DRIFTSTONE_DATA_ROOT = dataRoot;

const { handleMemoryReadRoute } = await import('../routes/product/memory-read.js');

function createJsonCaptureResponse() {
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = '') {
      this.body = String(body || '');
    }
  };
  return response;
}

test.after(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

test('memory overview returns an empty uninitialized packet for a fresh data root', async () => {
  const response = createJsonCaptureResponse();
  const handled = await handleMemoryReadRoute(
    { method: 'GET' },
    response,
    new URL('http://127.0.0.1:3460/api/memory/overview')
  );
  const payload = JSON.parse(response.body);

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.schema, 'memory_overview_v0.1');
  assert.equal(payload.source.status, 'uninitialized');
  assert.equal(payload.source.root_count, 0);
  assert.equal(payload.source.vine_edge_count, 0);
  assert.deepEqual(payload.sample_roots, []);
});
