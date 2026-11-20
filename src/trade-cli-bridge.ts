/**
 * Trade bridge: composition of the OFFICIAL @okx_ai/okx-trade-cli.
 *
 * Rules implemented here (do not "improve" them away):
 * - Order logic lives in the official CLI. This module only validates input,
 *   rate-limits, builds argv, spawns the CLI, and friendlies errors.
 * - Default mode is demo (`--demo`). Live requires an explicit opt-in AND
 *   OKX_AI_BUILDER_CODE.
 * - `--aiBuilderCode` is attached ONLY to commands whose official `--help`
 *   exposes the flag (verified against @okx_ai/okx-trade-cli@1.5.1).
 * - Never pass raw `tag` to the CLI.
 * - This process never reads, stores, or prints api_key / secret_key / passphrase.
 *   Credentials live in the user's ~/.okx/config.toml; the child CLI reads them.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TokenBucket, type RateLimiter } from './ratelimit.ts';
import { SafetyError, ValidationError } from './errors.ts';
import type { ToolDef } from './tools/index.ts';
import { parseInstId, rejectExtraKeys, requireObject } from './validate.ts';

export const OFFICIAL_CLI_PACKAGE = '@okx_ai/okx-trade-cli';
export const OFFICIAL_CLI_VERSION = '1.5.1';

export type TradeMode = 'demo' | 'live';

export type ExecFileFn = (
  file: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    windowsHide?: boolean;
  },
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => unknown;

export interface TradeBridgeOptions {
  mode?: TradeMode;
  /** OKX_AI_BUILDER_CODE value; undefined/empty means "no code". */
  builderCode?: string | undefined;
  /** Profile name passed as --profile. Default "demo". */
  profile?: string;
  /** 'auto' | 'npx' | path to a CLI entry (js or executable). */
  cli?: string;
  execImpl?: ExecFileFn;
  rateLimiter?: RateLimiter;
  timeoutMs?: number;
}

export interface CliInvocation {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** True when --aiBuilderCode was attached. */
  attributed: boolean;
  mode: TradeMode;
}

/**
 * Commands whose official `--help` on @okx_ai/okx-trade-cli@1.5.1 exposes
 * `[--aiBuilderCode <code>]`. Verified 2026-11-20. Do not add entries here
 * without a matching help excerpt.
 */
export const AI_BUILDER_HELP_KEYS = new Set([
  'spot place',
  'spot batch',
  'swap place',
  'swap close',
  'swap batch',
  'futures place',
  'futures close',
  'futures batch',
  'option place',
]);

export const AI_BUILDER_HELP_EVIDENCE: readonly string[] = [
  'okx spot place ... [--aiBuilderCode <code>]',
  'okx spot batch --action <place|amend|cancel> --orders \'<json>\' [--aiBuilderCode <code>] (for --action place)',
  'okx swap place ... [--aiBuilderCode <code>]',
  'okx swap close --instId <id> --mgnMode <cross|isolated> [--posSide <net|long|short>] [--autoCxl] [--aiBuilderCode <code>]',
  'okx swap batch --action <place|amend|cancel> --orders \'<json>\' [--aiBuilderCode <code>] (for --action place)',
  'okx futures place ... [--aiBuilderCode <code>]',
  'okx futures close --instId <id> --mgnMode <cross|isolated> [--posSide <net|long|short>] [--autoCxl] [--aiBuilderCode <code>]',
  'okx futures batch --action <place|amend|cancel> --orders \'<json>\' [--aiBuilderCode <code>] (for --action place)',
  'okx option place ... [--aiBuilderCode <code>]',
];

/** Commands that must NOT receive --aiBuilderCode (help does not expose it). */
export const AI_BUILDER_FORBIDDEN_KEYS = new Set([
  'spot cancel',
  'spot amend',
  'swap cancel',
  'swap amend',
  'futures cancel',
  'futures amend',
  'option cancel',
  'option amend',
  'option batch-cancel',
]);

/**
 * Official 1.5.1 help ALSO exposes --aiBuilderCode on these, but this iteration
 * only maps place/close/batch. Recorded so we do not claim we cover them.
 * Verified 2026-11-20 via `okx <cmd> --help` and `okx list-tools --json`.
 */
