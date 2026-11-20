import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OkxClient } from '../src/okx-client.ts';
import { TOOLS, findTool, tickerTool, candlesTool, fundingTool, oiTool, alertTool } from '../src/tools/index.ts';
import { ValidationError } from '../src/errors.ts';
import { mockFetch, okEnvelope, SAMPLE_TICKER, SAMPLE_FUNDING, SAMPLE_OI, SAMPLE_CANDLE_ROW } from './helpers.ts';

function clientFrom(
  handler: Parameters<typeof mockFetch>[0],
): { client: OkxClient; calls: ReturnType<typeof mockFetch>['calls'] } {
  const { impl, calls } = mockFetch(handler);
  return { client: new OkxClient({ fetchImpl: impl }), calls };
}

test('five tools registered, all read-only', () => {
  assert.equal(TOOLS.length, 5);
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    ['market_ticker', 'market_candles', 'funding_rate', 'oi_summary', 'alert_check'],
  );
  for (const t of TOOLS) {
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.destructiveHint, false);
    assert.match(t.description, /READ-ONLY/);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
  }
  assert.ok(findTool('market_ticker'));
  assert.ok(!findTool('place_order'));
});

test('market_ticker happy path and derived fields', async () => {
  const { impl, calls } = mockFetch(() => ({ body: okEnvelope([SAMPLE_TICKER]) }));
  const out = (await tickerTool.run({ instId: 'btc-usdt' }, new OkxClient({ fetchImpl: impl }))) as {
    ticker: Record<string, unknown>;
  };
  assert.equal(out.ticker['instId'], 'BTC-USDT');
  assert.equal(out.ticker['last'], '61846.6');
  const change = out.ticker['changePercent24h'] as number;
  assert.ok(Math.abs(change - ((61846.6 - 63862.9) / 63862.9) * 100) < 1e-6);
  const spread = out.ticker['bidAskSpreadPct'] as number;
  assert.ok(Math.abs(spread - ((61850.4 - 61850.3) / 61846.6) * 100) < 1e-6);
  assert.equal(calls[0]?.url.pathname, '/api/v5/market/ticker');
  await assert.rejects(
    () => tickerTool.run({ instId: 'BAD/ID' }, new OkxClient({ fetchImpl: impl })),
    ValidationError,
  );
  await assert.rejects(
    () => tickerTool.run({ instId: 'BTC-USDT', extra: 1 }, new OkxClient({ fetchImpl: impl })),
    ValidationError,
  );
});

test('market_candles default bar/limit and validation', async () => {
  const { impl, calls } = mockFetch(() => ({ body: okEnvelope([SAMPLE_CANDLE_ROW]) }));
  const c = new OkxClient({ fetchImpl: impl });
  const out = (await candlesTool.run({ instId: 'BTC-USDT' }, c)) as {
    bar: string;
    count: number;
    candles: Array<Record<string, unknown>>;
  };
  assert.equal(out.bar, '1H');
  assert.equal(out.count, 1);
  assert.equal(out.candles[0]?.open, '61637.2');
  assert.equal(calls[0]?.url.searchParams.get('bar'), '1H');
  assert.equal(calls[0]?.url.searchParams.get('limit'), '100');

  await assert.rejects(() => candlesTool.run({ instId: 'BTC-USDT', bar: '7H' }, c), ValidationError);
  await assert.rejects(() => candlesTool.run({ instId: 'BTC-USDT', limit: 999 }, c), ValidationError);
});

test('funding_rate requires -SWAP', async () => {
  const { impl } = mockFetch(() => ({ body: okEnvelope([SAMPLE_FUNDING]) }));
  const c = new OkxClient({ fetchImpl: impl });
  await assert.rejects(
    () => fundingTool.run({ instId: 'BTC-USDT' }, c),
    /-SWAP/,
  );
  const out = (await fundingTool.run({ instId: 'BTC-USDT-SWAP' }, c)) as {
    funding: { fundingRate: string };
  };
  assert.equal(out.funding.fundingRate, '-0.0000432605638004');
});

