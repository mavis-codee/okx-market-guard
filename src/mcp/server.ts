import { VERSION, SERVER_NAME } from '../version.ts';
import { TOOLS } from '../tools/index.ts';
import type { ToolDef } from '../tools/index.ts';
import type { OkxClient } from '../okx-client.ts';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const LATEST_PROTOCOL_VERSION = '2025-06-18';

export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_INTERNAL = -32603;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

const SERVER_INSTRUCTIONS =
  'okx-market-guard exposes OKX PUBLIC market data only (ticker, candles, funding rate, ' +
  'open interest, and stateless threshold checks). Every market tool is read-only. ' +
  'This server has no API key, cannot place or cancel orders, and cannot access account or wallet data. ' +
  'Spot instrument IDs look like BTC-USDT; perpetuals look like BTC-USDT-SWAP.';

const SERVER_INSTRUCTIONS_WITH_TRADE =
  'okx-market-guard: READ-ONLY OKX public market tools plus DEMO-FIRST trading composed from the ' +
  'official @okx_ai/okx-trade-cli (spawned as a child process). Market tools are public read-only REST. ' +
  'Trade tools (trade_*) are destructive and default to --demo. This server never holds API keys; ' +
  'the user configures ~/.okx/config.toml and the official CLI reads it. ' +
  'Live mode is off unless explicitly enabled and OKX_AI_BUILDER_CODE is set. ' +
  'aiBuilderCode is only attached to commands whose official --help exposes the flag. ' +
  'Spot IDs: BTC-USDT. Perps: BTC-USDT-SWAP.';

export class McpServer {
  private negotiatedVersion: string = LATEST_PROTOCOL_VERSION;
  private readonly client: OkxClient;
  private readonly extraTools: readonly ToolDef[];
  private readonly allTools: readonly ToolDef[];

  constructor(client: OkxClient, extraTools: readonly ToolDef[] = []) {
    this.client = client;
    this.extraTools = extraTools;
    this.allTools = [...TOOLS, ...extraTools];
  }

  /**
   * Handle one newline-delimited JSON-RPC message.
   * Returns a response line (JSON + "\n") for requests, or null for notifications.
   */
  async handleRaw(line: string): Promise<string | null> {
    let msg: unknown;
    try {
      msg = JSON.parse(line) as unknown;
    } catch {
      return this.serialize({
        jsonrpc: '2.0',
        id: null,
        error: { code: ERR_PARSE, message: 'Invalid JSON' },
      });
    }
    return this.handleMessage(msg);
  }

  async handleMessage(msg: unknown): Promise<string | null> {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return this.serialize({
        jsonrpc: '2.0',
        id: null,
        error: { code: ERR_INVALID_REQUEST, message: 'Request must be a JSON object' },
      });
    }
    const req = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return this.serialize({
        jsonrpc: '2.0',
        id: (req.id as string | number | null | undefined) ?? null,
        error: { code: ERR_INVALID_REQUEST, message: 'Missing jsonrpc:"2.0" or method' },
      });
    }

    // Notifications (no id): handle and return null.
    if (req.id === undefined || req.id === null) {
      // initialized / cancelled / other notifications: nothing to emit.
      return null;
    }

    const id = req.id as string | number;
    try {
      const result = await this.dispatch(req.method, req.params);
      return this.serialize({ jsonrpc: '2.0', id, result });
    } catch (err) {
      return this.serialize({ jsonrpc: '2.0', id, error: toRpcError(err) });
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.onInitialize(params);
      case 'ping':
        return {};
      case 'tools/list':
        return this.onToolsList();
      case 'tools/call':
        return this.onToolsCall(params);
      default:
        throw methodNotFound(method);
    }
  }

  private onInitialize(params: unknown): Record<string, unknown> {
    const p = (params ?? {}) as { protocolVersion?: unknown; clientInfo?: unknown };
    const requested = typeof p.protocolVersion === 'string' ? p.protocolVersion : undefined;
    this.negotiatedVersion =
      requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
    const clientInfo =
      p.clientInfo && typeof p.clientInfo === 'object'
        ? (p.clientInfo as { name?: unknown; version?: unknown })
        : {};
    this.log(
      `client connected: ${String(clientInfo.name ?? 'unknown')} ${String(clientInfo.version ?? '')} ` +
        `protocol=${this.negotiatedVersion}`,
    );
    return {
      protocolVersion: this.negotiatedVersion,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: SERVER_NAME,
        version: VERSION,
      },
      instructions: this.extraTools.length > 0 ? SERVER_INSTRUCTIONS_WITH_TRADE : SERVER_INSTRUCTIONS,
    };
  }

  private onToolsList(): Record<string, unknown> {
    return {
      tools: this.allTools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      })),
    };
  }

  private async onToolsCall(params: unknown): Promise<Record<string, unknown>> {
    const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof p.name !== 'string') {
      throw invalidParams('tools/call requires a tool name');
    }
    const tool = this.allTools.find((t) => t.name === p.name);
    if (!tool) {
      throw invalidParams(
        `Unknown tool "${p.name}". Available: ${this.allTools.map((t) => t.name).join(', ')}`,
      );
    }
    try {
      const data = await tool.run(p.arguments, this.client);
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        isError: false,
      };
    } catch (err) {
      // Tool-level failures (validation, OKX errors, network) go to the agent
      // as isError content so it can adjust arguments and retry.
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text', text: `Tool ${p.name} failed: ${msg}` },
        ],
        isError: true,
      };
    }
  }

  private log(msg: string): void {
    if (typeof process !== 'undefined' && process.stderr?.write) {
      process.stderr.write(`[okx-market-guard] ${msg}\n`);
    }
  }

  private serialize(res: JsonRpcResponse): string {
    return `${JSON.stringify(res)}\n`;
  }
}

