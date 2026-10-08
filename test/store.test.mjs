import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openSnapshotStore } from '../src/index.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const workspace = basename(dirname(project.slice(0, -1))) === 'products' ? resolve(project, '../..') : project;
const fileFor = () => resolve(workspace, 'temp/relay-state-tests', randomUUID(), 'state.json');
const initial = () => ({ revision: 0, count: 0, privateNote: 'private' });
const increment = draft => {
  draft.revision += 1;
  draft.count += 1;
  return { state: draft, result: draft.count };
};

test('serialized reducers publish projected snapshots after their file commits; reopen resumes', async () => {
  const file = fileFor();
  const seen = [];
  const committedReads = [];
  const store = await openSnapshotStore({ file, initial, project: ({ revision, count }) => ({ revision, count }) });
  const stop = store.subscribe(record => {
    seen.push(record);
    // Start the read during delivery, before the next queued reducer starts.
    committedReads.push(readFile(file, 'utf8').then(JSON.parse));
  });
  const values = await Promise.all([
    store.transact(async draft => { await new Promise(done => setTimeout(done, 10)); return increment(draft); }, { change: { tool: 'increment' } }),
    store.transact(increment),
  ]);
  assert.deepEqual(values, [1, 2]);
  assert.deepEqual(seen.map(record => record.value.count), [0, 1, 2]);
  assert.deepEqual(seen[1].change, { tool: 'increment' });
  assert.equal(seen[1].value.privateNote, undefined);
  assert.deepEqual((await Promise.all(committedReads)).map(state => state.count), [0, 1, 2]);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).count, 2);
  stop();
  await store.close();
  const resumed = await openSnapshotStore({ file, initial });
  assert.equal(resumed.read().count, 2);
  await resumed.close();
});

test('declined, unchanged, invalid and failed reducers retain the committed view and keep the queue usable', async () => {
  const file = fileFor();
  const store = await openSnapshotStore({
    file, initial, validate: value => value.count >= 0,
    project: state => state.count === 50 ? Promise.reject(new Error('Async projection failed.')) : state,
  });
  const seen = [];
  store.subscribe(record => seen.push(record));
  const saved = await readFile(file, 'utf8');
  assert.equal(await store.transact(() => ({ commit: false, result: 'needs-input' })), 'needs-input');
  await store.transact(draft => ({ state: draft, result: 'read' }));
  await assert.rejects(store.transact(draft => { draft.count = -1; return { state: draft }; }), /validation failed/);
  await assert.rejects(store.transact(draft => { draft.count = 50; return { state: draft }; }), /synchronous snapshot projection/);
  await assert.rejects(store.transact(draft => { draft.count = 90; throw new Error('Reducer failed.'); }), /Reducer failed/);
  assert.equal(await readFile(file, 'utf8'), saved);
  assert.equal(store.read().count, 0);
  assert.equal(seen.length, 1);
  await store.transact(increment);
  assert.equal(store.read().count, 1);
  assert.equal(seen.length, 2);
  await store.close();
});

test('file replacement failure preserves memory and subscribers; a later transaction succeeds', async () => {
  const file = fileFor();
  const store = await openSnapshotStore({ file, initial });
  const seen = [];
  store.subscribe(record => seen.push(record));
  await rename(file, `${file}.saved`);
  await mkdir(file);
  await assert.rejects(store.transact(increment));
  assert.equal(store.read().count, 0);
  assert.equal(seen.length, 1);
  assert.equal(JSON.parse(await readFile(`${file}.saved`, 'utf8')).count, 0);
  await rename(file, `${file}.failed-directory`);
  await rename(`${file}.saved`, file);
  await store.transact(increment);
  assert.equal(store.read().count, 1);
  await store.close();
});

test('isolated reads, observer failures and close preserve the final committed value', async () => {
  const file = fileFor();
  const failures = [];
  const store = await openSnapshotStore({ file, initial, onSubscriberError: error => failures.push(error.message) });
  await assert.rejects(openSnapshotStore({ file, initial }), /already owns/);
  store.read().count = 90;
  store.snapshot().count = 90;
  store.subscribe(record => { record.value.count = 80; throw new Error('Observer failed.'); });
  const seen = [];
  store.subscribe(record => seen.push(record.value.count));
  const operation = store.transact(increment);
  const closing = store.close();
  await assert.rejects(store.transact(increment), /closed/);
  assert.equal(await operation, 1);
  await closing;
  assert.deepEqual(seen, [0, 1]);
  assert.equal(failures.length, 2);
  assert.equal(store.read().count, 1);
  const restored = await openSnapshotStore({ file, initial });
  assert.equal(restored.read().count, 1);
  await restored.close();
});

test('a malformed saved file fails startup and stays available for recovery', async () => {
  const file = fileFor();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, '{broken');
  await assert.rejects(openSnapshotStore({ file, initial }), SyntaxError);
  assert.equal(await readFile(file, 'utf8'), '{broken');
  await writeFile(file, JSON.stringify(initial()));
  const restored = await openSnapshotStore({ file, initial });
  await restored.close();
});