export const AI_BUILDER_UNWRAPPED = [
  'spot algo place',
  'spot algo trail',
  'swap algo place',
  'swap algo trail',
  'futures algo place',
  'futures algo trail',
  'option algo place',
  'bot grid create',
  'bot recurring create',
  'bot smart-portfolio create',
  'bot dca create',
  'event place',
] as const;

interface CommandSpec {
  toolName: string;
  title: string;
  module: 'spot' | 'swap' | 'futures' | 'option';
  action: 'place' | 'close' | 'batch';
  helpKey: string;
  description: string;
  required: readonly string[];
  allowed: readonly string[];
  /** Extra CLI flags always appended after user flags. */
  fixedFlags?: readonly string[];
  inputSchema: ToolDef['inputSchema'];
}

const ORD_TYPE = ['market', 'limit', 'post_only', 'fok', 'ioc'] as const;
const SIDE = ['buy', 'sell'] as const;
const TD_SPOT = ['cash', 'cross', 'isolated'] as const;
const TD_MARGIN = ['cross', 'isolated'] as const;
const MGN = ['cross', 'isolated'] as const;
const POS_SIDE = ['net', 'long', 'short'] as const;
const TGT = ['base_ccy', 'quote_ccy'] as const;
const TGT_MARGIN = ['base_ccy', 'quote_ccy', 'margin'] as const;

const COMMON_TPSL = [
  'tpTriggerPx',
  'tpOrdPx',
  'slTriggerPx',
  'slOrdPx',
  'stpMode',
] as const;

