# magpie-mistral-pool

[![CI](https://github.com/zhuangzm/magpie-mistral-pool/actions/workflows/ci.yml/badge.svg)](https://github.com/zhuangzm/magpie-mistral-pool/actions/workflows/ci.yml)

**[中文 → README.md](README.md)**

Put a **Mistral account's Vibe allowance** behind [magpie](https://github.com/yetone/magpie). One plugin, two engines: the official ACP path billed to the plan's **$300 Vibe pool**, or an honest direct connection billed to the **$30 API pool**.

> Unofficial plugin, not affiliated with Mistral AI. No client fingerprint spoofing and no faked official User-Agent — the direct engine is an ordinary OpenAI-compatible provider.

## The two engines

| Engine | Who sends the request | Which pool it bills |
| --- | --- | --- |
| `direct` (default) | the plugin itself, over OpenAI Chat Completions | from 2026-12-01, calls from non-Mistral products count against the **$30 Platform API allowance** |
| `acp` | the official `vibe-acp` child (ACP plus a loopback MCP bridge) | the official product path, counted against the **$300 Monthly Vibe allowance** |

Both engines expose the same Vibe-surface model list and show both pools on the usage card.

Provider id: `mistral-vibe`, independent of Magpie's built-in `mistral` API-key provider.

The panel names entries by engine: **Mistral Vibe (ACP · $300)** for `acp` and **Mistral Vibe (API)** for `direct`. `options.providerName` overrides either.

## Two entries side by side ($300 main + $30 fallback)

The same plugin can be loaded twice, each entry with its own id:

```jsonc
[
  { "spec": "github:zhuangzm/magpie-mistral-pool",
    "options": { "engine": "acp" } },
  { "spec": "github:zhuangzm/magpie-mistral-pool",
    "options": { "engine": "direct", "providerId": "mistral-vibe-api" } }
]
```

A blank `providerId` falls back to `mistral-vibe`. The host keys credentials, config and usage by providerId, so the two entries never share a key slot.

Reload the plugin host (or restart Magpie) after changing `engine` / `providerId`; a running UI can keep the old provider object cached.

## Install

Pick one:

```sh
# 1) GitHub
magpie plugin add github:zhuangzm/magpie-mistral-pool

# 2) local folder (when editing the code)
magpie plugin add <path-to-this-repo>

# 3) npm package (not published on npm yet; see docs/publish.md)
# magpie plugin add @solary/magpie-mistral-pool
```

Then sign in:

```sh
magpie plugin login mistral-vibe
```

## Engine: acp (official CLI, $300 Vibe pool)

Needs the official CLI on the machine that runs the Magpie plugin host:

```sh
uv tool install --python 3.14 mistral-vibe
vibe-acp --version
```

Select it in `plugins.json`:

```jsonc
{
  "spec": "github:zhuangzm/magpie-mistral-pool",
  "options": { "engine": "acp" }
}
```

The provider is then named **Mistral Vibe (ACP · $300)**. The proxy follows the system by default; write `proxyUrl` only to pin a port (see *Proxy*).

How the bridge works:

- One `vibe-acp` child per conversation, each with an isolated temporary `VIBE_HOME` and its own `config.toml`.
- Magpie's tools are exposed through a loopback Streamable-HTTP MCP server. Tool calls return to Magpie as normal OpenAI `tool_calls`; the next `role: tool` message is fed back into the same ACP session.
- Built-in Vibe tools (for example `bash`) are rejected. Only `run_typescript`, `search_tool_functions` and the session's own MCP tools are allowed.
- If a tool takes longer than `relayAfterMs`, the bridge answers with a `[MAGPIE_RELAY]` notice and exposes `magpie_await_result`, so the model waits instead of re-running the tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `engine` | `direct` | `direct` / `acp` |
| `providerId` | `mistral-vibe` | provider id; use it to tell two entries apart |
| `providerName` | derived from engine | name shown in the panel |
| `proxyUrl` | empty (auto-detect) | outbound proxy: URL / `system` / `none`; also handed to the ACP child |
| `noProxy` | empty (reads `NO_PROXY`) | extra direct-connect exceptions, comma separated, `*` / `.domain` / CIDR supported |
| `vibeAcpPath` | `PATH` (via `where.exe` on Windows) | pin `vibe-acp` explicitly |
| `vibeAcpArgs` | `[]` | test-only wrapper args, used with `vibeAcpPath` |
| `maxSessions` | 4 | concurrent ACP sessions per bridge |
| `maxBridges` | 4 | per-key bridge instances; idle ones are reclaimed LRU |
| `relayAfterMs` | 45000 | when a tool call turns into a relay notice |
| `sessionTtlMs` | 600000 | idle session expiry |
| `firstOutputMs` | 720000 | first-byte budget |
| `idleMs` | 300000 | idle budget between stream chunks |
| `includeApiSurface` | `false` | also expose `codestral` / `ministral` / `pixtral` |

Environment: `VIBE_ACP_CMD` overrides the `vibe-acp` command; `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY` take part in the proxy lookup described under *Proxy*.

## Sign in

- **Browser (PKCE)** — same flow as the official CLI: `POST console.mistral.ai/api/vibe/sign-in`, open the returned page, poll, then exchange the token for an API key. The key is stored by Magpie's auth store.
- **Vibe API key** — paste a key created in the console under *Code > Vibe Code CLI*.

The whoami read is rooted at the console origin: a trailing `/v1` (or `/api/v1`) is stripped before `/api/vibe/whoami` is appended, so the plugin never requests `/v1/api/vibe/whoami`.

## Billing, and the two pools

`GET /billing/subscription` and `GET /billing/budget` are read with the account's bearer key. `vibe_budget` is shown as **Monthly Vibe**, `api_budget` as **Platform API credits**; the pool the key actually bills to counts, the other is marked `aside`.

- From **2026-12-01**, direct API calls made by non-Mistral products count against the **$30 API allowance**, not the **$300 Vibe allowance**.
- The `acp` engine runs the official CLI, so it counts against the **$300 Monthly Vibe** allowance and keeps working when the `$30` pool is exhausted.
- The `direct` engine never pretends to be a Vibe client to reach the `$300` pool.
- `/billing/budget` can answer 403 for members without `see_org_inference_usage`. That degrades to showing the plan only; the usage card never breaks.

## Models

The account's live `GET /model-catalog?surface=vibe-code` wins; `GET /models` is the fallback, then the built-in Vibe-surface list. A Vibe (or unknown) key never sees `codestral`, `ministral` or `pixtral` (they route on the API surface); an API key sees them only with `options.includeApiSurface: true`.

## Transport

- First response byte: **720 s** (`options.firstOutputMs`), same for direct and ACP.
- Stream idle between chunks: **300 s** (`options.idleMs`), same for both engines.
- TCP keepalive when `undici` is installed; in Magpie's Bun host the plugin uses the host `fetch` instead, which applies the resolved proxy per request and owns the connection settings.
- No 60 s header timeout: it would cut a deep-thinking request off before its first byte.
- SSE is passed through chunk by chunk with backpressure; nothing buffers a whole completion.

## Proxy

Follows the system proxy by default — no port to type. Lookup order:

1. a URL in `options.proxyUrl` — an explicit setting always wins;
2. `"none"` (also `off` / `direct` / `disabled`) forces a direct connection;
3. `"system"` (also `auto` / `windows` / `default`) forces one system probe;
4. the environment: `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` (either case);
5. the Windows WinINET proxy: `ProxyEnable` / `ProxyServer` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`, including `http=…;https=…` and the `ProxyOverride` exception list;
6. otherwise direct.

So a blank `proxyUrl` means "auto": change the Clash port, switch clients or enable TUN, and the plugin needs no edit.

```jsonc
{ "proxyUrl": "system" }                 // same as leaving it blank: env → system proxy → direct
{ "proxyUrl": "http://127.0.0.1:1080" }  // pin a port
{ "proxyUrl": "none" }                   // force direct
```

- Loopback (`127.*`, `::1`, `localhost`) is always direct, so the plugin's own smoke tests and local endpoints are unaffected.
- Only the static system setting is read; PAC scripts are never evaluated, and a system with only a PAC URL falls back to direct — which is what TUN mode wants anyway.
- All three exits share one result: the control plane (`whoami` / `billing`), the API sockets and the `vibe-acp` child. The child gets `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` from the plugin, and its `NO_PROXY` merges the options, `noProxy`, the system exceptions and loopback.
- On Node, proxying needs `undici` (an optional dependency) because the plugin builds a `ProxyAgent`. Under Magpie's Bun host the plugin never loads `undici` (that would bypass the host fetch); it passes the resolved proxy as Bun's per-request `proxy` option, so the host's proxy and CA settings still apply.
- The undici agent's `headersTimeout` / `bodyTimeout` are disabled on purpose: the 300 s defaults would fire before a late first byte and waste the 720 s budget. The plugin's own 720 s / 300 s watchdogs own both deadlines.

## Sticky sessions

`chat.headers` writes `x-affinity` and `x-session-id` from Magpie's session id, only for this provider. To keep one account for a whole session:

```sh
magpie group set <group> stays=session
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| 402 in `direct` | the `$30` API pool is exhausted; switch to `engine: "acp"` (with `vibe-acp` installed) to bill the `$300` Vibe pool |
| 402 in `acp` | the `$300` Vibe pool is exhausted, or the child's account has no Vibe entitlement; the plugin returns the upstream error and does not retry or cool down on its own |
| `MAX_SESSIONS` | 4 concurrent ACP children is the default; lower `maxSessions`, or let idle sessions expire through `sessionTtlMs` |
| 403 on `/billing/budget` | expected without the org-usage permission; the card shows the plan only |
| 429 | Magpie's own retry semantics apply; the plugin invents no cooldown |
| Timeouts | raise `firstOutputMs` / `idleMs` and check the proxy is reachable; a timeout before any byte is `TRANSPORT_TIMEOUT_FIRST_OUTPUT`, a stalled stream `TRANSPORT_TIMEOUT_IDLE` |
| Proxy ignored | check the `proxy: <source> <url>` log line — only `option` / `environment` / `windows` (plus `system` for a forced probe) count as a hit; a PAC-only system proxy is not parsed and goes direct, so set `proxyUrl` when unsure. On Node, `undici` is still required |
| Stale quota card | GUI cache; reopen the settings page or restart the Magpie plugin host |

## Security and scope

- No User-Agent spoofing, no client fingerprint emulation, no multi-key rotation; accounts and rotation stay in Magpie's own features.
- Outbound headers go through a whitelist, so unrelated host headers never leak upstream.
- Only `billing` and `whoami` are read; no quota is cached locally.
- Each ACP child gets a temporary `VIBE_HOME` that is removed on exit (`taskkill /T` as the Windows fallback).

## Tests

```sh
npm test                                   # unit + contract tests, all against local mocks
node scripts/acp-smoke.mjs                 # real ACP text stream (needs a key)
node scripts/acp-tool-smoke.mjs            # real MCP tool round-trip (needs a key)
node scripts/billing-probe.mjs snapshot    # dual-pool balance snapshot
```

CI (`.github/workflows/ci.yml`) runs `node --test` and `npm pack --dry-run` on ubuntu / windows / macos × node 20/22/24. The `scripts/*.mjs` files hit the network and stay local, outside CI.

## Layout

| Path | Contents |
| --- | --- |
| `index.mjs` | plugin entry: provider, auth, billing, chat |
| `src/core.mjs` | constants, Vibe-surface model list, key-type detection, header cleanup |
| `src/billing.mjs` | subscription / budget reads mapped into Magpie usage windows |
| `src/thinking.mjs` | rewrites stored reasoning into Mistral's typed content parts |
| `src/proxy.mjs` | proxy lookup: option / environment / Windows system proxy, NO_PROXY rule matching |
| `src/transport.mjs` | 720 s / 300 s watchdogs, proxy, retry boundaries |
| `src/acp/` | ACP runtime, JSON-RPC, MCP server, OpenAI mapping, child config |
| `test/` | `node --test` unit and contract tests |
| `scripts/` | live smoke tests and the dual-pool billing probe |

## License

MIT, see [LICENSE](LICENSE). Mistral and Vibe are trademarks of Mistral AI.
