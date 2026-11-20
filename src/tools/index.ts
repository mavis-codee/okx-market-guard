import {
  fetchCandles,
  fetchFundingRate,
  fetchOpenInterest,
  fetchTicker,
  type Candle,
  type FundingRate,
  type OkxClient,
  type OpenInterest,
  type Ticker,
} from '../okx-client.ts';
import { ValidationError } from '../errors.ts';
import {
  ALERT_METRICS,
  ALERT_OPS,
  CANDLE_BARS,
  parseBar,
  parseCcy,
  parseEnum,
  parseInstId,
  parseLimit,
  parseThreshold,
  parseTs,
  rejectExtraKeys,
  requireAtLeastOne,
  requireObject,
  type AlertMetric,
  type AlertOp,
} from '../validate.ts';

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  annotations: {
    readOnlyHint: boolean;
    openWorldHint: true;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
  run(args: unknown, client: OkxClient): Promise<unknown>;
}

export const READ_ONLY_NOTICE =
  'READ-ONLY: this tool only calls OKX public market REST. No API key, no order, no account access.';

function pickTickerFields(t: Ticker): Record<string, unknown> {
  const last = Number(t.last);
  const open = Number(t.open24h);
  const changePercent24h =
    Number.isFinite(last) && Number.isFinite(open) && open !== 0
      ? ((last - open) / open) * 100
      : null;
  const ask = Number(t.askPx);
  const bid = Number(t.bidPx);
  const spreadPct =
    Number.isFinite(ask) && Number.isFinite(bid) && Number.isFinite(last) && last !== 0
      ? ((ask - bid) / last) * 100
      : null;
  return {
    instId: t.instId,
    instType: t.instType,
    last: t.last,
    bid: t.bidPx,
    ask: t.askPx,
    open24h: t.open24h,
    high24h: t.high24h,
    low24h: t.low24h,
    vol24h: t.vol24h,
    volCcy24h: t.volCcy24h,
    changePercent24h: changePercent24h === null ? null : Number(changePercent24h.toFixed(6)),
    bidAskSpreadPct: spreadPct === null ? null : Number(spreadPct.toFixed(6)),
    ts: t.ts,
  };
}

