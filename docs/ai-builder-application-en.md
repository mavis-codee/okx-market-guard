# OKX AI Builder — Application Draft (EN)

> **How to use this file.** Copy the fields below into the official OKX AI Builder form.
> Official entrances only: **OKX App → Menu → Builder** or **okx.com**.
> Do **not** submit from any mirror or "help" domain.
> This repository does not submit anything by itself. Submitting is a human action after the owner says go.

---

## 1. Project name

OKX Market Guard

## 2. Track / category

AI track — official CLI integration (`@okx_ai/okx-trade-cli`) with attribution, plus a read-only market MCP server

## 3. One-liner (≤ 140 chars)

Demo-first OKX trading via the official CLI (`--aiBuilderCode` on supported commands) plus read-only market MCP. Keys never enter the agent process.

## 4. The problem

AI agents that need OKX market context usually get one of two bad options:

1. A full trading API with keys pasted into the agent — over-privileged, easy to leak, easy for the model to do something irreversible.
2. Scraped web pages or stale CSVs — wrong, slow, and against OKX terms.

On the trading side, the AI Builder program requires a verifiable `aiBuilderCode` on supported order commands. Many agent wrappers either drop the code, stuff it into a raw `tag`, or reimplement signing in a way OKX cannot attribute.

There is no small, auditable bridge that (a) gives an agent public market facts read-only, and (b) places orders **only** through the official CLI, **demo by default**, with `--aiBuilderCode` attached exactly where official `--help` says it belongs.

## 5. The solution

**OKX Market Guard** is a Model Context Protocol server (and a matching CLI) with two layers:

**Market layer — five read-only tools** (public REST on `https://www.okx.com/api/v5/*`, no keys):

- `market_ticker` — last / bid / ask / 24h stats / change % / spread %
- `market_candles` — OHLCV, 1m to 3M, up to 300 bars
- `funding_rate` — perpetual funding (requires a `-SWAP` instrument)
- `oi_summary` — open interest by instrument or by product/currency
- `alert_check` — one-shot threshold (`gt/gte/lt/lte`) against the latest public data

**Trade layer — nine tools that spawn the official `@okx_ai/okx-trade-cli@1.5.1`:**

- `trade_spot_place` → `okx spot place`
- `trade_spot_batch_place` → `okx spot batch --action place`
- `trade_swap_place` → `okx swap place`
- `trade_swap_close` → `okx swap close`
- `trade_swap_batch_place` → `okx swap batch --action place`
- `trade_futures_place` → `okx futures place`
- `trade_futures_close` → `okx futures close`
- `trade_futures_batch_place` → `okx futures batch --action place`
- `trade_option_place` → `okx option place`

We do not wrap `cancel` / `amend` / query commands. Their official `--help` does not expose `--aiBuilderCode`. We never pass a raw `tag`.

## 6. How it uses OKX

- Official **OKX V5 public market REST** for the market layer (ticker, candles, funding-rate, open-interest, server time). No private endpoints from our own HTTP client.
- Official **`@okx_ai/okx-trade-cli`** for every order. Signing, profiles, and request envelopes stay in the official package. We spawn it; we do not reimplement the trade API.
- **AI Builder attribution:** when `OKX_AI_BUILDER_CODE` is set (1–16 alphanumeric), the bridge appends `--aiBuilderCode <code>` **only** to commands whose official `--help` on 1.5.1 lists the flag: `spot place`, `spot batch (place)`, `swap place`, `swap close`, `swap batch (place)`, `futures place`, `futures close`, `futures batch (place)`, `option place`.
- **Demo default:** every trade spawn carries `--demo` unless the operator started the server with `--trade-live`. Live without a code is rejected. Live is a **server startup flag**, not a tool argument — the agent cannot upgrade itself to real funds.
- Credentials live in the user's `~/.okx/config.toml`. The agent process never reads, stores, or prints `api_key` / `secret_key` / `passphrase`. The child CLI reads that file.

## 7. Target users

- Agent / copilot developers who want live OKX market context without handing the model a trading key, and who want demo-first order placement when trading is needed at all.
- Builders in the OKX AI Builder program who need a reference implementation of **official-CLI composition + correct `aiBuilderCode` attribution**.
- Internal tools that must pass a "no key in the agent, no real funds by default" security review.

## 8. Why it is different

| Usual integration | OKX Market Guard |
| --- | --- |
| Full API key in the agent's hands | **Zero credentials in this process** — key-like options throw; child env is an allowlist |
| Hand-written trade API + custom signing | **Official CLI child process** — order logic is OKX's, not ours |
| `aiBuilderCode` dropped, or stuffed into raw `tag` | **Help-verified whitelist** — flag only on commands whose official `--help` exposes it |
| Live as a tool parameter the model can flip | **Live is a server startup flag**; default `--demo`; empty code + live = reject |
| Silent rate-limit failures | Token bucket (market) + separate trade-spawn throttle + friendly OKX error hints |
| "Alerts" that need a database and push channel | **Stateless** market check; nothing stored, nothing pushed |

