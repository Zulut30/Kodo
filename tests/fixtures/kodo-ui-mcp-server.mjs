// Offline protocol fixture, never a live browser adapter.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'kodo-offline-mcp-fixture', version: '1.0' }, { capabilities: { tools: {} } });
const names = ['list_pages', 'select_page', 'navigate_page', 'take_snapshot', 'evaluate_script', 'fill', 'click'];
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: names.map(name => ({ name, inputSchema: { type: 'object', properties: { pageId: { type: 'number' } } } })) }));
let value = '', submitted = false;
server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
  if (process.env.GEMINI_API_KEY || process.env.TYPESAFE_API_KEY || process.env.OPENAI_API_KEY) throw Error('Unexpected provider environment');
  const args = params.arguments; let text = 'ok';
  if (params.name === 'list_pages') text = '# list_pages response\n1: about:blank [selected]';
  else if (params.name === 'take_snapshot') text = 'uid=1_1 textbox "Name"\nuid=1_2 button "Verify"';
  else if (params.name === 'fill') { if (args.uid !== '1_1') throw Error('Wrong input'); value = args.value; }
  else if (params.name === 'click') { if (args.uid !== '1_2') throw Error('Wrong button'); submitted = true; }
  else if (params.name === 'evaluate_script') {
    const result = args.args ? (args.function.includes('#name') ? 0 : 1) : [{ exists: true, count: 1, text: submitted ? 'Verified ' + value : 'Not verified', value: null }];
    text = 'Script ran on page and returned:\n```json\n' + JSON.stringify(result) + '\n```';
  }
  return { content: [{ type: 'text', text }] };
});
await server.connect(new StdioServerTransport());