export const tickerTool: ToolDef = {
  name: 'market_ticker',
  title: 'Market ticker',
  description:
    'Get the latest OKX public ticker for one instrument (spot or swap). ' +
    READ_ONLY_NOTICE +
    ' Example instId: BTC-USDT or BTC-USDT-SWAP.',
  inputSchema: {
    type: 'object',
    properties: {
      instId: {
        type: 'string',
        description: 'OKX instrument ID, e.g. BTC-USDT (spot) or BTC-USDT-SWAP (perpetual).',
      },
    },
    required: ['instId'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true },
  async run(args, client) {
    const a = requireObject(args);
    rejectExtraKeys(a, ['instId']);
    const instId = parseInstId(a['instId']);
    const t = await fetchTicker(client, instId);
    return { source: 'okx-public-rest', readOnly: true, ticker: pickTickerFields(t) };
  },
};

export const candlesTool: ToolDef = {
  name: 'market_candles',
  title: 'Market candles',
  description:
    'Get recent OKX public candlesticks (OHLCV) for one instrument. ' +
    READ_ONLY_NOTICE +
    ' Returns newest-first, same as OKX. bar examples: 1m, 5m, 1H, 1D.',
  inputSchema: {
    type: 'object',
    properties: {
      instId: { type: 'string', description: 'OKX instrument ID, e.g. BTC-USDT.' },
      bar: {
        type: 'string',
        enum: [...CANDLE_BARS],
        description: 'Candle interval. Default 1H.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 300,
        description: 'Number of candles, 1-300. Default 100.',
      },
      after: {
        type: 'string',
        description: 'Pagination: return records newer than this ms timestamp.',
      },
      before: {
        type: 'string',
        description: 'Pagination: return records older than this ms timestamp.',
      },
    },
    required: ['instId'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true },
  async run(args, client) {
    const a = requireObject(args);
    rejectExtraKeys(a, ['instId', 'bar', 'limit', 'after', 'before']);
    const instId = parseInstId(a['instId']);
    const bar = a['bar'] === undefined ? '1H' : parseBar(a['bar']);
    const limit = parseLimit(a['limit'], 1, 300, 100);
    const after = parseTs(a['after'], 'after');
    const before = parseTs(a['before'], 'before');
    const candles: Candle[] = await fetchCandles(client, { instId, bar, limit, after, before });
    return {
      source: 'okx-public-rest',
      readOnly: true,
      instId,
      bar,
      count: candles.length,
      candles,
    };
  },
};

export const fundingTool: ToolDef = {
  name: 'funding_rate',
  title: 'Funding rate',
  description:
    'Get the current OKX public funding rate for a perpetual swap. ' +
    READ_ONLY_NOTICE +
    ' instId must be a SWAP, e.g. BTC-USDT-SWAP.',
  inputSchema: {
    type: 'object',
    properties: {
      instId: {
        type: 'string',
        description: 'Perpetual swap instrument ID, e.g. BTC-USDT-SWAP.',
      },
    },
    required: ['instId'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true },
  async run(args, client) {
    const a = requireObject(args);
    rejectExtraKeys(a, ['instId']);
    const instId = parseInstId(a['instId']);
    if (!instId.endsWith('-SWAP')) {
      throw new ValidationError(
        `funding_rate needs a perpetual swap instId (ends with -SWAP), got "${instId}". Example: BTC-USDT-SWAP.`,
      );
    }
    const fr: FundingRate = await fetchFundingRate(client, instId);
    return { source: 'okx-public-rest', readOnly: true, funding: fr };
  },
};

export const oiTool: ToolDef = {
  name: 'oi_summary',
  title: 'Open interest summary',
  description:
    'Get OKX public open interest for one instrument, or aggregated by instType/ccy. ' +
    READ_ONLY_NOTICE +
    ' Provide instId (e.g. BTC-USDT-SWAP) or instType (SWAP/FUTURES) optionally with ccy.',
  inputSchema: {
    type: 'object',
    properties: {
      instId: { type: 'string', description: 'Instrument ID, e.g. BTC-USDT-SWAP.' },
      instType: {
        type: 'string',
        enum: ['SWAP', 'FUTURES'],
        description: 'Use with optional ccy to list OI for a product type.',
      },
      ccy: { type: 'string', description: 'Currency filter, e.g. BTC. Requires instType.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true },
  async run(args, client) {
    const a = requireObject(args);
    rejectExtraKeys(a, ['instId', 'instType', 'ccy']);
    requireAtLeastOne(a, ['instId', 'instType']);
    const instId = a['instId'] === undefined ? undefined : parseInstId(a['instId']);
    const instType =
      a['instType'] === undefined
        ? undefined
        : parseEnum(a['instType'], ['SWAP', 'FUTURES'] as const, 'instType');
    const ccy = a['ccy'] === undefined ? undefined : parseCcy(a['ccy']);
    if (ccy !== undefined && instType === undefined && instId === undefined) {
      throw new ValidationError('ccy requires instType (SWAP or FUTURES)');
    }
    if (instId !== undefined && instType !== undefined) {
      throw new ValidationError('pass either instId or instType, not both');
    }
    const items: OpenInterest[] = await fetchOpenInterest(client, { instId, instType, ccy });
    if (items.length === 0) {
      throw new ValidationError(
        'no open-interest data. Check instId (e.g. BTC-USDT-SWAP) or instType/ccy combination.',
      );
    }
    return {
      source: 'okx-public-rest',
      readOnly: true,
      count: items.length,
      items: items.map((x) => ({
        instId: x.instId,
        instType: x.instType,
        oi: x.oi,
        oiCcy: x.oiCcy,
        oiUsd: x.oiUsd,
        ts: x.ts,
      })),
    };
  },
};

export interface AlertResult {
  source: 'okx-public-rest';
  readOnly: true;
  instId: string;
  metric: AlertMetric;
  op: AlertOp;
  threshold: number;
  current: number;
  triggered: boolean;
  describe: string;
  ts: string;
}

export const alertTool: ToolDef = {
  name: 'alert_check',
  title: 'Alert check (stateless, read-only)',
  description:
    'Evaluate a one-shot threshold against the latest OKX public market data. ' +
    'No persistent alerts, no notifications, no writes. ' +
    READ_ONLY_NOTICE +
    ' Metrics last/high24h/low24h/changePercent24h/bidAskSpreadPct use the ticker; ' +
    'fundingRate needs a -SWAP instId; openInterest needs SWAP or FUTURES.',
  inputSchema: {
    type: 'object',
    properties: {
      instId: { type: 'string', description: 'Instrument ID, e.g. BTC-USDT or BTC-USDT-SWAP.' },
      metric: { type: 'string', enum: [...ALERT_METRICS], description: 'Which value to test.' },
      op: { type: 'string', enum: [...ALERT_OPS], description: 'Comparison operator.' },
      threshold: { type: 'number', description: 'Numeric threshold.' },
    },
    required: ['instId', 'metric', 'op', 'threshold'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true },
  async run(args, client) {
    const a = requireObject(args);
    rejectExtraKeys(a, ['instId', 'metric', 'op', 'threshold']);
    const instId = parseInstId(a['instId']);
    const metric = parseEnum(a['metric'], ALERT_METRICS, 'metric');
    const op = parseEnum(a['op'], ALERT_OPS, 'op');
    const threshold = parseThreshold(a['threshold']);

    let current: number;
    let ts = '';

    if (metric === 'fundingRate') {
      if (!instId.endsWith('-SWAP')) {
        throw new ValidationError(
          `metric=fundingRate needs a SWAP instId (ends with -SWAP), got "${instId}". Example: BTC-USDT-SWAP.`,
        );
      }
      const fr = await fetchFundingRate(client, instId);
      if (fr.fundingRate === '') {
        throw new ValidationError('fundingRate is empty for this instrument right now.');
      }
      current = Number(fr.fundingRate);
      ts = fr.ts;
    } else if (metric === 'openInterest') {
      const items = await fetchOpenInterest(client, { instId });
      const first = items[0];
      if (!first) {
        throw new ValidationError(`no open-interest for ${instId}. Use a SWAP or FUTURES instId.`);
      }
      current = Number(first.oi);
      ts = first.ts;
    } else {
      const t = await fetchTicker(client, instId);
      const picked = pickTickerFields(t);
      ts = t.ts;
      if (metric === 'last') current = Number(t.last);
      else if (metric === 'changePercent24h') current = Number(picked['changePercent24h']);
      else if (metric === 'high24h') current = Number(t.high24h);
      else if (metric === 'low24h') current = Number(t.low24h);
      else current = Number(picked['bidAskSpreadPct']);
    }

    if (!Number.isFinite(current)) {
      throw new ValidationError(
        `metric ${metric} is not a finite number right now (empty book side or missing field).`,
      );
    }

    const triggered = compare(current, op, threshold);
    const symbol = opSymbol(op);
    const result: AlertResult = {
      source: 'okx-public-rest',
      readOnly: true,
      instId,
      metric,
      op,
      threshold,
      current,
      triggered,
      describe: `triggered=${triggered} because ${metric} ${current} ${symbol} ${threshold} is ${triggered}`,
      ts,
    };
    return result;
  },
};

function compare(current: number, op: AlertOp, threshold: number): boolean {
  switch (op) {
    case 'gt':
      return current > threshold;
    case 'gte':
      return current >= threshold;
    case 'lt':
      return current < threshold;
    case 'lte':
      return current <= threshold;
  }
}

function opSymbol(op: AlertOp): string {
  switch (op) {
    case 'gt':
      return '>';
    case 'gte':
      return '>=';
    case 'lt':
      return '<';
    case 'lte':
      return '<=';
  }
}

export const TOOLS: readonly ToolDef[] = [tickerTool, candlesTool, fundingTool, oiTool, alertTool];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}