## 9. Safety and compliance (design, not marketing)

Market layer:

- Host lock: `https://www.okx.com` only. Mirrors are rejected in code.
- Path allowlist: 5 public market paths + time. Anything else throws `SafetyError` before a socket is opened.
- `redirect: 'error'` so a 302 cannot bounce us off-origin.
- MCP annotations: market tools `readOnlyHint: true`, `destructiveHint: false`.

Trade layer:

- Composition only: `src/trade-cli-bridge.ts` validates, rate-limits, builds argv, spawns, redacts errors. It does not sign.
- `--demo` is the default. `--live` is never inferred from tool arguments.
- `OKX_AI_BUILDER_CODE`: empty → live rejected; 1–16 alnum else rejected.
- Child env allowlist (`PATH`, proxy, site/timeout) strips `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE`.
- Raw `tag` is rejected as an unknown argument.
- Trade tools advertise `readOnlyHint: false`, `destructiveHint: true`.
- Tests mock `execFile`; `npm test` never places a real order, demo or live.

## 10. Demo

- Repo-local market transcript: `docs/demo-output.txt` (real REST responses for all five tools plus two rejection cases).
- Official-CLI help evidence (1.5.1) showing where `--aiBuilderCode` appears and where it does not: also in `docs/demo-output.txt`.
- CLI plan (no spawn, no order):

```bash
node src/cli.ts trade-tools --pretty
node src/cli.ts trade-plan trade_spot_place --instId BTC-USDT --side buy --ordType limit --sz 0.001 --px 50000 --pretty
```

- MCP: any MCP client → `node src/cli.ts serve` (trade tools on, demo). `--no-trade` for market-only.

Walkthrough:

1. MCP `initialize` → server name `okx-market-guard`; instructions describe market read-only + demo-first official-CLI trading.
2. `tools/list` → 5 market tools (`readOnlyHint`) + 9 `trade_*` tools (`destructiveHint: true`).
3. `tools/call market_ticker {instId:"BTC-USDT"}` → live last/bid/ask.
4. `tools/call trade_spot_place {...}` in default mode → child argv contains `--demo`; with `OKX_AI_BUILDER_CODE` set it also contains `--aiBuilderCode`.
5. Try to flip live from the tool call → impossible; live is `--trade-live` at server start, and empty code rejects.

## 11. Stack

- TypeScript (erasable syntax) on Node 22.6+ / 24, run directly (no build step).
- Market layer: zero runtime npm dependencies. `fetch` is Node's built-in.
- Trade layer: official `@okx_ai/okx-trade-cli` (1.5.1 verified), resolved from `OKX_TRADE_CLI`, local `node_modules`, or `npx -y`.
- MCP implemented as newline-delimited JSON-RPC 2.0 over stdio (no SDK).
- Tests: `node:test` (81 cases; live public-endpoint smokes skip when OKX is unreachable).

## 12. Roadmap (if we keep building)

1. **v0.2** — optional `instType` ticker sweep, history candles pagination helper.
2. **v0.3** — more public endpoints that stay read-only: instruments, mark-price, index-tickers.
3. **v0.4** — follow official CLI releases: if later versions expose `--aiBuilderCode` on more commands (or new product lines), extend the help-verified whitelist; never ahead of official help.
4. **Not on the roadmap:** key escrow, a second signing implementation, live-by-default, or raw `tag` attribution.

## 13. Team

Mavis — design and implementation of this MVP (MCP server, CLI, official-CLI trade bridge, safety rails, tests, docs). Contact via the details on the official form.

## 14. What we are asking for

- Inclusion in the OKX AI Builder co-build program (AI track).
- Review of the **official CLI composition + `aiBuilderCode` help-whitelist** pattern; we want to stay aligned with how OKX wants builders to attribute agent-placed orders.
- If accepted: official docs link, and a nudge on which additional **public** endpoints or official-CLI surfaces OKX wants showcased.

We are **not** asking for market-maker flags or key escrow. Trading permissions are the user's own, via their own `~/.okx/config.toml` and the official CLI.

## 15. Honest limitations

- Public REST only for market data; no order-book depth beyond L1 ticker bid/ask.
- `alert_check` is point-in-time; it does not watch.
- Trade tools require the user to install/configure the official CLI and a profile. This repo does not bundle keys.
- `cancel` / `amend` are not exposed as tools (help does not expose `--aiBuilderCode` there). Users who need cancel can run the official CLI themselves.
- No i18n in tool output (English field names, OKX raw number strings).
- Demo and tests need outbound HTTPS to `www.okx.com` (or an HTTP proxy via `NODE_USE_ENV_PROXY`).

---

**Submission reminder.** Paste the above into the official form only. The owner of this repo has not approved a public git remote, a GitHub release, or an actual submission. `push` / new repo / 申报 = wait for a human yes.
