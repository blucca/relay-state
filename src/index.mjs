import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const activeFiles = new Set();
const clone = value => structuredClone(value);

function jsonValue(value) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('Provide a JSON value.');
  return { text, value: JSON.parse(text) };
}

async function replaceFile(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const pending = `${file}.${process.pid}.${randomUUID()}.pending`;
  let handle;
  try {
    handle = await open(pending, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(pending, file);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(pending).catch(() => {});
    throw error;
  }
}

/** One store owns one JSON file. Each accepted transaction publishes after persistence. */
export async function openSnapshotStore({
  file, initial, validate = () => true, project = value => value,
  onSubscriberError = error => console.error('Relay State subscriber failed:', error.message),
}) {
  if (typeof file !== 'string' || file.length === 0) throw new TypeError('Provide a state file path.');
  file = resolve(file);
  if (activeFiles.has(file)) throw new Error('A Relay State store already owns this file in this process.');
  activeFiles.add(file);

  function prepare(candidate) {
    const encoded = jsonValue(candidate);
    const valid = validate(clone(encoded.value));
    if (typeof valid?.then === 'function') {
      Promise.resolve(valid).catch(() => {});
      throw new TypeError('Use a synchronous state validator.');
    }
    if (valid === false) throw new Error('Saved state validation failed.');
    const projection = project(clone(encoded.value));
    if (typeof projection?.then === 'function') {
      Promise.resolve(projection).catch(() => {});
      throw new TypeError('Use a synchronous snapshot projection.');
    }
    const view = jsonValue(projection).value;
    return { ...encoded, view };
  }

  let current;
  try {
    let source;
    let fresh = false;
    try { source = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      source = typeof initial === 'function' ? await initial() : initial;
      fresh = true;
    }
    current = prepare(source);
    if (fresh) await replaceFile(file, current.value);
  } catch (error) {
    activeFiles.delete(file);
    throw error;
  }

  let queue = Promise.resolve();
  let accepting = true;
  let closing;
  const observers = new Set();

  function subscriberFailure(error) {
    try { onSubscriberError(error); } catch { /* The committed transaction remains available. */ }
  }

  function deliver(listener, record) {
    try { Promise.resolve(listener(clone(record))).catch(subscriberFailure); }
    catch (error) { subscriberFailure(error); }
  }

  return {
    file,
    read: () => clone(current.value),
    snapshot: () => clone(current.view),
    subscribe(listener) {
      if (!accepting) throw new Error('Relay State store is closed.');
      if (typeof listener !== 'function') throw new TypeError('Provide a snapshot listener.');
      observers.add(listener);
      // Registration and the initial read share a synchronous turn.
      deliver(listener, { value: current.view });
      return () => observers.delete(listener);
    },
    transact(reducer, { change } = {}) {
      if (!accepting) return Promise.reject(new Error('Relay State store is closed.'));
      const metadata = change === undefined ? undefined : jsonValue(change).value;
      const operation = queue.then(async () => {
        const output = await reducer(clone(current.value));
        if (output === null || typeof output !== 'object') throw new TypeError('Return { state, result, commit? } from the reducer.');
        if (output.commit === false) return output.result;
        const candidate = prepare(output.state);
        if (candidate.text === current.text) return output.result;
        await replaceFile(file, candidate.value);
        current = candidate;
        const record = { value: current.view, ...(metadata === undefined ? {} : { change: metadata }) };
        for (const listener of [...observers]) deliver(listener, record);
        return output.result;
      });
      // A failed transaction leaves the next queued operation ready to run.
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    close() {
      accepting = false;
      closing ??= queue.then(() => {
        observers.clear();
        activeFiles.delete(file);
      });
      return closing;
    },
  };
}
