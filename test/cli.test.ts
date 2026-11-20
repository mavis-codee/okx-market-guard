import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.ts';

function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return fn()
    .then((result) => {
      process.stdout.write = orig;
      return { out: chunks.join(''), result };
    })
    .catch((err: unknown) => {
      process.stdout.write = orig;
      throw err;
    });
}

test('cli --version', async () => {
  const { out, result } = await captureStdout(() => main(['--version']));
  assert.equal(result, 0);
  assert.match(out, /okx-market-guard 0\.1\.0/);
});

test('cli --help lists all commands and safety note', async () => {
  const { out, result } = await captureStdout(() => main(['--help']));
  assert.equal(result, 0);
  assert.match(out, /ticker/);
  assert.match(out, /candles/);
  assert.match(out, /funding/);
  assert.match(out, /oi /);
  assert.match(out, /alert/);
  assert.match(out, /serve/);
  assert.match(out, /READ-ONLY/);
  assert.match(out, /No API key/);
});

test('cli no command shows help', async () => {
  const { out, result } = await captureStdout(() => main([]));
  assert.equal(result, 0);
  assert.match(out, /Usage:/);
});

test('unknown command is usage error exit 2', async () => {
  const code = await main(['frobnicate']);
  assert.equal(code, 2);
});

test('cli tools lists five tools as JSON', async () => {
  const { out, result } = await captureStdout(() => main(['tools']));
  assert.equal(result, 0);
  const parsed = JSON.parse(out) as {
    readOnly: boolean;
    tools: Array<{ name: string }>;
  };
  assert.equal(parsed.readOnly, true);
  assert.equal(parsed.tools.length, 5);
  assert.match(out, /alert_check/);
});

test('cli ticker with invalid instId exits 1 without network', async () => {
  const { result } = await captureStdout(() => main(['ticker', 'BAD/ID']));
  assert.equal(result, 1);
});

test('cli funding without instId is usage error', async () => {
  const code = await main(['funding']);
  assert.equal(code, 2);
});
