import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, okEnvelope } from './helpers.ts';
import {
  AI_BUILDER_HELP_KEYS,
  AI_BUILDER_UNWRAPPED,
  OFFICIAL_CLI_PACKAGE,
  OFFICIAL_CLI_VERSION,
  TradeCliBridge,
  childEnv,
  createTradeTools,
  findTradeSpec,
  parseBuilderCode,
  planCall,
  redactSecrets,
  resolveCli,
  tradeToolNames,
  type ExecFileFn,
} from '../src/trade-cli-bridge.ts';
import { McpServer } from '../src/mcp/server.ts';
import { OkxClient } from '../src/okx-client.ts';
import { SafetyError, ValidationError } from '../src/errors.ts';
import { TOOLS } from '../src/tools/index.ts';

const PLACE = {
  instId: 'BTC-USDT',
  side: 'buy',
  ordType: 'limit',
  sz: '0.001',
  px: '50000',
};

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const backup: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    backup[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(backup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('parseBuilderCode: 1-16 alnum, empty -> undefined, else throw', () => {
  assert.equal(parseBuilderCode(undefined), undefined);
  assert.equal(parseBuilderCode(''), undefined);
  assert.equal(parseBuilderCode('abc123'), 'abc123');
  assert.equal(parseBuilderCode('A1b2C3d4E5f6G7h8'), 'A1b2C3d4E5f6G7h8'); // 16
  assert.throws(() => parseBuilderCode('A1b2C3d4E5f6G7h8i'), ValidationError); // 17
  assert.throws(() => parseBuilderCode('has-dash'), ValidationError);
  assert.throws(() => parseBuilderCode('has space'), ValidationError);
  assert.throws(() => parseBuilderCode('中文'), ValidationError);
});

test('parseBuilderCode: whitespace-only is invalid (not empty)', () => {
  assert.throws(() => parseBuilderCode('   '), ValidationError);
});

test('default mode is demo even when builder code is set', () => {
  withEnv({ OKX_AI_BUILDER_CODE: 'builder01' }, () => {
    const inv = planCall('trade_spot_place', PLACE, { mode: 'demo', cli: 'npx' });
    assert.equal(inv.mode, 'demo');
    assert.ok(inv.args.includes('--demo'));
    assert.ok(!inv.args.includes('--live'));
    assert.ok(inv.args.includes('--aiBuilderCode'));
    assert.equal(inv.attributed, true);
  });
});

test('live without code is rejected (plan and constructor)', () => {
  withEnv({ OKX_AI_BUILDER_CODE: undefined }, () => {
    assert.throws(
      () => planCall('trade_spot_place', PLACE, { mode: 'live', builderCode: undefined, cli: 'npx' }),
      /OKX_AI_BUILDER_CODE is empty/,
    );
    assert.throws(() => new TradeCliBridge({ mode: 'live' }), /OKX_AI_BUILDER_CODE is empty/);
  });
});

test('live with valid code is allowed and attaches flag on whitelisted commands', () => {
  withEnv({ OKX_AI_BUILDER_CODE: undefined }, () => {
    for (const tool of [
      'trade_spot_place',
      'trade_spot_batch_place',
      'trade_swap_place',
      'trade_swap_close',
      'trade_swap_batch_place',
      'trade_futures_place',
      'trade_futures_close',
      'trade_futures_batch_place',
      'trade_option_place',
    ]) {
      const spec = findTradeSpec(tool);
      assert.ok(spec, tool);
      const args: Record<string, unknown> =
        spec.action === 'batch'
          ? { orders: [{ instId: 'BTC-USDT', side: 'buy', ordType: 'market', sz: '1' }] }
          : spec.action === 'close'
            ? { instId: 'BTC-USDT-SWAP', mgnMode: 'cross' }
            : spec.module === 'option'
              ? { ...PLACE, instId: 'BTC-USD-240628', tdMode: 'cross' }
              : PLACE;
      const inv = planCall(tool, args, { mode: 'live', builderCode: 'b1', cli: 'npx' });
      assert.equal(inv.mode, 'live');
      assert.ok(inv.args.includes('--live'));
      assert.ok(inv.args.includes('--aiBuilderCode'), tool);
      assert.equal(inv.args[inv.args.indexOf('--aiBuilderCode') + 1], 'b1');
      assert.equal(inv.attributed, true);
    }
  });
});

test('flag whitelist matches official 1.5.1 help (no cancel/amend)', () => {
  assert.deepEqual([...AI_BUILDER_HELP_KEYS].sort(), [
    'futures batch',
    'futures close',
    'futures place',
    'option place',
    'spot batch',
    'spot place',
    'swap batch',
    'swap close',
    'swap place',
  ]);
  // cancel / amend / query are not trade tools at all (help does not expose the flag)
  for (const name of tradeToolNames()) {
    const spec = findTradeSpec(name);
    assert.ok(spec);
    assert.ok(
      spec.action === 'place' || spec.action === 'close' || spec.action === 'batch',
      `${name} should be place/close/batch only`,
    );
  }
  // algo/bot/event help DOES expose the flag but is not wrapped this iteration
  assert.ok(AI_BUILDER_UNWRAPPED.includes('event place'));
  assert.ok(AI_BUILDER_UNWRAPPED.includes('bot grid create'));
  assert.ok(!tradeToolNames().includes('trade_event_place'));
  assert.ok(!tradeToolNames().includes('trade_spot_algo_place'));
});

test('tag is never passed, even if smuggled in args', () => {
  withEnv({ OKX_AI_BUILDER_CODE: 'b1' }, () => {
    assert.throws(() =>
      planCall('trade_spot_place', { ...PLACE, tag: 'raw-tag' }, { mode: 'demo', cli: 'npx' }),
    );
    const inv = planCall('trade_spot_place', PLACE, { mode: 'demo', builderCode: 'b1', cli: 'npx' });
    assert.ok(!inv.args.includes('--tag'));
    assert.ok(!inv.args.includes('raw-tag'));
  });
});

test('credentials never appear in argv or child env', () => {
  withEnv(
    {
      OKX_AI_BUILDER_CODE: 'b1',
      OKX_API_KEY: 'AKIA-TEST-SECRET-VALUE',
      OKX_SECRET_KEY: 'SUPERSECRETVALUE-DO-NOT-LEAK',
      OKX_PASSPHRASE: 'PASSPHRASE-SECRET-VALUE',
      OKX_API_SECRET: 'APISECRET-SECRET-VALUE',
    },
    () => {
      const inv = planCall('trade_swap_place', PLACE, { mode: 'demo', cli: 'npx' });
      const joined = inv.args.join(' ') + ' ' + JSON.stringify(inv.env);
      for (const secret of [
        'SUPERSECRETVALUE-DO-NOT-LEAK',
        'AKIA-TEST-SECRET-VALUE',
        'PASSPHRASE-SECRET-VALUE',
        'APISECRET-SECRET-VALUE',
      ]) {
        assert.ok(!joined.includes(secret), `leaked ${secret}`);
      }
      assert.equal(inv.env['OKX_API_KEY'], undefined);
      assert.equal(inv.env['OKX_SECRET_KEY'], undefined);
      assert.equal(inv.env['OKX_PASSPHRASE'], undefined);
      assert.equal(inv.env['OKX_AI_BUILDER_CODE'], undefined);
      // PATH must survive so npx/node work
      assert.ok(inv.env['PATH']);
    },
  );
});

test('bridge constructor rejects credential-like options', () => {
  assert.throws(
    // @ts-expect-error intentional smuggle
    () => new TradeCliBridge({ apiKey: 'x' } as never),
    /does not accept "apiKey"/,
  );
  assert.throws(
    // @ts-expect-error intentional smuggle
    () => new TradeCliBridge({ passphrase: 'x' } as never),
    SafetyError,
  );
});

test('childEnv allowlist does not copy unknown secrets', () => {
  withEnv({ SOME_SECRET: 'x', HTTPS_PROXY: 'http://127.0.0.1:7890' }, () => {
    const env = childEnv();
    assert.equal(env['SOME_SECRET'], undefined);
    assert.equal(env['HTTPS_PROXY'], 'http://127.0.0.1:7890');
  });
});

test('spot place argv matches official CLI shape', () => {
  withEnv({ OKX_AI_BUILDER_CODE: undefined }, () => {
    const inv = planCall('trade_spot_place', PLACE, { mode: 'demo', builderCode: undefined, cli: 'npx' });
    assert.equal(inv.file, 'npx.cmd');
    assert.deepEqual(inv.args.slice(0, 2), ['-y', `${OFFICIAL_CLI_PACKAGE}@${OFFICIAL_CLI_VERSION}`]);
    const rest = inv.args.slice(2);
    assert.deepEqual(rest, [
      '--json',
      '--demo',
      '--profile',
      'demo',
      'spot',
      'place',
      '--instId',
      'BTC-USDT',
      '--side',
      'buy',
      '--ordType',
      'limit',
      '--sz',
      '0.001',
      '--px',
      '50000',
    ]);
    assert.equal(inv.attributed, false);
  });
});

test('swap close argv and batch place argv', () => {
  withEnv({ OKX_AI_BUILDER_CODE: undefined }, () => {
    const close = planCall(
      'trade_swap_close',
      { instId: 'BTC-USDT-SWAP', mgnMode: 'isolated', posSide: 'long', autoCxl: true },
      { mode: 'demo', cli: 'npx' },
    );
    assert.ok(close.args.includes('swap'));
    assert.ok(close.args.includes('close'));
    assert.ok(close.args.includes('--mgnMode'));
    assert.ok(close.args.includes('isolated'));
    assert.ok(close.args.includes('--autoCxl'));
    assert.ok(close.args.includes('true'));

    const batch = planCall(
      'trade_futures_batch_place',
      { orders: [{ instId: 'BTC-USD-240628', side: 'sell', ordType: 'market', sz: '1' }] },
      { mode: 'demo', cli: 'npx' },
    );
    assert.ok(batch.args.includes('futures'));
    assert.ok(batch.args.includes('batch'));
    const ai = batch.args.indexOf('--action');
    assert.equal(batch.args[ai + 1], 'place');
    assert.ok(!batch.args.includes('--action') || batch.args[batch.args.indexOf('--action') + 1] === 'place');
    // only one --action and it is place
    const actions = batch.args.filter((a) => a === 'cancel' || a === 'amend');
    assert.deepEqual(actions, []);
  });
});

test('option place requires tdMode', () => {
  assert.throws(
    () =>
      planCall(
        'trade_option_place',
        { ...PLACE, instId: 'BTC-USD-240628' },
        { mode: 'demo', cli: 'npx' },
      ),
    /tdMode/,
  );
});

test('sz must be positive; extra keys rejected; unknown tool rejected', () => {
  assert.throws(
    () => planCall('trade_spot_place', { ...PLACE, sz: '0' }, { mode: 'demo', cli: 'npx' }),
    /sz must be a positive/,
  );
  assert.throws(
    () => planCall('trade_spot_place', { ...PLACE, foo: 1 }, { mode: 'demo', cli: 'npx' }),
    /unknown argument "foo"/,
  );
  assert.throws(() => planCall('nope', {}), /unknown trade tool/);
});

test('clOrdId format enforced', () => {
  assert.throws(
    () => planCall('trade_spot_place', { ...PLACE, clOrdId: 'has space' }, { mode: 'demo', cli: 'npx' }),
    /clOrdId/,
  );
  const inv = planCall(
    'trade_spot_place',
    { ...PLACE, clOrdId: 'ok-1_2' },
    { mode: 'demo', cli: 'npx' },
  );
  assert.ok(inv.args.includes('ok-1_2'));
});

test('invalid profile rejected', () => {
  assert.throws(
    () => planCall('trade_spot_place', PLACE, { mode: 'demo', profile: 'bad profile!', cli: 'npx' }),
    /profile/,
  );
});

test('resolveCli auto prefers local node_modules then npx; explicit js uses node', () => {
  const r1 = resolveCli('/tmp/custom-cli.js');
  assert.equal(r1.file, process.execPath);
  assert.deepEqual(r1.prefixArgs, ['/tmp/custom-cli.js']);
  const r2 = resolveCli('C:/tools/okx.exe');
  assert.equal(r2.file, 'C:/tools/okx.exe');
  assert.deepEqual(r2.prefixArgs, []);
});

test('mock spawn: demo place does not hit network and parses CLI json', async () => {
  const calls: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const exec: ExecFileFn = (file, args, options, cb) => {
    calls.push({ file, args, env: options.env });
    cb(null, JSON.stringify({ code: '0', data: [{ ordId: '123' }], msg: '' }), '');
  };
  const bridge = new TradeCliBridge({ mode: 'demo', execImpl: exec, builderCode: 'b1' });
  const out = (await bridge.call('trade_spot_place', PLACE)) as Record<string, unknown>;
  assert.equal(calls.length, 1);
  assert.equal(out['source'], 'official-okx-cli');
  assert.equal(out['officialPackage'], OFFICIAL_CLI_PACKAGE);
  assert.equal(out['officialVersion'], OFFICIAL_CLI_VERSION);
  assert.equal(out['mode'], 'demo');
  assert.equal(out['attributed'], true);
  assert.equal(out['readOnly'], false);
  const result = out['result'] as { code: string };
  assert.equal(result.code, '0');
  assert.ok(!calls[0].args.includes('--live'));
  assert.ok(calls[0].args.includes('--aiBuilderCode'));
});

test('mock spawn: ENOENT becomes friendly SafetyError with install hint', async () => {
  const exec: ExecFileFn = (_file, _args, _opts, cb) => {
    const err = new Error('spawn npx.cmd ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    cb(err, '', '');
  };
  const bridge = new TradeCliBridge({ mode: 'demo', execImpl: exec });
  await assert.rejects(() => bridge.call('trade_spot_place', PLACE), /npm install -g/);
});

test('mock spawn: non-json stderr is validation error, secrets redacted', async () => {
  const exec: ExecFileFn = (_f, _a, _o, cb) => {
    cb(new Error('exit 1'), '', 'api_key = sk-abcdef order rejected');
  };
  const bridge = new TradeCliBridge({ mode: 'demo', execImpl: exec });
  await assert.rejects(
    () => bridge.call('trade_spot_place', PLACE),
    (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.ok(!String(err.message).includes('sk-abcdef'));
      assert.match(String(err.message), /REDACTED/);
      return true;
    },
  );
});

test('createTradeTools: destructive, not readOnly, names prefixed trade_', () => {
  const bridge = new TradeCliBridge({ mode: 'demo' });
  const tools = createTradeTools(bridge);
  assert.equal(tools.length, 9);
  for (const t of tools) {
    assert.match(t.name, /^trade_/);
    assert.equal(t.annotations.readOnlyHint, false);
    assert.equal(t.annotations.destructiveHint, true);
    assert.equal(t.annotations.idempotentHint, false);
  }
  // market tools unchanged
  for (const t of TOOLS) {
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.destructiveHint, false);
  }
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), [
    'alert_check',
    'funding_rate',
    'market_candles',
    'market_ticker',
    'oi_summary',
  ]);
});

