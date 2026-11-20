/**
 * OKX Market Guard — live demo against OKX public REST.
 * READ-ONLY. No API key, no orders, no account access.
 *
 * Run: node demo/demo.ts
 * Behind a proxy: NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://host:port node demo/demo.ts
 */
import { OkxClient } from '../src/okx-client.ts';
import { TOOLS } from '../src/tools/index.ts';
import { McpServer } from '../src/mcp/server.ts';
import { VERSION, SERVER_NAME } from '../src/version.ts';

const client = new OkxClient();
const server = new McpServer(client);

function banner(): void {
  console.log('='.repeat(72));
  console.log(`${SERVER_NAME} v${VERSION} — demo`);
  console.log('READ-ONLY OKX public market REST (www.okx.com /api/v5)');
  console.log('No API key. No orders. No withdrawals. No account access.');
  console.log('='.repeat(72));
}

async function section(title: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  try {
    await fn();
  } catch (err) {
    console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function pp(label: string, value: unknown): void {
  console.log(`${label}:`);
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  banner();

  await section('MCP initialize', async () => {
    const line = await server.handleRaw(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          clientInfo: { name: 'demo', version: '0.1.0' },
        },
      }),
    );
    console.log(line?.trim() ?? '');
  });

  await section('MCP tools/list (names only)', async () => {
    const line = await server.handleRaw(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    const res = JSON.parse(line ?? '{}') as { result?: { tools?: Array<{ name: string; title: string }> } };
    for (const t of res.result?.tools ?? []) {
      console.log(`  ${t.name.padEnd(16)} ${t.title}`);
    }
  });

  const ticker = TOOLS.find((t) => t.name === 'market_ticker');
  const candles = TOOLS.find((t) => t.name === 'market_candles');
  const funding = TOOLS.find((t) => t.name === 'funding_rate');
  const oi = TOOLS.find((t) => t.name === 'oi_summary');
  const alert = TOOLS.find((t) => t.name === 'alert_check');
  if (!ticker || !candles || !funding || !oi || !alert) throw new Error('tools missing');

  await section('market_ticker BTC-USDT', async () => {
    pp('result', await ticker.run({ instId: 'BTC-USDT' }, client));
  });

  await section('market_candles BTC-USDT 1H x3 (newest first)', async () => {
    pp('result', await candles.run({ instId: 'BTC-USDT', bar: '1H', limit: 3 }, client));
  });

  await section('funding_rate BTC-USDT-SWAP', async () => {
    pp('result', await funding.run({ instId: 'BTC-USDT-SWAP' }, client));
  });

  await section('oi_summary BTC-USDT-SWAP', async () => {
    pp('result', await oi.run({ instId: 'BTC-USDT-SWAP' }, client));
  });

  await section('alert_check BTC-USDT last > 0 (should trigger)', async () => {
    pp('result', await alert.run({ instId: 'BTC-USDT', metric: 'last', op: 'gt', threshold: 0 }, client));
  });

  await section('alert_check BTC-USDT last > 1e9 (should not trigger)', async () => {
    pp('result', await alert.run({ instId: 'BTC-USDT', metric: 'last', op: 'gt', threshold: 1e9 }, client));
  });

  await section('safety: funding on a spot instId is rejected before any HTTP call', async () => {
    try {
      await funding.run({ instId: 'BTC-USDT' }, client);
    } catch (err) {
      console.log(`rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  await section('safety: private path is rejected by allowlist', async () => {
    try {
      await client.get('/api/v5/account/balance');
    } catch (err) {
      console.log(`rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  console.log('\n--- done ---');
  console.log('All calls above were public read-only GETs to https://www.okx.com/api/v5/*');
}

await main();
