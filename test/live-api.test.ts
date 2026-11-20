import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OkxClient, fetchTicker, fetchCandles, fetchFundingRate, fetchOpenInterest, fetchServerTime } from '../src/okx-client.ts';
import { TOOLS } from '../src/tools/index.ts';

const client = new OkxClient();

async function okxReachable(): Promise<boolean> {
  if (process.env['OKX_SKIP_LIVE'] === '1') return false;
  try {
    await fetchServerTime(client);
    return true;
  } catch {
    return false;
  }
}

const reach = await okxReachable();

test('live: server time', async (t) => {
  if (!reach) return t.skip('OKX public API unreachable (set HTTPS_PROXY + NODE_USE_ENV_PROXY=1)');
  const t0 = await fetchServerTime(client);
  assert.match(t0.ts, /^\d+$/);
  const now = Date.now();
  const server = Number(t0.ts);
  assert.ok(Math.abs(server - now) < 60_000, `server time ${server} too far from local ${now}`);
});

test('live: ticker BTC-USDT', async (t) => {
  if (!reach) return t.skip('OKX public API unreachable');
  const tool = TOOLS.find((x) => x.name === 'market_ticker');
  assert.ok(tool);
  const out = (await tool.run({ instId: 'BTC-USDT' }, client)) as {
    ticker: { instId: string; last: string };
    readOnly: boolean;
  };
  assert.equal(out.ticker.instId, 'BTC-USDT');
  assert.match(out.ticker.last, /^\d+(\.\d+)?$/);
  assert.equal(out.readOnly, true);
});

test('live: candles BTC-USDT 1H', async (t) => {
  if (!reach) return t.skip('OKX public API unreachable');
  const tool = TOOLS.find((x) => x.name === 'market_candles');
  assert.ok(tool);
  const out = (await tool.run({ instId: 'BTC-USDT', bar: '1H', limit: 5 }, client)) as {
    candles: Array<{ ts: string; open: string; high: string; low: string; close: string }>;
    count: number;
  };
  assert.equal(out.count, 5);
  const first = out.candles[0];
  assert.ok(first);
  for (const k of ['open', 'high', 'low', 'close'] as const) {
    assert.match(first[k], /^\d+(\.\d+)?$/);
  }
});

test('live: funding BTC-USDT-SWAP', async (t) => {
  if (!reach) return t.skip('OKX public API unreachable');
  const tool = TOOLS.find((x) => x.name === 'funding_rate');
  assert.ok(tool);
  const out = (await tool.run({ instId: 'BTC-USDT-SWAP' }, client)) as {
    funding: { fundingRate: string; instId: string };
  };
  assert.equal(out.funding.instId, 'BTC-USDT-SWAP');
  const rate = Number(out.funding.fundingRate);
  assert.ok(Number.isFinite(rate));
  assert.ok(Math.abs(rate) < 1, `funding rate ${rate} looks wrong`);
});

test('live: open interest BTC-USDT-SWAP', async (t) => {
  if (!reach) return t.skip('OKX public API unreachable');
  const tool = TOOLS.find((x) => x.name === 'oi_summary');
  assert.ok(tool);
  const out = (await tool.run({ instId: 'BTC-USDT-SWAP' }, client)) as {
    items: Array<{ oi: string; instId: string }>;
  };
  assert.equal(out.items.length, 1);
  assert.match(out.items[0]?.oi ?? '', /^\d+(\.\d+)?$/);
});

test('live: alert last > 0 always true; last > 1e9 false', async (t) => {
  if (!reach) return t.skip('OKX public API unreachable');
  const tool = TOOLS.find((x) => x.name === 'alert_check');
  assert.ok(tool);
  const always = (await tool.run(
    { instId: 'BTC-USDT', metric: 'last', op: 'gt', threshold: 0 },
    client,
  )) as { triggered: boolean };
  assert.equal(always.triggered, true);
  const never = (await tool.run(
    { instId: 'BTC-USDT', metric: 'last', op: 'gt', threshold: 1e9 },
    client,
  )) as { triggered: boolean };
  assert.equal(never.triggered, false);
});

test('live: direct client helpers', async (t) => {
  if (!reach) return t.skip('OKX public API unreachable');
  const tk = await fetchTicker(client, 'BTC-USDT');
  assert.equal(tk.instId, 'BTC-USDT');
  const cd = await fetchCandles(client, { instId: 'BTC-USDT', bar: '1D', limit: 3 });
  assert.equal(cd.length, 3);
  const fr = await fetchFundingRate(client, 'BTC-USDT-SWAP');
  assert.equal(fr.instId, 'BTC-USDT-SWAP');
  const oi = await fetchOpenInterest(client, { instId: 'BTC-USDT-SWAP' });
  assert.equal(oi.length, 1);
});