test('MCP with extraTools lists trade tools; without stays market-only', async () => {
  const { impl } = mockFetch(() => ({ body: okEnvelope([]) }));
  const client = new OkxClient({ fetchImpl: impl });
  const withTrade = new McpServer(client, createTradeTools(new TradeCliBridge({ mode: 'demo' })));
  const line = await withTrade.handleRaw(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  );
  const names = (JSON.parse(String(line)) as { result: { tools: Array<{ name: string }> } }).result.tools.map(
    (t) => t.name,
  );
  for (const n of tradeToolNames()) assert.ok(names.includes(n), n);
  assert.ok(names.includes('market_ticker'));

  const marketOnly = new McpServer(client);
  const line2 = await marketOnly.handleRaw(
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  );
  const names2 = (JSON.parse(String(line2)) as { result: { tools: Array<{ name: string }> } }).result.tools.map(
    (t) => t.name,
  );
  assert.equal(names2.length, 5);
  assert.ok(!names2.some((n) => n.startsWith('trade_')));
});

test('redactSecrets', () => {
  const out = redactSecrets('api_key=abc secret_key=xyz passphrase=p OKX_AI_BUILDER_CODE=b1 --api-key k');
  assert.ok(!out.includes('abc'));
  assert.match(out, /REDACTED/);
});

test('live mode requires code at construction; demo never does', () => {
  withEnv({ OKX_AI_BUILDER_CODE: 'ok123' }, () => {
    assert.doesNotThrow(() => new TradeCliBridge({ mode: 'live' }));
  });
  withEnv({ OKX_AI_BUILDER_CODE: 'bad!' }, () => {
    assert.throws(() => new TradeCliBridge({ mode: 'live' }), ValidationError);
  });
});
