# OKX Market Guard

Read-only OKX public market data for AI agents. Ships as an **MCP server** (stdio, JSON-RPC 2.0) and a **CLI**. Zero runtime npm dependencies. TypeScript source runs directly on Node 22.6+ / Node 24 (type stripping).

> **Safety first.** This project talks **only** to official OKX **public** market REST endpoints on `https://www.okx.com`. It has **no API key**, cannot place or cancel orders, cannot withdraw, and cannot read account or wallet data. Alerts are stateless threshold checks — nothing is stored, nothing is pushed.

## Tools

| Tool | What it does | OKX endpoint (public GET) |
| --- | --- | --- |
| `market_ticker` | Latest ticker + 24h change % + spread % | `/api/v5/market/ticker` |
| `market_candles` | OHLCV candles, newest first, `bar` 1m–3M, limit 1–300 | `/api/v5/market/candles` |
| `funding_rate` | Current funding rate for a perpetual (`-SWAP` instId) | `/api/v5/public/funding-rate` |
| `oi_summary` | Open interest by `instId` or by `instType`/`ccy` | `/api/v5/public/open-interest` |
| `alert_check` | One-shot threshold vs latest data (stateless) | same public endpoints |

`alert_check` metrics: `last`, `changePercent24h`, `high24h`, `low24h`, `bidAskSpreadPct`, `fundingRate` (SWAP only), `openInterest` (SWAP/FUTURES). Operators: `gt`, `gte`, `lt`, `lte`.

## Safety rails

- **Host + path allowlist.** Only `https://www.okx.com` and the five public paths above (plus `/api/v5/public/time`). Private/trade/account paths are rejected in-process, before any HTTP.
- **No credentials, ever.** Passing `apiKey` / `secret` / `passphrase` / `token` as options throws. Requests carry no `Authorization` header. `redirect: 'error'` blocks redirect-based SSRF.
- **Read-only MCP annotations.** Every tool advertises `readOnlyHint: true`, `destructiveHint: false`.
- **Input validation.** instId shape, bar enum, limit range, extra-key rejection, SWAP-required checks for funding.
- **Rate limit.** Token bucket, default 8 req/s, burst 16 (OKX public limits are ~20 req / 2 s per IP).
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
  okx-client.ts    allowlisted public REST client
  tools/index.ts   the five tools
  mcp/server.ts    JSON-RPC 2.0 stdio server
  cli.ts           CLI + serve
  validate.ts      input validation
  ratelimit.ts     token bucket + credential guard
  errors.ts        friendly errors
test/              node:test unit + live
demo/demo.ts       live demo
docs/              demo transcript, AI Builder application draft
```

## What this is not

- Not a trading bot. Not a key manager. Not a WebSocket feed. Not a mirror of okx.com.
- Application to OKX AI Builder is a **draft only** (`docs/`); submitting it is a human action via the **official** App (Menu → Builder) or **okx.com**. Do not use mirror/help domains.

## License

MIT
