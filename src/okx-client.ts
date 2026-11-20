import { OkxApiError, SafetyError } from './errors.ts';
import { TokenBucket, rejectNeverCredentials, type RateLimiter } from './ratelimit.ts';

export const OKX_PUBLIC_ORIGIN = 'https://www.okx.com';

/** Only these public read-only paths may be called. No private/auth endpoints exist in this process. */
export const ALLOWED_PATHS = new Set([
  '/api/v5/market/ticker',
  '/api/v5/market/candles',
  '/api/v5/public/funding-rate',
  '/api/v5/public/open-interest',
  '/api/v5/public/time',
]);

export type FetchImpl = (url: URL, init?: RequestInit) => Promise<Response>;

export interface OkxClientOptions {
  /** Injectable for tests. Production uses global fetch. */
  fetchImpl?: FetchImpl;
  rateLimiter?: RateLimiter;
  timeoutMs?: number;
  /** Intentionally not settable to a mirror. Tests inject fetchImpl instead. */
  origin?: typeof OKX_PUBLIC_ORIGIN;
}

export interface OkxRequestParams {
  [key: string]: string | number | undefined;
}

export class OkxClient {
  readonly origin: string;
  private readonly fetchImpl: FetchImpl;
  private readonly limiter: RateLimiter;
  private readonly timeoutMs: number;

  constructor(opts: OkxClientOptions = {}) {
    rejectNeverCredentials(opts as Record<string, unknown>);
    this.origin = opts.origin ?? OKX_PUBLIC_ORIGIN;
    if (this.origin !== OKX_PUBLIC_ORIGIN) {
      throw new SafetyError(`origin is locked to ${OKX_PUBLIC_ORIGIN}; mirrors are not allowed`);
    }
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.limiter = opts.rateLimiter ?? new TokenBucket();
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /**
   * GET a public read-only OKX endpoint and return the `data` array.
   * Rejects non-allowlisted paths, non-GET methods, credentials, mirrors, and private redirects.
   */
  async get(path: string, params: OkxRequestParams = {}): Promise<unknown[]> {
    this.assertAllowedPath(path);
    await this.limiter.acquire();

    const url = new URL(path, this.origin);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
    this.assertSafeUrl(url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': 'okx-market-guard/0.1.0 (public-read-only)',
        },
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof SafetyError || err instanceof OkxApiError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/abort/i.test(msg)) {
        throw new OkxApiError({
          code: '50004',
          msg: `request timed out after ${this.timeoutMs}ms`,
          httpStatus: 408,
        });
      }
      if (/ENOENT|getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
        throw new OkxApiError({
          code: 'DNS',
          msg:
            `cannot resolve ${url.hostname}. Direct DNS failed. ` +
            'If this network needs a proxy, restart node with NODE_USE_ENV_PROXY=1 ' +
            'and HTTPS_PROXY=http://<proxy-host>:<port>. ' +
            'This client never uses a mirror domain.',
        });
      }
      throw new OkxApiError({ code: 'NETWORK', msg: `network error: ${msg}` });
    } finally {
      clearTimeout(timer);
    }