function schema(
  props: Record<string, unknown>,
  required: string[],
): ToolDef['inputSchema'] {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

const SPECS: readonly CommandSpec[] = [
  {
    toolName: 'trade_spot_place',
    title: 'Spot place order (official CLI)',
    module: 'spot',
    action: 'place',
    helpKey: 'spot place',
    description:
      'Place a spot order via the official OKX CLI (`okx spot place`). ' +
      'Runs in demo mode by default. Destructive: this can fill an order. ' +
      'aiBuilderCode attribution is attached when OKX_AI_BUILDER_CODE is set. ' +
      'Credentials are read by the CLI from the user ~/.okx/config.toml; this process never holds them.',
    required: ['instId', 'side', 'ordType', 'sz'],
    allowed: [
      'instId',
      'side',
      'ordType',
      'sz',
      'px',
      'tdMode',
      'tgtCcy',
      'clOrdId',
      ...COMMON_TPSL,
    ],
    inputSchema: schema(
      {
        instId: { type: 'string', description: 'Spot instrument ID, e.g. BTC-USDT.' },
        side: { type: 'string', enum: [...SIDE] },
        ordType: { type: 'string', enum: [...ORD_TYPE] },
        sz: { type: 'string', description: 'Size. Quote size when tgtCcy=quote_ccy.' },
        px: { type: 'string', description: 'Required for limit/post_only/fok/ioc.' },
        tdMode: { type: 'string', enum: [...TD_SPOT] },
        tgtCcy: { type: 'string', enum: [...TGT] },
        clOrdId: { type: 'string', description: 'Client order ID, max 32 chars.' },
        tpTriggerPx: { type: 'string' },
        tpOrdPx: { type: 'string', description: '-1 = market TP.' },
        slTriggerPx: { type: 'string' },
        slOrdPx: { type: 'string', description: '-1 = market SL.' },
        stpMode: { type: 'string', enum: ['cancel_maker', 'cancel_taker', 'cancel_both'] },
      },
      ['instId', 'side', 'ordType', 'sz'],
    ),
  },
  {
    toolName: 'trade_spot_batch_place',
    title: 'Spot batch place (official CLI)',
    module: 'spot',
    action: 'batch',
    helpKey: 'spot batch',
    description:
      'Batch place spot orders via official CLI (`okx spot batch --action place`). ' +
      'aiBuilderCode is attached only for action=place, matching official help. ' +
      'Demo mode by default. Destructive.',
    required: ['orders'],
    allowed: ['orders'],
    fixedFlags: ['--action', 'place'],
    inputSchema: schema(
      {
        orders: {
          type: 'array',
          description: 'Array of spot order objects (same fields as trade_spot_place, minus wrapper).',
          items: { type: 'object' },
        },
      },
      ['orders'],
    ),
  },
  {
    toolName: 'trade_swap_place',
    title: 'Swap place order (official CLI)',
    module: 'swap',
    action: 'place',
    helpKey: 'swap place',
    description:
      'Place a perpetual swap order via official CLI (`okx swap place`). ' +
      'Demo mode by default. Destructive. aiBuilderCode supported per official help.',
    required: ['instId', 'side', 'ordType', 'sz'],
    allowed: [
      'instId',
      'side',
      'ordType',
      'sz',
      'posSide',
      'px',
      'tdMode',
      'tgtCcy',
      'reduceOnly',
      'clOrdId',
      ...COMMON_TPSL,
    ],
    inputSchema: schema(
      {
        instId: { type: 'string', description: 'Perp instrument ID, e.g. BTC-USDT-SWAP.' },
        side: { type: 'string', enum: [...SIDE] },
        ordType: { type: 'string', enum: [...ORD_TYPE] },
        sz: { type: 'string', description: 'Contracts. Query ctVal; do not assume size.' },
        posSide: { type: 'string', enum: [...POS_SIDE], description: 'net=one-way; long/short=hedge.' },
        px: { type: 'string' },
        tdMode: { type: 'string', enum: [...TD_MARGIN] },
        tgtCcy: { type: 'string', enum: [...TGT_MARGIN] },
        reduceOnly: { type: 'boolean' },
        clOrdId: { type: 'string' },
        tpTriggerPx: { type: 'string' },
        tpOrdPx: { type: 'string' },
        slTriggerPx: { type: 'string' },
        slOrdPx: { type: 'string' },
        stpMode: { type: 'string', enum: ['cancel_maker', 'cancel_taker', 'cancel_both'] },
      },
      ['instId', 'side', 'ordType', 'sz'],
    ),
  },
  {
    toolName: 'trade_swap_close',
    title: 'Swap close position (official CLI)',
    module: 'swap',
    action: 'close',
    helpKey: 'swap close',
    description:
      'Close a perpetual swap position via official CLI (`okx swap close`). ' +
      'Demo mode by default. Destructive. aiBuilderCode supported per official help.',
    required: ['instId', 'mgnMode'],
    allowed: ['instId', 'mgnMode', 'posSide', 'autoCxl'],
    inputSchema: schema(
      {
        instId: { type: 'string', description: 'Perp instrument ID, e.g. BTC-USDT-SWAP.' },
        mgnMode: { type: 'string', enum: [...MGN] },
        posSide: { type: 'string', enum: [...POS_SIDE] },
        autoCxl: { type: 'boolean', description: 'Cancel associated algo orders on close.' },
      },
      ['instId', 'mgnMode'],
    ),
  },
  {
    toolName: 'trade_swap_batch_place',
    title: 'Swap batch place (official CLI)',
    module: 'swap',
    action: 'batch',
    helpKey: 'swap batch',
    description:
      'Batch place perpetual swap orders via official CLI (`okx swap batch --action place`). ' +
      'Demo mode by default. Destructive. aiBuilderCode supported for place only.',
    required: ['orders'],
    allowed: ['orders'],
    fixedFlags: ['--action', 'place'],
    inputSchema: schema(
      {
        orders: {
          type: 'array',
          description: 'Array of swap order objects.',
          items: { type: 'object' },
        },
      },
      ['orders'],
    ),
  },
  {
    toolName: 'trade_futures_place',
    title: 'Futures place order (official CLI)',
    module: 'futures',
    action: 'place',
    helpKey: 'futures place',
    description:
      'Place a delivery futures order via official CLI (`okx futures place`). ' +
      'Demo mode by default. Destructive. aiBuilderCode supported per official help.',
    required: ['instId', 'side', 'ordType', 'sz'],
    allowed: [
      'instId',
      'side',
      'ordType',
      'sz',
      'tdMode',
      'posSide',
      'px',
      'reduceOnly',
      'tgtCcy',
      'clOrdId',
      ...COMMON_TPSL,
    ],
    inputSchema: schema(
      {
        instId: { type: 'string', description: 'Futures instrument ID, e.g. BTC-USD-240628.' },
        side: { type: 'string', enum: [...SIDE] },
        ordType: { type: 'string', enum: [...ORD_TYPE] },
        sz: { type: 'string' },
        tdMode: { type: 'string', enum: [...TD_MARGIN] },
        posSide: { type: 'string', enum: [...POS_SIDE] },
        px: { type: 'string' },
        reduceOnly: { type: 'boolean' },
        tgtCcy: { type: 'string', enum: [...TGT_MARGIN] },
        clOrdId: { type: 'string' },
        tpTriggerPx: { type: 'string' },
        tpOrdPx: { type: 'string' },
        slTriggerPx: { type: 'string' },
        slOrdPx: { type: 'string' },
        stpMode: { type: 'string', enum: ['cancel_maker', 'cancel_taker', 'cancel_both'] },
      },
      ['instId', 'side', 'ordType', 'sz'],
    ),
  },
  {
    toolName: 'trade_futures_close',
    title: 'Futures close position (official CLI)',
    module: 'futures',
    action: 'close',
    helpKey: 'futures close',
    description:
      'Close a futures position via official CLI (`okx futures close`). ' +
      'Demo mode by default. Destructive. aiBuilderCode supported per official help.',
    required: ['instId', 'mgnMode'],
    allowed: ['instId', 'mgnMode', 'posSide', 'autoCxl'],
    inputSchema: schema(
      {
        instId: { type: 'string' },
        mgnMode: { type: 'string', enum: [...MGN] },
        posSide: { type: 'string', enum: [...POS_SIDE] },
        autoCxl: { type: 'boolean' },
      },
      ['instId', 'mgnMode'],
    ),
  },
  {
    toolName: 'trade_futures_batch_place',
    title: 'Futures batch place (official CLI)',
    module: 'futures',
    action: 'batch',
    helpKey: 'futures batch',
    description:
      'Batch place futures orders via official CLI (`okx futures batch --action place`). ' +
      'Demo mode by default. Destructive. aiBuilderCode supported for place only.',
    required: ['orders'],
    allowed: ['orders'],
    fixedFlags: ['--action', 'place'],
    inputSchema: schema(
      {
        orders: { type: 'array', description: 'Array of futures order objects.', items: { type: 'object' } },
      },
      ['orders'],
    ),
  },
  {
    toolName: 'trade_option_place',
    title: 'Option place order (official CLI)',
    module: 'option',
    action: 'place',
    helpKey: 'option place',
    description:
      'Place an option order via official CLI (`okx option place`). ' +
      'Demo mode by default. Destructive. aiBuilderCode supported per official help.',
    required: ['instId', 'tdMode', 'side', 'ordType', 'sz'],
    allowed: [
      'instId',
      'tdMode',
      'side',
      'ordType',
      'sz',
      'px',
      'tgtCcy',
      'reduceOnly',
      'clOrdId',
      ...COMMON_TPSL,
    ],
    inputSchema: schema(
      {
        instId: { type: 'string', description: 'Option instrument ID.' },
        tdMode: { type: 'string', enum: [...TD_SPOT] },
        side: { type: 'string', enum: [...SIDE] },
        ordType: { type: 'string', enum: [...ORD_TYPE] },
        sz: { type: 'string' },
        px: { type: 'string' },
        tgtCcy: { type: 'string', enum: [...TGT_MARGIN] },
        reduceOnly: { type: 'boolean' },
        clOrdId: { type: 'string' },
        tpTriggerPx: { type: 'string' },
        tpOrdPx: { type: 'string' },
        slTriggerPx: { type: 'string' },
        slOrdPx: { type: 'string' },
        stpMode: { type: 'string', enum: ['cancel_maker', 'cancel_taker', 'cancel_both'] },
      },
      ['instId', 'tdMode', 'side', 'ordType', 'sz'],
    ),
  },
];

export function findTradeSpec(toolName: string): CommandSpec | undefined {
  return SPECS.find((s) => s.toolName === toolName);
}

export function tradeToolNames(): string[] {
  return SPECS.map((s) => s.toolName);
}

/** 1-16 alphanumeric; empty/undefined → undefined (no code). */
export function parseBuilderCode(input: string | undefined | null): string | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  if (typeof input !== 'string' || !/^[A-Za-z0-9]{1,16}$/.test(input)) {
    throw new ValidationError(
      'OKX_AI_BUILDER_CODE must be 1-16 alphanumeric characters (official AI Builder rule).',
    );
  }
  return input;
}

