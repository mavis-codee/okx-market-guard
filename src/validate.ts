import { ValidationError } from './errors.ts';

export const CANDLE_BARS = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1H',
  '2H',
  '4H',
  '6H',
  '12H',
  '1D',
  '1W',
  '1M',
  '3M',
] as const;

export type CandleBar = (typeof CANDLE_BARS)[number];

export const ALERT_METRICS = [
  'last',
  'changePercent24h',
  'high24h',
  'low24h',
  'bidAskSpreadPct',
  'fundingRate',
  'openInterest',
] as const;

export type AlertMetric = (typeof ALERT_METRICS)[number];

export const ALERT_OPS = ['gt', 'gte', 'lt', 'lte'] as const;
export type AlertOp = (typeof ALERT_OPS)[number];

const INST_ID_RE = /^[A-Z0-9]{1,20}(-[A-Z0-9]{1,20}){1,3}$/;

export function parseInstId(input: unknown, field = 'instId'): string {
  if (typeof input !== 'string') {
    throw new ValidationError(`${field} must be a string, got ${typeof input}`);
  }
  const s = input.trim().toUpperCase();
  if (!INST_ID_RE.test(s)) {
    throw new ValidationError(
      `${field} looks invalid: "${input}". Examples: BTC-USDT (spot), BTC-USDT-SWAP (perp).`,
    );
  }
  return s;
}

export function parseCcy(input: unknown, field = 'ccy'): string {
  if (typeof input !== 'string') {
    throw new ValidationError(`${field} must be a string, got ${typeof input}`);
  }
  const s = input.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(s)) {
    throw new ValidationError(`${field} looks invalid: "${input}". Example: BTC`);
  }
  return s;
}

export function parseBar(input: unknown): CandleBar {
  if (typeof input !== 'string') {
    throw new ValidationError(`bar must be a string, one of: ${CANDLE_BARS.join(', ')}`);
  }
  if (!(CANDLE_BARS as readonly string[]).includes(input)) {
    throw new ValidationError(`bar "${input}" is not supported. Allowed: ${CANDLE_BARS.join(', ')}`);
  }
  return input as CandleBar;
}

export function parseLimit(input: unknown, min: number, max: number, dflt: number): number {
  if (input === undefined || input === null || input === '') return dflt;
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isInteger(n)) {
    throw new ValidationError(`limit must be an integer, got ${JSON.stringify(input)}`);
  }
  if (n < min || n > max) {
    throw new ValidationError(`limit must be between ${min} and ${max}, got ${n}`);
  }
  return n;
}

export function parseTs(input: unknown, field: string): string | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  if (typeof input !== 'string' && typeof input !== 'number') {
    throw new ValidationError(`${field} must be a millisecond timestamp`);
  }
  const s = String(input);
  if (!/^\d{10,16}$/.test(s)) {
    throw new ValidationError(`${field} must be a millisecond timestamp (digits only), got "${input}"`);
  }
  return s;
}

export function parseEnum<T extends string>(input: unknown, allowed: readonly T[], field: string): T {
  if (typeof input !== 'string' || !(allowed as readonly string[]).includes(input)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return input as T;
}

export function parseThreshold(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    // Accept numeric strings from LLM tool calls.
    if (typeof input === 'string' && input.trim() !== '' && Number.isFinite(Number(input))) {
      return Number(input);
    }
    throw new ValidationError(`threshold must be a finite number, got ${JSON.stringify(input)}`);
  }
  return input;
}

export function requireObject(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('arguments must be a JSON object');
  }
  return input as Record<string, unknown>;
}

export function rejectExtraKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      throw new ValidationError(`unknown argument "${k}". Allowed: ${allowed.join(', ')}`);
    }
  }
}

export function requireAtLeastOne(
  obj: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (!keys.some((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== '')) {
    throw new ValidationError(`provide at least one of: ${keys.join(', ')}`);
  }
}