class RpcMethodError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcMethodError';
    this.code = code;
    this.data = data;
  }
}

function methodNotFound(method: string): RpcMethodError {
  return new RpcMethodError(ERR_METHOD_NOT_FOUND, `Unknown method: ${method}`);
}

function invalidParams(message: string): RpcMethodError {
  return new RpcMethodError(ERR_INVALID_PARAMS, message);
}

function toRpcError(err: unknown): JsonRpcError {
  if (err instanceof RpcMethodError) {
    return { code: err.code, message: err.message, data: err.data };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { code: ERR_INTERNAL, message: msg };
}

export interface ServeStdioOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  extraTools?: readonly ToolDef[];
  tradeMode?: 'demo' | 'live' | undefined;
}

/** Run the MCP server on stdio (newline-delimited JSON-RPC 2.0). */
export async function serveStdio(client: OkxClient, opts: ServeStdioOptions = {}): Promise<void> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const server = new McpServer(client, opts.extraTools ?? []);

  const hasTrade = (opts.extraTools?.length ?? 0) > 0;
  const banner = hasTrade
    ? [
        `[okx-market-guard] MCP stdio server ready (protocol ${LATEST_PROTOCOL_VERSION})`,
        '[okx-market-guard] Market: READ-ONLY OKX public REST',
        `[okx-market-guard] Trade: official @okx_ai/okx-trade-cli composition, mode=${opts.tradeMode ?? 'demo'}`,
        '[okx-market-guard] No API keys in this process. User config in ~/.okx/config.toml.',
        '[okx-market-guard] Waiting for JSON-RPC lines on stdin...',
      ]
    : [
        `[okx-market-guard] MCP stdio server ready (protocol ${LATEST_PROTOCOL_VERSION})`,
        '[okx-market-guard] READ-ONLY: OKX public market REST only',
        '[okx-market-guard] No API keys, no orders, no account access',
        '[okx-market-guard] Waiting for JSON-RPC lines on stdin...',
      ];
  stderr.write(banner.join('\n') + '\n');

  stderr.write(
    [
      `[okx-market-guard] MCP stdio server ready (protocol ${LATEST_PROTOCOL_VERSION})`,
      '[okx-market-guard] READ-ONLY: OKX public market REST only',
      '[okx-market-guard] No API keys, no orders, no account access',
      '[okx-market-guard] Waiting for JSON-RPC lines on stdin...',
    ].join('\n') + '\n',
  );

  let buffer = '';
  const onClose = new Promise<void>((resolve) => {
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onEnd);
      resolve();
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line !== '') {
          void server
            .handleRaw(line)
            .then((out) => {
              if (out !== null) stdout.write(out);
            })
            .catch((err: unknown) => {
              stderr.write(`[okx-market-guard] handler crash: ${String(err)}\n`);
            });
        }
        idx = buffer.indexOf('\n');
      }
    };
    const onEnd = (): void => {
      cleanup();
    };
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onEnd);
  });

  await onClose;
  stderr.write('[okx-market-guard] stdin closed, exiting\n');
}