function requireString(a: Record<string, unknown>, key: string): string {
  const v = a[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ValidationError(`${key} must be a non-empty string`);
  }
  return v.trim();
}

function optionalString(a: Record<string, unknown>, key: string): string | undefined {
  const v = a[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new ValidationError(`${key} must be a string`);
  return v.trim();
}

function optionalBool(a: Record<string, unknown>, key: string): boolean | undefined {
  const v = a[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ValidationError(`${key} must be a boolean`);
  return v;
}

function requireSz(a: Record<string, unknown>): string {
  const v = a['sz'];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(`sz must be a positive number, got ${JSON.stringify(v)}`);
  }
  // Keep the original string form when possible so we do not invent precision.
  return typeof v === 'string' ? v.trim() : String(n);
}

function requireOrders(a: Record<string, unknown>): string {
  const v = a['orders'];
  if (!Array.isArray(v) || v.length === 0) {
    throw new ValidationError('orders must be a non-empty array');
  }
  for (const item of v) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ValidationError('each order in orders must be a JSON object');
    }
  }
  return JSON.stringify(v);
}

function optionalEnum<T extends string>(
  a: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = a[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new ValidationError(`${key} must be one of: ${allowed.join(', ')}`);
  }
  return v as T;
}

function flagIfDefined(argv: string[], flag: string, value: string | boolean | undefined): void {
  if (value === undefined) return;
  argv.push(flag, typeof value === 'boolean' ? String(value) : value);
}

