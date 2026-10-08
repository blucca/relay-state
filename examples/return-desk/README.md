# Return Desk

A fictional parcel return with **one durable task across MCP sessions and a live browser view**. Record a label, report a parcel drop-off, restart the server, then resume the same return from a fresh MCP client.

This is an independent consumer of [`@blucca/relay-state`](../../README.md). Its workflow rules live in `domain.mjs`; its disk persistence and Server-Sent Events come from the library. All parcel and refund progress is user-reported sample data.

## Try it in ten minutes

Use Node.js 22 or later. From a Relay State checkout:

```sh
cd examples/return-desk
npm install
npm start
```

Open **http://127.0.0.1:4320**. In a second terminal, from the same directory:

```sh
# Discover the two tools through the official MCP SDK.
npm run demo -- tools

# A fresh MCP session reads the saved return.
npm run demo -- read

# A real tools/call writes the label report. Keep the browser open.
npm run demo -- label DEMO-LABEL-2048
```

The page updates to **Hand over the parcel**, with the reported reference and **revision 1**. Repeat the label command to see the saved result returned with `replayed: true`.

In the server terminal, press **Ctrl+C**, then run **`npm start`** again. Keep the same state file. The page reconnects to the saved return. In the second terminal:

```sh
# This command creates a new client and a fresh MCP initialization.
npm run demo -- read

# Continue the same task through its remaining reported steps.
npm run demo -- dropoff DEMO-DROPOFF-2048
npm run demo -- refund DEMO-REFUND-2048
```

The original task ID and label reference survive the process restart. After the last command, the browser shows **Return complete**, three saved references, and **revision 3**.

## The small integration

```js
import { openSnapshotStore } from '@blucca/relay-state';
import { createSnapshotStream } from '@blucca/relay-state/http';

const store = await openSnapshotStore({
  file: stateFile,
  initial: initialState,
  validate: validateState,
  project: projectState,
});
const events = createSnapshotStream(store, {
  eventId: ({ value }) => `${value.id}:${value.revision}`,
});

// MCP handler: recordStep returns { state, result, commit? }.
const result = await store.transact(draft => recordStep(draft, argumentsObject), {
  change: { tool: 'record_return_step', source: 'user_reported' },
});

// HTTP GET /events: same-origin checks run before this route.
events.handle(request, response);

// Browser: every event contains the current public snapshot.
new EventSource('/events').onmessage = event => {
  render(JSON.parse(event.data).value);
};
```

`get_return` reads `store.snapshot()`. A successful write saves the state before its update reaches subscribers. Each command opens and closes an official SDK Streamable HTTP client. The task lives in the file-backed store, independently of those transport sessions.

The consumer owns the step order, reports, public projection and revision checks. A repeated step with the same reference returns `commit: false`; stale revisions and out-of-order steps return an application error with the current snapshot. The browser holds a read-only SSE view.

## Files and settings

| File | Responsibility |
| --- | --- |
| `domain.mjs` | Sample task, two tool schemas, workflow, projection |
| `server.mjs` | Relay State store, official MCP transport, local HTTP routes |
| `demo-client.mjs` | A fresh real MCP client for each terminal command |
| `web/` | Plain HTML, CSS and JavaScript observing `/events` |

| Setting | Default |
| --- | --- |
| `RETURN_DESK_PORT` | `4320` |
| `RETURN_DESK_URL` | `http://127.0.0.1:4320` (CLI) |
| `RETURN_DESK_STATE_FILE` | Checkout `temp/return-desk/state.json`; workspace `temp/` for checkouts under `products/` |
| `RETURN_DESK_WORKSPACE_ROOT` | Workspace or checkout root used for the default state file |

To start a fresh example, choose a new state file:

```sh
RETURN_DESK_STATE_FILE="$PWD/../../temp/return-desk/second-return.json" npm start
```

Run one server process per state file. The server binds to `127.0.0.1`, checks loopback hosts and same-origin browser requests, and exposes a stateless MCP endpoint at `/mcp`. `GET /api/snapshot` returns the public view. Package dependencies pin Relay State's release tarball and official MCP SDK **1.32.1**.

The sample covers reported return progress for one fictional order. Carrier tracking, merchant submissions and payment operations are separate application integrations.
