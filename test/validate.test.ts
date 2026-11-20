import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInstId,
  parseBar,
  parseLimit,
  parseTs,
  parseEnum,
  parseThreshold,
  rejectExtraKeys,
  requireAtLeastOne,
  requireObject,
  parseCcy,
  CANDLE_BARS,
  ALERT_METRICS,
  ALERT_OPS,
} from '../src/validate.ts';
import { ValidationError } from '../src/errors.ts';

test('parseInstId accepts typical OKX ids and uppercases', () => {
  assert.equal(parseInstId('btc-usdt'), 'BTC-USDT');
  assert.equal(parseInstId('BTC-USDT-SWAP'), 'BTC-USDT-SWAP');
  assert.equal(parseInstId(' ETH-USDT '), 'ETH-USDT');
  assert.equal(parseInstId('1INCH-USDT'), '1INCH-USDT');
  assert.equal(parseInstId('BTC-USD-240628'), 'BTC-USD-240628');
});

test('parseInstId rejects junk', () => {
  assert.throws(() => parseInstId(''), ValidationError);
  assert.throws(() => parseInstId('BTC'), ValidationError);
  assert.throws(() => parseInstId('BTC/USDT'), ValidationError);
  assert.throws(() => parseInstId(null), ValidationError);
  assert.throws(() => parseInstId(123), ValidationError);
  assert.throws(() => parseInstId('BTC-USDT;DROP'), ValidationError);
});

test('parseBar only allows known bars', () => {
  assert.equal(parseBar('1H'), '1H');
  assert.equal(parseBar('1m'), '1m');
  assert.throws(() => parseBar('7H'), ValidationError);
  assert.throws(() => parseBar(''), ValidationError);
});

test('parseLimit range and integers', () => {
  assert.equal(parseLimit(50, 1, 300, 100), 50);
  assert.equal(parseLimit(undefined, 1, 300, 100), 100);
  assert.equal(parseLimit('42', 1, 300, 100), 42);
  assert.throws(() => parseLimit(0, 1, 300, 100), ValidationError);
  assert.throws(() => parseLimit(301, 1, 300, 100), ValidationError);
  assert.throws(() => parseLimit(1.5, 1, 300, 100), ValidationError);
});

test('parseTs digits only', () => {
  assert.equal(parseTs('1795168800000', 'after'), '1795168800000');
  assert.equal(parseTs(undefined, 'after'), undefined);
  assert.throws(() => parseTs('abc', 'after'), ValidationError);
  assert.throws(() => parseTs('-1', 'after'), ValidationError);
});

test('parseEnum', () => {
  assert.equal(parseEnum('gt', ALERT_OPS, 'op'), 'gt');
  assert.throws(() => parseEnum('eq', ALERT_OPS, 'op'), ValidationError);
  assert.throws(() => parseEnum('nope', ALERT_METRICS, 'metric'), ValidationError);
});

test('parseThreshold accepts number and numeric string', () => {
  assert.equal(parseThreshold(1.5), 1.5);
  assert.equal(parseThreshold('2.5'), 2.5);
  assert.throws(() => parseThreshold('abc'), ValidationError);
  assert.throws(() => parseThreshold(Number.NaN), ValidationError);
});

test('rejectExtraKeys and requireAtLeastOne', () => {
  assert.throws(() => rejectExtraKeys({ a: 1, b: 2 }, ['a']), ValidationError);
  rejectExtraKeys({ a: 1 }, ['a']);
  assert.throws(() => requireAtLeastOne({}, ['x', 'y']), ValidationError);
  requireAtLeastOne({ y: 1 }, ['x', 'y']);
});

test('requireObject', () => {
  assert.deepEqual(requireObject(undefined), {});
  assert.throws(() => requireObject([1]), ValidationError);
  assert.throws(() => requireObject('x'), ValidationError);
});

test('parseCcy', () => {
  assert.equal(parseCcy('btc'), 'BTC');
  assert.throws(() => parseCcy('BTC-USDT'), ValidationError);
});

test('CANDLE_BARS covers OKX common intervals', () => {
  for (const b of ['1m', '5m', '15m', '1H', '4H', '1D', '1W', '1M'] as const) {
    assert.ok((CANDLE_BARS as readonly string[]).includes(b));
  }
});