/** Child env: allowlist only. Never copy key/secret/passphrase/builder-code. */
export function childEnv(): NodeJS.ProcessEnv {
  const copy = [
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'COMSPEC',
    'USERPROFILE',
    'HOME',
    'APPDATA',
    'TMP',
    'TEMP',
    'NODE_USE_ENV_PROXY',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'OKX_SITE',
    'OKX_TIMEOUT_MS',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const k of copy) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export function resolveCli(cli: string | undefined): { file: string; prefixArgs: string[] } {
  const choice = cli ?? process.env['OKX_TRADE_CLI'] ?? 'auto';
  if (choice === 'npx') {
    return {
      file: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      prefixArgs: ['-y', `${OFFICIAL_CLI_PACKAGE}@${OFFICIAL_CLI_VERSION}`],
    };
  }
  if (choice === 'auto') {
    const local = join(process.cwd(), 'node_modules', OFFICIAL_CLI_PACKAGE, 'dist', 'index.js');
    if (existsSync(local)) {
      return { file: process.execPath, prefixArgs: [local] };
    }
    return {
      file: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      prefixArgs: ['-y', `${OFFICIAL_CLI_PACKAGE}@${OFFICIAL_CLI_VERSION}`],
    };
  }
  // Explicit path: .js runs under current node; otherwise treat as executable.
  if (choice.endsWith('.js')) {
    return { file: process.execPath, prefixArgs: [choice] };
  }
  return { file: choice, prefixArgs: [] };
}

/**
 * Pure argv builder. Tests assert on this; spawn is a thin wrapper.
 * Never includes --tag. Never includes credentials.
 */
export function planCall(
  toolName: string,
  rawArgs: unknown,
  opts: TradeBridgeOptions = {},
): CliInvocation {
  const spec = findTradeSpec(toolName);
  if (!spec) {
    throw new ValidationError(
      `unknown trade tool "${toolName}". Available: ${SPECS.map((s) => s.toolName).join(', ')}`,
    );
  }
  const a = requireObject(rawArgs);
  rejectExtraKeys(a, spec.allowed);

  const mode: TradeMode = opts.mode ?? 'demo';
  if (mode !== 'demo' && mode !== 'live') {
    throw new ValidationError('mode must be demo or live');
  }
  const profile = opts.profile ?? 'demo';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(profile)) {
    throw new ValidationError(`profile name looks invalid: "${profile}"`);
  }

  const code = parseBuilderCode(opts.builderCode ?? process.env['OKX_AI_BUILDER_CODE']);

  if (mode === 'live' && !code) {
    throw new ValidationError(
      'live trading is rejected: OKX_AI_BUILDER_CODE is empty. ' +
        'A 1-16 alphanumeric AI Builder Code is required for live attribution. ' +
        'Demo mode does not need a code. Default is demo.',
    );
  }

  const argv: string[] = ['--json', mode === 'demo' ? '--demo' : '--live', '--profile', profile];

  for (const key of spec.required) {
    if (a[key] === undefined || a[key] === null || a[key] === '') {
      throw new ValidationError(`missing required argument: ${key}`);
    }
  }

  switch (spec.toolName) {
    case 'trade_spot_place':
    case 'trade_swap_place':
    case 'trade_futures_place':
    case 'trade_option_place': {
      argv.push(spec.module, 'place');
      argv.push('--instId', parseInstId(a['instId']));
      const side = optionalEnum(a, 'side', SIDE);
      if (!side) throw new ValidationError('side must be buy or sell');
      argv.push('--side', side);
      const ordType = optionalEnum(a, 'ordType', ORD_TYPE);
      if (!ordType) throw new ValidationError(`ordType must be one of: ${ORD_TYPE.join(', ')}`);
      argv.push('--ordType', ordType);
      argv.push('--sz', requireSz(a));
      const px = optionalString(a, 'px');
      if (px !== undefined) argv.push('--px', px);
      if (spec.module === 'spot') {
        const td = optionalEnum(a, 'tdMode', TD_SPOT);
        if (td) argv.push('--tdMode', td);
        const tgt = optionalEnum(a, 'tgtCcy', TGT);
        if (tgt) argv.push('--tgtCcy', tgt);
      } else if (spec.module === 'option') {
        const td = optionalEnum(a, 'tdMode', TD_SPOT);
        if (!td) throw new ValidationError('tdMode is required for option place');
        argv.push('--tdMode', td);
        const tgt = optionalEnum(a, 'tgtCcy', TGT_MARGIN);
        if (tgt) argv.push('--tgtCcy', tgt);
      } else {
        const td = optionalEnum(a, 'tdMode', TD_MARGIN);
        if (td) argv.push('--tdMode', td);
        const tgt = optionalEnum(a, 'tgtCcy', TGT_MARGIN);
        if (tgt) argv.push('--tgtCcy', tgt);
      }
      const posSide = optionalEnum(a, 'posSide', POS_SIDE);
      if (posSide) argv.push('--posSide', posSide);
      const clOrdId = optionalString(a, 'clOrdId');
      if (clOrdId !== undefined) {
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(clOrdId)) {
          throw new ValidationError('clOrdId must be 1-32 chars of [A-Za-z0-9_-]');
        }
        argv.push('--clOrdId', clOrdId);
      }
      const reduceOnly = optionalBool(a, 'reduceOnly');
      if (reduceOnly !== undefined) argv.push('--reduceOnly', String(reduceOnly));
      for (const k of COMMON_TPSL) {
        const v = optionalString(a, k);
        if (v !== undefined) argv.push(`--${k}`, v);
      }
      break;
    }
    case 'trade_swap_close':
    case 'trade_futures_close': {
      argv.push(spec.module, 'close');
      argv.push('--instId', parseInstId(a['instId']));
      const mgn = optionalEnum(a, 'mgnMode', MGN);
      if (!mgn) throw new ValidationError(`mgnMode must be one of: ${MGN.join(', ')}`);
      argv.push('--mgnMode', mgn);
      const posSide = optionalEnum(a, 'posSide', POS_SIDE);
      if (posSide) argv.push('--posSide', posSide);
      const autoCxl = optionalBool(a, 'autoCxl');
      if (autoCxl !== undefined) argv.push('--autoCxl', String(autoCxl));
      break;
    }
    case 'trade_spot_batch_place':
    case 'trade_swap_batch_place':
    case 'trade_futures_batch_place': {
      argv.push(spec.module, 'batch', '--action', 'place', '--orders', requireOrders(a));
      break;
    }
    default:
      throw new SafetyError(`unhandled trade tool ${spec.toolName}`);
  }

  if (spec.fixedFlags) {
    // Already emitted for batch; keep a guard so we never forget --action place.
    for (let i = 0; i < spec.fixedFlags.length; i += 2) {
      const f = spec.fixedFlags[i];
      const v = spec.fixedFlags[i + 1];
      if (f !== undefined && v !== undefined && !argv.includes(f)) {
        argv.push(f, v);
      }
    }
  }

  let attributed = false;
  if (code && AI_BUILDER_HELP_KEYS.has(spec.helpKey)) {
    argv.push('--aiBuilderCode', code);
    attributed = true;
  }
  if (code && !AI_BUILDER_HELP_KEYS.has(spec.helpKey)) {
    // Help does not expose the flag: do not add it, do not claim attribution.
    attributed = false;
  }

  const { file, prefixArgs } = resolveCli(opts.cli);
  return {
    file,
    args: [...prefixArgs, ...argv],
    env: childEnv(),
    attributed,
    mode,
  };
}

