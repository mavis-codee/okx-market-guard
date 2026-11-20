# OKX Market Guard

Read-only OKX public market data for AI agents, plus **demo-first trading** composed from the **official** `@okx_ai/okx-trade-cli`. Ships as an **MCP server** (stdio, JSON-RPC 2.0) and a **CLI**. Market tools have zero runtime npm dependencies. TypeScript source runs directly on Node 22.6+ / Node 24 (type stripping).

> **Safety first.** Market tools talk **only** to official OKX **public** market REST on `https://www.okx.com`. They have **no API key**, cannot place or cancel orders, and cannot read account or wallet data. Alerts are stateless. Trade tools are a thin spawn of the official OKX CLI: **`--demo` is the default**, live is an explicit opt-in, and this process never reads or stores your keys.

## Tools

| Tool | What it does | OKX endpoint (public GET) |
| --- | --- | --- |
| `market_ticker` | Latest ticker + 24h change % + spread % | `/api/v5/market/ticker` |
| `market_candles` | OHLCV candles, newest first, `bar` 1m–3M, limit 1–300 | `/api/v5/market/candles` |
| `funding_rate` | Current funding rate for a perpetual (`-SWAP` instId) | `/api/v5/public/funding-rate` |
| `oi_summary` | Open interest by `instId` or by `instType`/`ccy` | `/api/v5/public/open-interest` |
| `alert_check` | One-shot threshold vs latest data (stateless) | same public endpoints |

`alert_check` metrics: `last`, `changePercent24h`, `high24h`, `low24h`, `bidAskSpreadPct`, `fundingRate` (SWAP only), `openInterest` (SWAP/FUTURES). Operators: `gt`, `gte`, `lt`, `lte`.

## Trading via the official CLI (demo by default)