    return this.parseEnvelope(res, url.pathname);
  }

  private assertAllowedPath(path: string): void {
    if (!ALLOWED_PATHS.has(path)) {
      throw new SafetyError(
        `path "${path}" is not an allowlisted public read-only endpoint. Allowed: ${[...ALLOWED_PATHS].join(', ')}`,
      );
    }
    if (!path.startsWith('/api/v5/')) {
      throw new SafetyError('only /api/v5/ public paths are allowed');
    }
  }

  private assertSafeUrl(url: URL): void {
    if (url.protocol !== 'https:') {
      throw new SafetyError('only https is allowed');
    }
    if (url.origin !== OKX_PUBLIC_ORIGIN) {
      throw new SafetyError(`refusing non-official origin: ${url.origin}`);
    }
    if (!ALLOWED_PATHS.has(url.pathname)) {
      throw new SafetyError(`refusing non-allowlisted path: ${url.pathname}`);
    }
    const auth = url.username || url.password;
    if (auth) {
      throw new SafetyError('credentials in URL are not allowed');
    }
  }

  private async parseEnvelope(res: Response, path: string): Promise<unknown[]> {
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new OkxApiError({
        code: String(res.status),
        msg: `non-JSON response from ${path} (http ${res.status})`,
        httpStatus: res.status,
      });
    }

    // Standard OKX v5 envelope: { code: "0", data: [...], msg: "" }
    if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
      const rec = body as { code?: unknown; data?: unknown; msg?: unknown };
      const code = typeof rec.code === 'string' ? rec.code : String(rec.code ?? '');
      const msg = typeof rec.msg === 'string' ? rec.msg : '';
      if (code !== '0') {
        throw new OkxApiError({ code, msg, httpStatus: res.status });
      }
      if (!Array.isArray(rec.data)) {
        throw new OkxApiError({ code: 'SHAPE', msg: `unexpected data shape from ${path}`, httpStatus: res.status });
      }
      return rec.data;
    }

    // Some edge 404s use { code: 404, error_message, ... } without a data array.
    const rec = body as Record<string, unknown>;
    const code = rec['code'] !== undefined ? String(rec['code']) : String(res.status);
    const msg =
      (typeof rec['msg'] === 'string' && rec['msg']) ||
      (typeof rec['error_message'] === 'string' && rec['error_message']) ||
      `http ${res.status}`;
    throw new OkxApiError({ code, msg, httpStatus: res.status });
  }
}

export interface Ticker {
  instType: string;
  instId: string;
  last: string;
  lastSz: string;
  askPx: string;
  askSz: string;
  bidPx: string;
  bidSz: string;
  open24h: string;
  high24h: string;
  low24h: string;
  volCcy24h: string;
  vol24h: string;
  ts: string;
  sodUtc0?: string;
  sodUtc8?: string;
}

export interface Candle {
  ts: string;
  open: string;
  high: string;
  low: string;
  close: string;
  vol: string;
  volCcy: string;
  volCcyQuote: string;
  confirmed: boolean;
}

export interface FundingRate {
  instType: string;
  instId: string;
  fundingRate: string;
  nextFundingRate?: string;
  fundingTime: string;
  nextFundingTime?: string;
  method?: string;
  maxFundingRate?: string;
  minFundingRate?: string;
  interestRate?: string;
  premium?: string;
  settState?: string;
  ts: string;
}

export interface OpenInterest {
  instType: string;
  instId: string;
  oi: string;
  oiCcy: string;
  oiUsd?: string;
  ts: string;
}

function asRecord(x: unknown, path: string): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) {
    throw new OkxApiError({ code: 'SHAPE', msg: `expected object from ${path}` });
  }
  return x as Record<string, unknown>;
}

function str(x: unknown, field: string): string {
  if (typeof x === 'string') return x;
  if (typeof x === 'number') return String(x);
  throw new OkxApiError({ code: 'SHAPE', msg: `expected string for ${field}` });
}

export async function fetchTicker(client: OkxClient, instId: string): Promise<Ticker> {
  const data = await client.get('/api/v5/market/ticker', { instId });
  if (data.length === 0) {
    throw new OkxApiError({ code: 'EMPTY', msg: `no ticker for ${instId}` });
  }
  const r = asRecord(data[0], 'ticker');
  return {
    instType: str(r['instType'], 'instType'),
    instId: str(r['instId'], 'instId'),
    last: str(r['last'], 'last'),
    lastSz: str(r['lastSz'] ?? '', 'lastSz'),
    askPx: str(r['askPx'] ?? '', 'askPx'),
    askSz: str(r['askSz'] ?? '', 'askSz'),
    bidPx: str(r['bidPx'] ?? '', 'bidPx'),
    bidSz: str(r['bidSz'] ?? '', 'bidSz'),
    open24h: str(r['open24h'] ?? '', 'open24h'),
    high24h: str(r['high24h'] ?? '', 'high24h'),
    low24h: str(r['low24h'] ?? '', 'low24h'),
    volCcy24h: str(r['volCcy24h'] ?? '', 'volCcy24h'),
    vol24h: str(r['vol24h'] ?? '', 'vol24h'),
    ts: str(r['ts'], 'ts'),
    sodUtc0: typeof r['sodUtc0'] === 'string' ? r['sodUtc0'] : undefined,
    sodUtc8: typeof r['sodUtc8'] === 'string' ? r['sodUtc8'] : undefined,
  };
}