export function redactSecrets(text: string): string {
  return text
    .replace(/(api[_-]?key|secret[_-]?key|passphrase|authorization|ok-access-key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/(--(api-key|secret-key|passphrase)\s+)\S+/gi, '$1[REDACTED]')
    .replace(/OKX_AI_BUILDER_CODE=[^\s"']+/g, 'OKX_AI_BUILDER_CODE=[REDACTED]');
}

export interface CliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class TradeCliBridge {
  private readonly execImpl: ExecFileFn;
  private readonly limiter: RateLimiter;
  private readonly timeoutMs: number;
  private readonly builderCode: string | undefined;
  private readonly cli: string | undefined;
  readonly mode: TradeMode;
  readonly hasCode: boolean;

  constructor(opts: TradeBridgeOptions = {}) {
    // Refuse credential-like option names on the bridge itself.
    for (const k of Object.keys(opts)) {
      if (['apiKey', 'api_key', 'secret', 'secretKey', 'passphrase', 'password', 'token'].includes(k)) {
        throw new SafetyError(
          `trade bridge does not accept "${k}". Credentials belong in the user's ~/.okx/config.toml.`,
        );
      }
    }
    this.mode = opts.mode ?? 'demo';
    this.builderCode = parseBuilderCode(opts.builderCode ?? process.env['OKX_AI_BUILDER_CODE']);
    this.hasCode = this.builderCode !== undefined;
    this.cli = opts.cli;
    this.execImpl = opts.execImpl ?? execFile;
    this.limiter = opts.rateLimiter ?? new TokenBucket(2, 4);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    if (this.mode === 'live' && !this.hasCode) {
      // Fail fast at construction if someone explicitly asks for live without a code.
      throw new ValidationError(
        'live trading is rejected: OKX_AI_BUILDER_CODE is empty. Use demo (default) or provide a 1-16 alphanumeric code.',
      );
    }
  }

  /** Build argv without executing. Useful for tests and --plan. */
  plan(toolName: string, args: unknown, cli?: string): CliInvocation {
    return planCall(toolName, args, {
      mode: this.mode,
      builderCode: this.builderCode,
      cli: cli ?? this.cli,
    });
  }

  async call(toolName: string, args: unknown): Promise<unknown> {
    const inv = this.plan(toolName, args);
    await this.limiter.acquire();
    const run = await new Promise<CliRunResult>((resolve, reject) => {
      this.execImpl(
        inv.file,
        inv.args,
        { env: inv.env, timeout: this.timeoutMs, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || /ENOENT|not found|not recognized/i.test(err.message)) {
              reject(
                new SafetyError(
                  `official CLI not found (${redactSecrets(err.message)}). ` +
                    `Install: npm install -g ${OFFICIAL_CLI_PACKAGE}@${OFFICIAL_CLI_VERSION} ` +
                    `or set OKX_TRADE_CLI to the entry js.`,
                ),
              );
              return;
            }
            resolve({
              code: typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1,
              stdout,
              stderr: stderr || err.message,
            });
            return;
          }
          resolve({ code: 0, stdout, stderr });
        },
      );
    });

    const out = parseCliOutput(run);
    return {
      source: 'official-okx-cli',
      officialPackage: OFFICIAL_CLI_PACKAGE,
      officialVersion: OFFICIAL_CLI_VERSION,
      mode: inv.mode,
      attributed: inv.attributed,
      readOnly: false,
      tool: toolName,
      exitCode: run.code,
      result: out,
    };
  }
}

function parseCliOutput(run: CliRunResult): unknown {
  const trimmed = run.stdout.trim();
  if (trimmed !== '') {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // fall through to raw
    }
  }
  const msg = redactSecrets(run.stderr || run.stdout || `exit ${run.code}`);
  throw new ValidationError(`official CLI failed (exit ${run.code}): ${msg}`);
}

/** MCP tool wrappers. destructiveHint: true — these can fill orders. */
export function createTradeTools(bridge: TradeCliBridge): ToolDef[] {
  return SPECS.map((spec) => ({
    name: spec.toolName,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: true,
      idempotentHint: false,
    },
    async run(args: unknown) {
      return bridge.call(spec.toolName, args);
    },
  }));
}

/** True if ~/.okx/config.toml exists. Does NOT read key material. */
export function userOkxConfigExists(): boolean {
  return existsSync(join(homedir(), '.okx', 'config.toml'));
}
