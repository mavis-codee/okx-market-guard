import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket, rejectNeverCredentials } from '../src/ratelimit.ts';
import { SafetyError } from '../src/errors.ts';

test('token bucket allows burst then throttles', async () => {
  const bucket = new TokenBucket(1000, 3); // high rate so wait is ~0 if we overtake
  const t0 = Date.now();
  await bucket.acquire();
  await bucket.acquire();
  await bucket.acquire();
  const burstMs = Date.now() - t0;
  assert.ok(burstMs < 50, `burst of 3 should be immediate, took ${burstMs}ms`);
  // 4th must wait ~1ms at 1000 rps; just assert it completes
  await bucket.acquire();
});

test('token bucket rejects bad config', () => {
  assert.throws(() => new TokenBucket(0, 10), SafetyError);
  assert.throws(() => new TokenBucket(-1, 10), SafetyError);
  assert.throws(() => new TokenBucket(8, 0), SafetyError);
});

test('rejectNeverCredentials blocks key-like option names', () => {
  assert.throws(() => rejectNeverCredentials({ apiKey: 'x' }), SafetyError);
  assert.throws(() => rejectNeverCredentials({ secret: 'x' }), SafetyError);
  assert.throws(() => rejectNeverCredentials({ passphrase: 'x' }), SafetyError);
  assert.throws(() => rejectNeverCredentials({ token: 'x' }), SafetyError);
  assert.doesNotThrow(() => rejectNeverCredentials({ fetchImpl: () => {} }));
});

test('token bucket snapshot', () => {
  const b = new TokenBucket(8, 16);
  const s = b.snapshot();
  assert.equal(s.capacity, 16);
  assert.ok(s.tokens <= 16 && s.tokens > 0);
});
