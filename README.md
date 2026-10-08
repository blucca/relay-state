# Relay State

**Keep the screen on the same saved state as the agent.**

A small, dependency-free Node library for local MCP applications with a companion browser screen. It serializes state changes, saves the JSON file, then publishes the committed view. A fresh tool session and a reconnecting screen resume the same application object.

```text
MCP tool ──→ isolated reducer ──→ atomic JSON replacement
                                            │
                                    committed projection
                                     ↙              ↘
                              tool result        live screens
```

Extracted from [Recall Relay](https://github.com/blucca/recall-relay), where an assistant updated a recall case while the open screen stayed on an earlier step. The [Return Desk example](examples/return-desk/) applies the same package to an unrelated return workflow.

## Install

Node 22+. The versioned package is distributed through GitHub Releases:

```sh
npm install https://github.com/blucca/relay-state/releases/download/v0.1.0/blucca-relay-state-0.1.0.tgz
```

The package includes JavaScript, TypeScript declarations and the MIT license. Runtime dependencies: 0.

## Add a store

```js
import { openSnapshotStore } from '@blucca/relay-state';

const store = await openSnapshotStore({
  file: './temp/return.json',
  initial: () => ({ id: 'return-1', revision: 0, step: 'label', internalNote: '' }),
  validate: state => Number.isInteger(state.revision) && state.revision >= 0,
  project: ({ id, revision, step }) => ({ id, revision, step }),
});

// Call this from your MCP tool handler. The domain owns its transitions.
const result = await store.transact(draft => {
  draft.step = 'drop-off';
  draft.revision += 1;
  return { state: draft, result: { ok: true, next: 'Drop off the parcel' } };
}, { change: { tool: 'record_label', at: new Date().toISOString() } });
```

`transact` resolves after the file replacement and observer delivery. Reducers receive isolated copies, in call order. `commit: false` returns a domain result while retaining the saved state. An unchanged JSON value retains the current snapshot. A reducer, validator, projection or file-write failure rejects the transaction and preserves the last committed in-memory view; the queue continues with the next operation.

## Connect a screen

```js
import { createSnapshotStream } from '@blucca/relay-state/http';

const events = createSnapshotStream(store, {
  eventId: ({ value }) => `${value.id}:${value.revision}`,
});

// Inside your application's authenticated /events route:
events.handle(request, response);
```

```js
// Browser, same origin as the server:
const events = new EventSource('/events');
events.onmessage = event => {
  const { value, change } = JSON.parse(event.data);
  render(value);
};
```

Every connection immediately receives the current full snapshot. Later events follow successful commits. Browser `EventSource` reconnects automatically; the new connection starts at the latest saved view. Optional event IDs identify snapshots. The reconnect strategy is full-state resynchronization.

The stream provides heartbeats, connection cleanup and slow-client reconnection. `encode(record)` supports an existing wire shape, such as Recall Relay's `{ ok, case, change }`.

## API and operating scope

| API | Result |
| --- | --- |
| `openSnapshotStore({ file, initial, validate?, project?, onSubscriberError? })` | Loads the JSON file, or creates it from `initial` on first use. |
| `store.read()` / `store.snapshot()` | Isolated copies of saved state / public projection. |
| `store.transact(reducer, { change? })` | Serializes an async or sync reducer returning `{ state, result, commit? }`. |
| `store.subscribe(listener)` | Immediate `{ value }`, then `{ value, change? }` after commits; returns unsubscribe. |
| `store.close()` | Stops new transactions and drains accepted work. |
| `createSnapshotStream(store, options)` | Node HTTP SSE adapter, with `handle(req, res)` and `close()`. |

**Deployment contract:** one application process owns each state file and every mutation uses that store. Use a local filesystem supporting atomic rename. State and projections use JSON values; validators and projections run synchronously. Files preserve the application's existing JSON shape and use mode `0600` when created. Persistence covers server process restarts.

The application owns schema migration, domain revisions, retry/request IDs, access control and remote deployment. Use `project` to choose the fields that observers receive. The loopback Return Desk example implements its route and origin checks. Shutdown order: stop incoming requests, close the event stream, await `store.close()`, finish HTTP shutdown. Synchronous listener delivery is part of commit completion; async listener work runs independently and reports failures through `onSubscriberError`.

## A complete second application

[Return Desk](examples/return-desk/) contains its own domain model, MCP server, live page and CLI. Try this story:

1. Open its browser page and keep the tab open.
2. Use a fresh MCP client to record a return label received.
3. Watch the existing page move to parcel drop-off.
4. Restart the server using the same file.
5. Connect a new MCP client and resume that return.

The example installs this package from the versioned release URL. All order data is synthetic and progress is user-reported. Recall Relay is the original consumer; its domain engine and existing state files remain intact.

## Relationship to existing tools

- [MCP Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) model durable execution of a request. Relay State holds the business object that successive ordinary tool calls advance.
- [MCP resource subscriptions](https://modelcontextprotocol.io/specification/2025-11-25/server/resources#subscriptions) notify MCP clients of resource changes. This package's SSE adapter serves independent companion web pages.
- [MCP Apps patterns](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/patterns.md) describe polling, view state and server persistence. Relay State supplies the server-side commit-and-observe layer for a local application.
- [lowdb](https://github.com/typicode/lowdb) provides convenient atomic JSON storage. Relay State combines a serial reducer queue, isolated committed views and post-save subscriptions in one small API.

The contribution is a reusable integration pattern with two application consumers. Its value is the shared ordering contract from domain write to saved file to visible screen.

## Development

```sh
npm test
```

Focused checks cover transaction order, commit-before-publish, projected views, failed writes, observer isolation, process-independent file reopening, SSE reconnect and shutdown. Test artifacts live under `temp/`. [Independent installation evidence](docs/reuse-evidence.md) records the complete second-consumer run.

Built by blucca with an autonomous Codex agent handling research, implementation and verification. MIT licensed.
