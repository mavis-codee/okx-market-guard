import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OkxClient, OKX_PUBLIC_ORIGIN, ALLOWED_PATHS } from '../src/okx-client.ts';
import { OkxApiError, SafetyError } from '../src/errors.ts';
import { mockFetch, okEnvelope, SAMPLE_TICKER } from './helpers.ts';

test('client locks origin to official www.okx.com', () => {
  const c = new OkxClient();
  assert.equal(c.origin, 'https://www.okx.com');
  assert.throws(
    () => new OkxClient({ origin: 'https://okx.example.com' as typeof OKX_PUBLIC_ORIGIN }),
    SafetyError,
  );
});

test('client rejects credential-like options', () => {
  assert.throws(() => new OkxClient({ apiKey: 'x' } as never), SafetyError);
});

test('only allowlisted public paths', async () => {
  const { impl } = mockFetch(() => ({ body: okEnvelope([]) }));
  const c = new OkxClient({ fetchImpl: impl });
  await assert.doesNotReject(() => c.get('/api/v5/market/ticker', { instId: 'BTC-USDT' }));
  await assert.rejects(() => c.get('/api/v5/private/foo'), SafetyError);
  await assert.rejects(() => c.get('/api/v5/account/balance'), SafetyError);
  await assert.rejects(() => c.get('/api/v5/trade/order'), SafetyError);
  await assert.rejects(() => c.get('https://evil.example.com/api/v5/market/ticker'), SafetyError);
});

test('GET request has no auth header and uses https official origin', async () => {
  const { impl, calls } = mockFetch(() => ({ body: okEnvelope([SAMPLE_TICKER]) }));
  const c = new OkxClient({ fetchImpl: impl });
  await c.get('/api/v5/market/ticker', { instId: 'BTC-USDT' });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url.origin, 'https://www.okx.com');
  assert.equal(call.url.pathname, '/api/v5/market/ticker');
  assert.equal(call.url.searchParams.get('instId'), 'BTC-USDT');
  assert.equal(call.init?.method, 'GET');
  const headers = (call.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers['authorization'], undefined);
  assert.equal(headers['ok-access-key'], undefined);
  assert.equal(new URL(call.url).username, '');
});

test('parses OKX envelope data array', async () => {
  const { impl } = mockFetch(() => ({ body: okEnvelope([SAMPLE_TICKER]) }));
  const c = new OkxClient({ fetchImpl: impl });
  const data = await c.get('/api/v5/market/ticker', { instId: 'BTC-USDT' });
  assert.equal(data.length, 1);
  assert.equal((data[0] as Record<string, unknown>)['instId'], 'BTC-USDT');
});

test('maps OKX error code to friendly message', async () => {
  const { impl } = mockFetch(() => ({ body: { code: '51002', data: [], msg: 'Instrument ID error' } }));
  const c = new OkxClient({ fetchImpl: impl });
  await assert.rejects(
    () => c.get('/api/v5/market/ticker', { instId: 'NOPE' }),
    (err: unknown) => {
      assert.ok(err instanceof OkxApiError);
      assert.equal((err as OkxApiError).code, '51002');
      assert.match((err as Error).message, /Instrument ID error/);
      assert.match((err as Error).message, /Hint:/);
      return true;
    },
  );
});

test('handles non-standard 404 body on an allowlisted path', async () => {
  const { impl } = mockFetch(() => ({
    status: 404,
    body: { code: 404, error_message: 'Not Found', msg: 'Not Found' },
  }));
  const c = new OkxClient({ fetchImpl: impl });
  await assert.rejects(
    () => c.get('/api/v5/market/ticker', { instId: 'X' }),
    (err: unknown) => {
      assert.ok(err instanceof OkxApiError);
      assert.match((err as Error).message, /Not Found/);
      return true;
    },
  );
});

test('non-JSON body becomes OkxApiError', async () => {
  const { impl } = mockFetch(() => ({ body: { not: 'json' }, headers: {} }));
  // Force a non-JSON body by intercepting after mock: easier to use a custom impl
  const c = new OkxClient({
    fetchImpl: async () =>
      new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
  });
  await assert.rejects(() => c.get('/api/v5/market/ticker'), OkxApiError);
  void impl;
});

test('fetchTicker maps fields', async () => {
  const { impl } = mockFetch(() => ({ body: okEnvelope([SAMPLE_TICKER]) }));
  const c = new OkxClient({ fetchImpl: impl });
  const { fetchTicker } = await import('../src/okx-client.ts');
  const t = await fetchTicker(c, 'BTC-USDT');
  assert.equal(t.instId, 'BTC-USDT');
  assert.equal(t.last, '61846.6');
  assert.equal(t.askPx, '61850.4');
});

test('fetchCandles maps rows', async () => {
  const { impl } = mockFetch(() => ({
    body: okEnvelope([
      ['1795168800000', '61637.2', '61861.3', '61621.9', '61850.4', '191.62', '11826669', '11826669', '0'],
      ['1795165200000', '61830.6', '61874.9', '61555.5', '61638.4', '269.14', '16605059', '16605059', '1'],
    ]),
  }));
  const c = new OkxClient({ fetchImpl: impl });
  const { fetchCandles } = await import('../src/okx-client.ts');
  const rows = await fetchCandles(c, { instId: 'BTC-USDT', bar: '1H', limit: 2 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.ts, '1795168800000');
  assert.equal(rows[0]?.confirmed, false);
  assert.equal(rows[1]?.confirmed, true);
  assert.equal(rows[0]?.close, '61850.4');
});

test('allowlist contains only public read paths', () => {
  for (const p of ALLOWED_PATHS) {
    assert.match(p, /^\/api\/v5\/(market|public)\//);
    assert.doesNotMatch(p, /private|account|trade|asset|users|login/i);
  }
  assert.ok(ALLOWED_PATHS.has('/api/v5/market/ticker'));
  assert.ok(ALLOWED_PATHS.has('/api/v5/market/candles'));
  assert.ok(ALLOWED_PATHS.has('/api/v5/public/funding-rate'));
  assert.ok(ALLOWED_PATHS.has('/api/v5/public/open-interest'));
});
