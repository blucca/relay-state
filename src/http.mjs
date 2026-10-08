/** A companion-screen SSE transport. Route and authenticate it in the host application. */
export function createSnapshotStream(store, {
  eventId, encode = record => record, heartbeatMs = 15_000, retryMs = 1500,
} = {}) {
  const clients = new Map();
  let closed = false;

  function detach(response) {
    const client = clients.get(response);
    if (client) {
      clearInterval(client.heartbeat);
      client.stop?.();
      clients.delete(response);
    }
  }

  return {
    handle(request, response) {
      if (closed) { response.writeHead(503); response.end('Snapshot stream is closed.'); return; }
      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET' });
        response.end('Use GET to observe committed snapshots.');
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      response.on('error', () => { detach(response); response.destroy(); });
      response.once('close', () => detach(response));
      const client = {};
      clients.set(response, client);
      const write = frame => {
        if (response.destroyed || response.writableEnded) { detach(response); return; }
        // A slow screen reconnects to the latest complete snapshot.
        if (!response.write(frame)) { detach(response); response.destroy(); }
      };
      write(`retry: ${Math.max(0, Math.trunc(retryMs))}\n\n`);
      try {
        const stop = store.subscribe(record => {
          try {
            const id = eventId?.(record);
            const prefix = id === undefined ? '' : `id: ${String(id).replace(/[\r\n\0]/g, '')}\n`;
            const data = JSON.stringify(encode(record));
            if (data === undefined) throw new TypeError('Encode each snapshot as a JSON value.');
            write(`${prefix}data: ${data}\n\n`);
          } catch { detach(response); response.destroy(); }
        });
        if (!clients.has(response)) { stop(); return; }
        client.stop = stop;
        client.heartbeat = setInterval(() => write(': keepalive\n\n'), heartbeatMs);
        client.heartbeat.unref();
      } catch { detach(response); response.end(); }
    },
    close() {
      closed = true;
      for (const response of clients.keys()) { detach(response); response.end(); }
    },
  };
}
