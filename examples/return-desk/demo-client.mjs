import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const actions = { label: 'label_ready', dropoff: 'dropped_off', refund: 'refund_received' };
const [action = 'read', reference] = process.argv.slice(2);
if (!['read', 'tools', ...Object.keys(actions)].includes(action) || (actions[action] && !reference)) {
  console.error('Usage: npm run demo -- read | tools | label <reference> | dropoff <reference> | refund <reference>');
  process.exitCode = 1;
} else {
  const endpoint = new URL('/mcp', process.env.RETURN_DESK_URL ?? 'http://127.0.0.1:4320');
  const client = new Client({ name: 'return-desk-demo-cli', version: '0.1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    if (action === 'tools') {
      console.log(JSON.stringify(await client.listTools(), null, 2));
    } else {
      const current = await client.callTool({ name: 'get_return', arguments: {} });
      const result = action === 'read' ? current : await client.callTool({
        name: 'record_return_step', arguments: {
          step: actions[action], reference, expectedRevision: current.structuredContent.return.revision,
        },
      });
      console.log(JSON.stringify(result.structuredContent, null, 2));
      if (result.isError) process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Return Desk command failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
