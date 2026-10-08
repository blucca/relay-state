import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { openSnapshotStore } from '@blucca/relay-state';
import { createSnapshotStream } from '@blucca/relay-state/http';
import { initialState, validateState, projectState, recordStep, toolDefinitions } from './domain.mjs';

const exampleRoot = fileURLToPath(new URL('./', import.meta.url));
const repositoryRoot = resolve(exampleRoot, '../..');
const workspaceRoot = process.env.RETURN_DESK_WORKSPACE_ROOT
  ?? (basename(dirname(repositoryRoot)) === 'products' ? resolve(repositoryRoot, '../..') : repositoryRoot);
export const defaultStateFile = resolve(workspaceRoot, 'temp/return-desk/state.json');
const resources = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

export async function startServer(options = {}) {
  const port = Number(options.port ?? process.env.RETURN_DESK_PORT ?? 4320);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('RETURN_DESK_PORT accepts an integer from 0 to 65535.');
  const stateFile = resolve(options.stateFile ?? process.env.RETURN_DESK_STATE_FILE ?? defaultStateFile);
  const store = await openSnapshotStore({ file: stateFile, initial: initialState, validate: validateState, project: projectState });
  const stream = createSnapshotStream(store, { eventId: ({ value }) => `${value.id}:${value.revision}` });
  const activeMcp = new Set();
  let activePort;

  function createMcpServer() {
    const mcp = new Server({ name: 'return-desk', version: '0.1.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      let result;
      if (params.name === 'get_return') {
        result = { ok: true, return: store.snapshot() };
      } else if (params.name === 'record_return_step') {
        result = await store.transact(draft => recordStep(draft, params.arguments ?? {}), {
          change: { tool: params.name, source: 'user_reported' },
        });
      } else {
        result = { ok: false, error: { code: 'UNKNOWN_TOOL', message: 'Use tools/list to discover Return Desk tools.' } };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: !result.ok };
    });
    activeMcp.add(mcp);
    return mcp;
  }

  const http = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const hosts = new Set([`127.0.0.1:${activePort}`, `localhost:${activePort}`]);
    if (!hosts.has(request.headers.host)) return json(response, 403, { error: 'Use the Return Desk loopback URL.' });
    if ((request.headers.origin && request.headers.origin !== `http://${request.headers.host}`)
      || request.headers['sec-fetch-site'] === 'cross-site') {
      return json(response, 403, { error: 'Open this resource from the same local Return Desk origin.' });
    }
    try {
      const path = new URL(request.url, `http://${request.headers.host}`).pathname;
      if (path === '/mcp') {
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          return json(response, 405, { error: 'Use POST for this stateless Streamable HTTP MCP endpoint.' });
        }
        const mcp = createMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 32 * 1024 });
        response.once('close', () => { activeMcp.delete(mcp); void mcp.close(); });
        await mcp.connect(transport);
        await transport.handleRequest(request, response);
        return;
      }
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return json(response, 405, { error: 'Use GET for the view, snapshot, and event stream.' });
      }
      if (path === '/events') return stream.handle(request, response);
      if (path === '/api/snapshot') return json(response, 200, store.snapshot());
      const resource = resources.get(path);
      if (!resource) return json(response, 404, { error: 'Resource lookup failed. Open / for Return Desk.' });
      const body = await readFile(resolve(exampleRoot, 'web', resource[0]));
      response.writeHead(200, { 'Content-Type': resource[1] });
      response.end(body);
    } catch (error) {
      console.error(error);
      if (response.headersSent) response.destroy();
      else json(response, 500, { error: 'Request failed. Check the server log and resume the saved return.' });
    }
  });
  try {
    await new Promise((done, fail) => {
      http.once('error', fail);
      http.listen(port, '127.0.0.1', done);
    });
  } catch (error) {
    stream.close();
    await store.close();
    throw error;
  }
  activePort = http.address().port;
  let closing;
  return {
    url: `http://127.0.0.1:${activePort}`, stateFile,
    close() {
      closing ??= (async () => {
        stream.close();
        await new Promise((done, fail) => http.close(error => error ? fail(error) : done()));
        await Promise.all([...activeMcp].map(mcp => mcp.close()));
        await store.close();
      })();
      return closing;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await startServer();
  console.log(JSON.stringify({ event: 'listening', application: 'return-desk', url: server.url, mcp: `${server.url}/mcp`, stateFile: server.stateFile }));
  const stop = async () => { await server.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