test('oi_summary instId vs instType', async () => {
  const { impl, calls } = mockFetch(() => ({ body: okEnvelope([SAMPLE_OI]) }));
  const c = new OkxClient({ fetchImpl: impl });
  const out = (await oiTool.run({ instId: 'BTC-USDT-SWAP' }, c)) as {
    items: Array<{ oi: string }>;
  };
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]?.oi, '3431103.36000001476');
  assert.equal(calls[0]?.url.searchParams.get('instId'), 'BTC-USDT-SWAP');

  await assert.rejects(() => oiTool.run({}, c), ValidationError);
  await assert.rejects(() => oiTool.run({ instId: 'BTC-USDT-SWAP', instType: 'SWAP' }, c), ValidationError);
  await assert.rejects(() => oiTool.run({ ccy: 'BTC' }, c), ValidationError);

  const out2 = (await oiTool.run({ instType: 'SWAP', ccy: 'BTC' }, c)) as { count: number };
  assert.equal(out2.count, 1);
  assert.equal(calls[1]?.url.searchParams.get('instType'), 'SWAP');
  assert.equal(calls[1]?.url.searchParams.get('ccy'), 'BTC');
});

test('alert_check comparisons on last price', async () => {
  const { impl } = mockFetch(() => ({ body: okEnvelope([SAMPLE_TICKER]) }));
  const c = new OkxClient({ fetchImpl: impl });

  const below = (await alertTool.run(
    { instId: 'BTC-USDT', metric: 'last', op: 'gt', threshold: 100000 },
    c,
  )) as { triggered: boolean; current: number };
  assert.equal(below.triggered, false);
  assert.equal(below.current, 61846.6);

  const above = (await alertTool.run(
    { instId: 'BTC-USDT', metric: 'last', op: 'lt', threshold: 70000 },
    c,
  )) as { triggered: boolean };
  assert.equal(above.triggered, true);

  const gteEdge = (await alertTool.run(
    { instId: 'BTC-USDT', metric: 'last', op: 'gte', threshold: 61846.6 },
    c,
  )) as { triggered: boolean };
  assert.equal(gteEdge.triggered, true);
});

test('alert_check funding and oi metrics', async () => {
  const { impl } = mockFetch((url) => {
    if (url.pathname === '/api/v5/public/funding-rate') return { body: okEnvelope([SAMPLE_FUNDING]) };
    if (url.pathname === '/api/v5/public/open-interest') return { body: okEnvelope([SAMPLE_OI]) };
    return { body: okEnvelope([SAMPLE_TICKER]) };
  });
  const c = new OkxClient({ fetchImpl: impl });

  const fr = (await alertTool.run(
    { instId: 'BTC-USDT-SWAP', metric: 'fundingRate', op: 'lt', threshold: 0 },
    c,
  )) as { triggered: boolean; current: number };
  assert.ok(fr.current < 0);
  assert.equal(fr.triggered, true);

  await assert.rejects(
    () => alertTool.run({ instId: 'BTC-USDT', metric: 'fundingRate', op: 'gt', threshold: 0 }, c),
    /-SWAP/,
  );

  const oi = (await alertTool.run(
    { instId: 'BTC-USDT-SWAP', metric: 'openInterest', op: 'gt', threshold: 0 },
    c,
  )) as { triggered: boolean };
  assert.equal(oi.triggered, true);
});

test('alert_check rejects unknown metric/op and extra keys', async () => {
  const { impl } = mockFetch(() => ({ body: okEnvelope([SAMPLE_TICKER]) }));
  const c = new OkxClient({ fetchImpl: impl });
  await assert.rejects(
    () => alertTool.run({ instId: 'BTC-USDT', metric: 'nope', op: 'gt', threshold: 1 }, c),
    ValidationError,
  );
  await assert.rejects(
    () => alertTool.run({ instId: 'BTC-USDT', metric: 'last', op: 'eq', threshold: 1 }, c),
    ValidationError,
  );
  await assert.rejects(
    () => alertTool.run({ instId: 'BTC-USDT', metric: 'last', op: 'gt', threshold: 1, extra: 2 }, c),
    ValidationError,
  );
});

test('all tool schemas require valid JSON-schema-ish shape', () => {
  for (const t of TOOLS) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(typeof t.inputSchema.properties === 'object');
    if (t.required) {
      for (const k of t.required) {
        assert.ok(k in t.inputSchema.properties, `${t.name} requires ${k} but it is not in properties`);
      }
    }
  }
});
