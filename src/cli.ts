#!/usr/bin/env node
import { OkxClient, fetchServerTime } from './okx-client.ts';
import { TOOLS, findTool } from './tools/index.ts';
import { serveStdio } from './mcp/server.ts';
import { VERSION, SERVER_NAME } from './version.ts';
import { ValidationError } from './errors.ts';

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
  help: boolean;
  version: boolean;
  pretty: boolean;
}

function parseArgv(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command: string | undefined;
  let help = false;
  let version = false;
  let pretty = false;

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === undefined) continue;
    if (raw === '--help' || raw === '-h') {
      help = true;
      continue;
    }
    if (raw === '--version' || raw === '-V') {
      version = true;
      continue;
    }
    if (raw === '--pretty') {
      pretty = true;
      continue;
    }
    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=');
      if (eq > 2) {
        flags[raw.slice(2, eq)] = raw.slice(eq + 1);
      } else {
        const key = raw.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
      continue;
    }
    if (command === undefined) {
      command = raw;
    } else {
      positional.push(raw);
    }
  }
  return { command, positional, flags, help, version, pretty };
}

function printJson(value: unknown, pretty: boolean): void {
  const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  process.stdout.write(text + '\n');
}

function usage(): string {
  return [
    `${SERVER_NAME} v${VERSION} — READ-ONLY OKX public market data (MCP + CLI)`,
    '',
    'Usage:',
    '  okx-market-guard <command> [args] [flags]',
    '',
    'Commands:',
    '  ticker <instId>                          Latest public ticker. Ex: ticker BTC-USDT',
    '  candles <instId> [--bar 1H] [--limit 100] [--after TS] [--before TS]',
    '                                           Public OHLCV, newest first. bar: 1m..3M',
    '  funding <instId>                         Public funding rate. instId must be -SWAP',
    '  oi <instId | --instType SWAP|FUTURES> [--ccy BTC]',
    '                                           Public open interest',
    '  alert <instId> --metric M --op OP --threshold N',
    '                                           Stateless read-only threshold check',
    '                                           metric: last|changePercent24h|high24h|low24h|',
    '                                                   bidAskSpreadPct|fundingRate|openInterest',
    '                                           op: gt|gte|lt|lte',
    '  version                                  Print version',
    '  serve                                    Start MCP stdio server (JSON-RPC 2.0)',
    '  tools                                    List available tools as JSON',
    '  time                                     OKX public server time (connectivity check)',
    '',
    'Flags:',
    '  --pretty    Indent JSON output',
    '  --help      Show this help',
    '  --version   Print version',
    '',
    'Safety:',
    '  Public read-only REST only (www.okx.com /api/v5). No API key, no orders,',
    '  no withdrawals, no account endpoints. Alerts are stateless; nothing is stored.',
    '',
    'Exit codes: 0 ok, 1 tool/validation/API error, 2 usage error.',
  ].join('\n');
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function failUsage(msg: string): never {
  throw new UsageError(`${msg}\n\n${usage()}`);
}

function requireInstId(args: ParsedArgs, i: number): string {
  const raw = args.positional[i];
  if (raw === undefined) {
    failUsage('missing instId. Example: BTC-USDT or BTC-USDT-SWAP');
  }
  return raw;
}

function flagOrPositional(args: ParsedArgs, key: string, i: number): string | undefined {
  const f = args.flags[key];
  if (typeof f === 'string') return f;
  if (f === true) return undefined;
  return args.positional[i];
}

async function runCommand(args: ParsedArgs): Promise<number> {
  const client = new OkxClient();

  switch (args.command) {
    case 'version': {
      process.stdout.write(`${SERVER_NAME} ${VERSION}\n`);
      return 0;
    }
    case 'tools': {
      printJson(
        {
          server: SERVER_NAME,
          version: VERSION,
          readOnly: true,
          tools: TOOLS.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
        args.pretty,
      );
      return 0;
    }
    case 'time': {
      const t = await fetchServerTime(client);
      printJson({ source: 'okx-public-rest', readOnly: true, ...t }, args.pretty);
      return 0;
    }
    case 'ticker': {
      const tool = findTool('market_ticker');
      if (!tool) throw new ValidationError('ticker tool missing');
      const instId = requireInstId(args, 0);
      const out = await tool.run({ instId }, client);
      printJson(out, args.pretty);
      return 0;
    }
    case 'candles': {
      const tool = findTool('market_candles');
      if (!tool) throw new ValidationError('candles tool missing');
      const instId = requireInstId(args, 0);
      const body: Record<string, unknown> = { instId };
      if (args.flags['bar'] !== undefined) body['bar'] = args.flags['bar'];
      if (args.flags['limit'] !== undefined) body['limit'] = args.flags['limit'];
      if (args.flags['after'] !== undefined) body['after'] = args.flags['after'];
      if (args.flags['before'] !== undefined) body['before'] = args.flags['before'];
      const out = await tool.run(body, client);
      printJson(out, args.pretty);
      return 0;
    }
    case 'funding': {
      const tool = findTool('funding_rate');
      if (!tool) throw new ValidationError('funding tool missing');
      const instId = requireInstId(args, 0);
      const out = await tool.run({ instId }, client);
      printJson(out, args.pretty);
      return 0;
    }
    case 'oi': {
      const tool = findTool('oi_summary');
      if (!tool) throw new ValidationError('oi tool missing');
      const body: Record<string, unknown> = {};
      if (args.positional[0] !== undefined && typeof args.flags['instType'] !== 'string') {
        body['instId'] = args.positional[0];
      }
      if (typeof args.flags['instType'] === 'string') body['instType'] = args.flags['instType'];
      if (typeof args.flags['ccy'] === 'string') body['ccy'] = args.flags['ccy'];
      if (typeof args.flags['instId'] === 'string') body['instId'] = args.flags['instId'];
      const out = await tool.run(body, client);
      printJson(out, args.pretty);
      return 0;
    }
    case 'alert': {
      const tool = findTool('alert_check');
      if (!tool) throw new ValidationError('alert tool missing');
      const instId = requireInstId(args, 0);
      const metric = flagOrPositional(args, 'metric', 1);
      const op = flagOrPositional(args, 'op', 2);
      const threshold = flagOrPositional(args, 'threshold', 3);
      const body: Record<string, unknown> = { instId };
      if (metric !== undefined) body['metric'] = metric;
      if (op !== undefined) body['op'] = op;
      if (threshold !== undefined) body['threshold'] = threshold;
      const out = await tool.run(body, client);
      printJson(out, args.pretty);
      return 0;
    }
    case 'serve': {
      await serveStdio(client);
      return 0;
    }
    default:
      failUsage(`unknown command "${args.command ?? ''}"`);
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgv(argv);
  if (args.version) {
    process.stdout.write(`${SERVER_NAME} ${VERSION}\n`);
    return 0;
  }
  if (args.help || args.command === undefined || args.command === 'help') {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  try {
    return await runCommand(args);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof ValidationError) {
      process.stderr.write(`validation: ${msg}\n`);
      return 1;
    }
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }
}

// Only auto-run when executed directly (not when imported by tests).
// node --experimental-strip-types sets this up; compare argv[1] to this file.
const isDirect =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('cli.ts') || process.argv[1].endsWith('okx-market-guard'));
if (isDirect) {
  void main().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