export async function fetchCandles(
  client: OkxClient,
  params: { instId: string; bar: string; limit: number; after?: string; before?: string },
): Promise<Candle[]> {
  const data = await client.get('/api/v5/market/candles', {
    instId: params.instId,
    bar: params.bar,
    limit: params.limit,
    after: params.after,
    before: params.before,
  });
  return data.map((row) => {
    if (!Array.isArray(row) || row.length < 8) {
      throw new OkxApiError({ code: 'SHAPE', msg: 'unexpected candle row' });
    }
    return {
      ts: String(row[0]),
      open: String(row[1]),
      high: String(row[2]),
      low: String(row[3]),
      close: String(row[4]),
      vol: String(row[5]),
      volCcy: String(row[6]),
      volCcyQuote: String(row[7]),
      confirmed: String(row[8]) === '1',
    };
  });
}

export async function fetchFundingRate(client: OkxClient, instId: string): Promise<FundingRate> {
  const data = await client.get('/api/v5/public/funding-rate', { instId });
  if (data.length === 0) {
    throw new OkxApiError({ code: 'EMPTY', msg: `no funding rate for ${instId}` });
  }
  const r = asRecord(data[0], 'funding-rate');
  return {
    instType: str(r['instType'], 'instType'),
    instId: str(r['instId'], 'instId'),
    fundingRate: str(r['fundingRate'] ?? '', 'fundingRate'),
    nextFundingRate: typeof r['nextFundingRate'] === 'string' ? r['nextFundingRate'] : undefined,
    fundingTime: str(r['fundingTime'] ?? '', 'fundingTime'),
    nextFundingTime: typeof r['nextFundingTime'] === 'string' ? r['nextFundingTime'] : undefined,
    method: typeof r['method'] === 'string' ? r['method'] : undefined,
    maxFundingRate: typeof r['maxFundingRate'] === 'string' ? r['maxFundingRate'] : undefined,
    minFundingRate: typeof r['minFundingRate'] === 'string' ? r['minFundingRate'] : undefined,
    interestRate: typeof r['interestRate'] === 'string' ? r['interestRate'] : undefined,
    premium: typeof r['premium'] === 'string' ? r['premium'] : undefined,
    settState: typeof r['settState'] === 'string' ? r['settState'] : undefined,
    ts: str(r['ts'] ?? '', 'ts'),
  };
}

export async function fetchOpenInterest(
  client: OkxClient,
  params: { instId?: string; instType?: string; ccy?: string },
): Promise<OpenInterest[]> {
  const data = await client.get('/api/v5/public/open-interest', {
    instId: params.instId,
    instType: params.instType,
    ccy: params.ccy,
  });
  return data.map((x) => {
    const r = asRecord(x, 'open-interest');
    return {
      instType: str(r['instType'] ?? '', 'instType'),
      instId: str(r['instId'], 'instId'),
      oi: str(r['oi'] ?? '', 'oi'),
      oiCcy: str(r['oiCcy'] ?? '', 'oiCcy'),
      oiUsd: typeof r['oiUsd'] === 'string' ? r['oiUsd'] : undefined,
      ts: str(r['ts'] ?? '', 'ts'),
    };
  });
}

export async function fetchServerTime(client: OkxClient): Promise<{ ts: string }> {
  const data = await client.get('/api/v5/public/time');
  if (data.length === 0) throw new OkxApiError({ code: 'EMPTY', msg: 'no server time' });
  const r = asRecord(data[0], 'time');
  return { ts: str(r['ts'], 'ts') };
}
