import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openSnapshotStore } from '../src/index.mjs';
import { createSnapshotStream } from '../src/http.mjs';

test('SSE delivers initial and committed snapshots, reconnects to latest and closes cleanly', { timeout: 10_000 }, async () => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const workspace = basename(dirname(project.slice(0, -1))) === 'products' ? resolve(project, '../..') : project;
  const store = await openSnapshotStore({
    file: resolve(workspace, 'temp/relay-state-tests', randomUUID(), 'state.json'),
    initial: { id: 'example', revision: 0 },
  });
  const stream = createSnapshotStream(store, { eventId: record => `${record.value.id}:${record.value.revision}` });
  const server = createServer((request, response) => stream.handle(request, response));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}`;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 7000);
  let reader;

  async function observe() {
    const response = await fetch(url, { signal: abort.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    reader = response.body.getReader();
    let buffer = '';
    const decoder = new TextDecoder();
    return async () => {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (data) return { id: frame.split('\n').find(line => line.startsWith('id: '))?.slice(4), ...JSON.parse(data.slice(6)) };
          continue;
        }
        const next = await reader.read();
        if (next.done) return null;
        buffer += decoder.decode(next.value, { stream: true });
      }
    };
  }

  try {
    const method = await fetch(url, { method: 'POST' });
    assert.equal(method.status, 405);
    await method.text();
    let next = await observe();
    assert.deepEqual(await next(), { id: 'example:0', value: { id: 'example', revision: 0 } });
    await store.transact(draft => {
      draft.revision += 1;
      return { state: draft, result: 'updated' };
    }, { change: { tool: 'external-tool' } });
    const updated = await next();
    assert.equal(updated.id, 'example:1');
    assert.equal(updated.change.tool, 'external-tool');
    await reader.cancel();
    next = await observe();
    assert.deepEqual(await next(), { id: 'example:1', value: { id: 'example', revision: 1 } });
    stream.close();
    assert.equal(await next(), null);
  } finally {
    clearTimeout(timeout);
    abort.abort();
    stream.close();
    await store.close();
    await new Promise(done => { server.close(done); server.closeIdleConnections(); });
  }
});
