import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SnapshotRecord, SnapshotStore } from './index.mjs';
export function createSnapshotStream<State, View>(store: SnapshotStore<State, View>, options?: {
  eventId?: (record: SnapshotRecord<View>) => string | number | undefined;
  encode?: (record: SnapshotRecord<View>) => unknown;
  heartbeatMs?: number;
  retryMs?: number;
}): {
  handle(request: IncomingMessage, response: ServerResponse): void;
  close(): void;
};