Market tools stay read-only. Trading is **composition**: we spawn the official [`@okx_ai/okx-trade-cli`](https://www.npmjs.com/package/@okx_ai/okx-trade-cli) (verified on **1.5.1**) as a child process. Order logic, signing, and profile handling live in the official package. This repo only validates input, rate-limits, builds argv, and friendlies errors.

| Tool | Official command | `--aiBuilderCode` (per official `--help` 1.5.1) |
| --- | --- | --- |
| `trade_spot_place` | `okx spot place` | yes |
| `trade_spot_batch_place` | `okx spot batch --action place` | yes (place only) |
| `trade_swap_place` | `okx swap place` | yes |
| `trade_swap_close` | `okx swap close` | yes |
| `trade_swap_batch_place` | `okx swap batch --action place` | yes (place only) |
| `trade_futures_place` | `okx futures place` | yes |
| `trade_futures_close` | `okx futures close` | yes |
| `trade_futures_batch_place` | `okx futures batch --action place` | yes (place only) |
| `trade_option_place` | `okx option place` | yes |

We do **not** wrap `cancel`, `amend`, or query commands. Their official `--help` does not expose `--aiBuilderCode`, and attribution must follow the official help, not a raw tag. Raw `tag` is never passed to the CLI.

**Mode.** Default is `--demo`. Live requires `--trade-live` (CLI) **and** a valid `OKX_AI_BUILDER_CODE`. Empty code + live = rejected. Code rule: 1–16 alphanumeric (official AI Builder rule).

**Credentials.** Keys stay in the user's `~/.okx/config.toml`. This process never reads, stores, or prints `api_key` / `secret_key` / `passphrase`. The child CLI reads that file. We spawn with an env allowlist (`PATH`, proxy, …) and strip `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE`. `OKX_AI_BUILDER_CODE` is a builder attribution code, not a credential; the bridge may read it.

**Profiles.** `--profile demo` is the default profile name. Create a demo profile yourself:

```bash
npx @okx_ai/okx-trade-cli profile add --name demo --demo
# or: okx profile add --name demo --demo
```

**Install.** The official CLI is not a hard dependency of this repo. Resolution order: `OKX_TRADE_CLI` path → `node_modules/@okx_ai/okx-trade-cli/dist/index.js` → `npx -y @okx_ai/okx-trade-cli@1.5.1`.

```bash
# optional, pins the official CLI locally
npm install --no-save @okx_ai/okx-trade-cli@1.5.1
```

**Try without trading (plan only, nothing spawned):**

```bash
node src/cli.ts trade-tools --pretty
node src/cli.ts trade-plan trade_spot_place --instId BTC-USDT --side buy --ordType limit --sz 0.001 --px 50000 --pretty
# live plan (fails without OKX_AI_BUILDER_CODE)
OKX_AI_BUILDER_CODE=yourcode node src/cli.ts trade-plan trade_swap_place --instId BTC-USDT-SWAP --side buy --ordType market --sz 1 --trade-live --pretty
```

**MCP:** `serve` includes trade tools by default (demo). `--no-trade` gives the old market-only server. `--trade-live` is the live opt-in.

## Safety rails

- **Host + path allowlist.** Only `https://www.okx.com` and the five public paths above (plus `/api/v5/public/time`). Private/trade/account paths are rejected in-process, before any HTTP.
- **No credentials, ever.** Passing `apiKey` / `secret` / `passphrase` / `token` as options throws. Requests carry no `Authorization` header. `redirect: 'error'` blocks redirect-based SSRF.
- **Read-only MCP annotations on market tools.** Every market tool advertises `readOnlyHint: true`, `destructiveHint: false`. Trade tools advertise `readOnlyHint: false`, `destructiveHint: true`.
- **Input validation.** instId shape, bar enum, limit range, extra-key rejection, SWAP-required checks for funding.
- **Rate limit.** Token bucket, default 8 req/s, burst 16 (OKX public limits are ~20 req / 2 s per IP). Trade spawns are separately throttled (2/s, burst 4).
- **aiBuilderCode whitelist.** The flag is attached only to commands whose official `--help` on 1.5.1 exposes it. Help does not expose it → we do not add it and we do not claim attribution.
- **No real-funds testing in CI.** Tests mock the child process. Live/demo order placement is not part of `npm test`.
- **Friendly OKX errors.** Envelope `code !== '0'` becomes a message with a hint (wrong instId type, rate limit, timeout, DNS/proxy).
- **Stateless alerts.** `alert_check` compares one number to one threshold and returns. No watchlists, no notifications, no writes.

## Quick start

Node.js **>= 22.6** (24 recommended). No `npm install` needed.

```bash
node src/cli.ts --help
node src/cli.ts ticker BTC-USDT --pretty
node src/cli.ts candles BTC-USDT --bar 1H --limit 24 --pretty
node src/cli.ts funding BTC-USDT-SWAP --pretty
node src/cli.ts oi BTC-USDT-SWAP --pretty
node src/cli.ts alert BTC-USDT --metric last --op gt --threshold 100000 --pretty
```

If your network cannot resolve `www.okx.com` directly (common behind a firewall), restart Node with the built-in proxy flag **before** the process starts:

```powershell
# Windows PowerShell
$env:NODE_USE_ENV_PROXY = "1"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"   # your local proxy
node src/cli.ts ticker BTC-USDT --pretty
```

```bash
# macOS / Linux
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 node src/cli.ts ticker BTC-USDT --pretty
```

`NODE_USE_ENV_PROXY` is only read at Node bootstrap; setting it inside the script is too late. `--env-file=.env` does **not** apply it.

## MCP client config

Point any MCP client at the stdio server:

```json
{
  "mcpServers": {
    "okx-market-guard": {
      "command": "node",
      "args": ["<absolute-path>/src/cli.ts", "serve"],
      "env": {
        "NODE_USE_ENV_PROXY": "1",
        "HTTPS_PROXY": "http://127.0.0.1:7890"
      }
    }
  }
}
```

Market-only (no trade tools advertised):

```json
{
  "mcpServers": {
    "okx-market-guard-readonly": {
      "command": "node",
      "args": ["<absolute-path>/src/cli.ts", "serve", "--no-trade"]
    }
  }
}
```

Live trading is **not** a tool argument. The agent cannot upgrade the server to live. Restart with `--trade-live` and `OKX_AI_BUILDER_CODE` in the **host** env if the owner wants live.

Protocol: newline-delimited JSON-RPC 2.0 on stdio. Advertises `2025-06-18` (also accepts `2025-03-26`, `2024-11-05`). Logs go to **stderr**; JSON-RPC goes to **stdout**.

## Tests

```bash
npm test          # unit tests (mocked fetch) + live tests (skip if OKX unreachable)
```

Live tests hit real public endpoints with `BTC-USDT` / `BTC-USDT-SWAP`. Force-skip them with `OKX_SKIP_LIVE=1`.

Demo (real REST, prints a full transcript):

```bash
node demo/demo.ts
# transcript of a recent run: docs/demo-output.txt
```

## Layout

```
src/
  okx-client.ts         allowlisted public REST client
  tools/index.ts        the five market tools
  trade-cli-bridge.ts   official CLI composition (spawn, whitelist, code)
  mcp/server.ts         JSON-RPC 2.0 stdio server
  cli.ts                CLI + serve
  validate.ts           input validation
  ratelimit.ts          token bucket + credential guard
  errors.ts             friendly errors
test/                   node:test unit + live
demo/demo.ts            live market demo
docs/                   demo transcript, help evidence, AI Builder application draft
```

## What this is not

- Not a trading-strategy bot. Not a key manager. Not a WebSocket feed. Not a mirror of okx.com.
- Trading is the **official** OKX CLI, not our reimplementation. We do not sign requests.
- Application to OKX AI Builder is a **draft only** (`docs/`); submitting it is a human action via the **official** App (Menu → Builder) or **okx.com**. Do not use mirror/help domains.

## License

MIT
