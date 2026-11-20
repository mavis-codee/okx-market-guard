import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer, serveStdio, LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../src/mcp/server.ts';
import { OkxClient } from '../src/okx-client.ts';
import { mockFetch, okEnvelope, SAMPLE_TICKER } from './helpers.ts';
import { PassThrough } from 'node:stream';

function serverWith(handler: Parameters<typeof mockFetch>[0]): McpServer {
  const { impl } = mockFetch(handler);
  return new McpServer(new OkxClient({ fetchImpl: impl }));
}

test('initialize negotiates protocol and advertises read-only tools', async () => {
  const s = serverWith(() => ({ body: okEnvelope([]) }));
  const line = await s.handleRaw(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        clientInfo: { name: 'test-client', version: '0.0.1' },
      },
    }),
  );
  assert.ok(line);
  const res = JSON.parse(line) as { result: Record<string, unknown> };
  assert.equal(res.result['protocolVersion'], '2025-03-26');
  const serverInfo = res.result['serverInfo'] as { name: string; version: string };
  assert.equal(serverInfo.name, 'okx-market-guard');
  const instructions = String(res.result['instructions']);
  assert.match(instructions, /read-only/i);
  assert.match(instructions, /no API key/i);
});

test('initialize falls back to latest for unknown version', async () => {
  const s = serverWith(() => ({ body: okEnvelope([]) }));
  const line = await s.handleRaw(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    }),
  );
  const res = JSON.parse(String(line)) as { result: { protocolVersion: string } };
  assert.equal(res.result.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.ok((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(LATEST_PROTOCOL_VERSION));
});

test('tools/list returns five read-only tools with schemas', async () => {
  const s = serverWith(() => ({ body: okEnvelope([]) }));
  const line = await s.handleRaw(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  const res = JSON.parse(String(line)) as {
    result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean }; inputSchema: unknown }> };
  };
  assert.equal(res.result.tools.length, 5);
  for (const t of res.result.tools) {
    assert.equal(t.annotations.readOnlyHint, true);
    assert.ok(t.inputSchema);
  }
  assert.deepEqual(
    res.result.tools.map((t) => t.name),
    ['market_ticker', 'market_candles', 'funding_rate', 'oi_summary', 'alert_check'],
  );
});

test('tools/call ticker returns content and isError=false', async () => {
  const s = serverWith(() => ({ body: okEnvelope([SAMPLE_TICKER]) }));
  const line = await s.handleRaw(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'market_ticker', arguments: { instId: 'BTC-USDT' } },
    }),
  );
  const res = JSON.parse(String(line)) as {
    result: { isError: boolean; content: Array<{ type: string; text: string }> };
  };
  assert.equal(res.result.isError, false);
  assert.equal(res.result.content[0]?.type, 'text');
  const payload = JSON.parse(res.result.content[0]?.text ?? '{}') as {
    ticker: { instId: string };
    readOnly: boolean;
  };
  assert.equal(payload.ticker.instId, 'BTC-USDT');
  assert.equal(payload.readOnly, true);
});

test('tools/call validation error is isError=true (agent-friendly)', async () => {
  const s = serverWith(() => ({ body: okEnvelope([]) }));
  const line = await s.handleRaw(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'market_ticker', arguments: { instId: 'NOT A ID' } },
    }),
  );
  const res = JSON.parse(String(line)) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0]?.text ?? '', /instId/);
});

test('tools/call unknown tool is JSON-RPC invalid params', async () => {
  const s = serverWith(() => ({ body: okEnvelope([]) }));
  const line = await s.handleRaw(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'place_order', arguments: {} },
    }),
  );
  const res = JSON.parse(String(line)) as { error: { code: number; message: string } };
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /place_order/);
  assert.match(res.error.message, /market_ticker/);
});

test('unknown method is -32601; ping works; bad JSON is -32700; notification is null', async () => {
  const s = serverWith(() => ({ body: okEnvelope([]) }));

  const unknown = await s.handleRaw(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'nope' }));
  const unknownRes = JSON.parse(String(unknown)) as { error: { code: number } };
  assert.equal(unknownRes.error.code, -32601);

  const ping = await s.handleRaw(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }));
  const pingRes = JSON.parse(String(ping)) as { result: Record<string, unknown> };
  assert.deepEqual(pingRes.result, {});

  const bad = await s.handleRaw('{not json');
  const badRes = JSON.parse(String(bad)) as { error: { code: number } };
  assert.equal(badRes.error.code, -32700);

  const note = await s.handleRaw(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  );
  assert.equal(note, null);
});

test('serveStdio answers initialize on a PassThrough pipe', async () => {
  const { impl } = mockFetch(() => ({ body: okEnvelope([SAMPLE_TICKER]) }));
  const client = new OkxClient({ fetchImpl: impl });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stderr.resume();

  const serving = serveStdio(client, { stdin, stdout, stderr });
  stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name: 't', version: '1' } },
    }) + '\n',
  );
  stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'market_ticker', arguments: { instId: 'BTC-USDT' } },
    }) + '\n',
  );
  stdin.end();

  const chunks: string[] = [];
  stdout.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
  await serving;

  const lines = chunks.join('').trim().split('\n');
  assert.equal(lines.length, 2);
  const init = JSON.parse(lines[0] ?? '{}') as { result: { protocolVersion: string } };
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const call = JSON.parse(lines[1] ?? '{}') as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  assert.equal(call.result.isError, false);
  assert.match(call.result.content[0]?.text ?? '', /BTC-USDT/);
});
