import type { FetchImpl } from '../src/okx-client.ts';

export interface MockCall {
  url: URL;
  init?: RequestInit;
}

export interface MockReply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function okEnvelope(data: unknown[]): { code: string; data: unknown[]; msg: string } {
  return { code: '0', data, msg: '' };
}

export function mockFetch(
  handler: (url: URL, init?: RequestInit) => MockReply | Promise<MockReply>,
): { impl: FetchImpl; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, init });
    const r = await handler(url, init);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  };
  return { impl, calls };
}

export const SAMPLE_TICKER = {
  instType: 'SPOT',
  instId: 'BTC-USDT',
  last: '61846.6',
  lastSz: '0.0000102',
  askPx: '61850.4',
  askSz: '0.44508919',
  bidPx: '61850.3',
  bidSz: '1.50830923',
  open24h: '63862.9',
  high24h: '64084.9',
  low24h: '61293.8',
  volCcy24h: '666134505.106464453',
  vol24h: '10691.78555788',
  ts: '1795169281076',
  sodUtc0: '61984.8',
  sodUtc8: '63099.9',
};

export const SAMPLE_FUNDING = {
  instType: 'SWAP',
  instId: 'BTC-USDT-SWAP',
  fundingRate: '-0.0000432605638004',
  nextFundingRate: '',
  fundingTime: '1795190400000',
  nextFundingTime: '1795219200000',
  method: 'current_period',
  maxFundingRate: '0.00375',
  minFundingRate: '-0.00375',
  interestRate: '0.0001000000000000',
  premium: '-0.0004706521686392',
  settState: 'settled',
  ts: '1795169226760',
};

export const SAMPLE_OI = {
  instType: 'SWAP',
  instId: 'BTC-USDT-SWAP',
  oi: '3431103.36000001476',
  oiCcy: '34311.0336000001476',
  oiUsd: '2121506105.14176912634416',
  ts: '1795169281788',
};

export const SAMPLE_CANDLE_ROW = [
  '1795168800000',
  '61637.2',
  '61861.3',
  '61621.9',
  '61850.4',
  '191.62032791',
  '11826669.549384382',
  '11826669.549384382',
  '0',
];
