# magpie-mistral-pool

[![CI](https://github.com/weijianping/magpie-mistral-pool/actions/workflows/ci.yml/badge.svg)](https://github.com/weijianping/magpie-mistral-pool/actions/workflows/ci.yml)

**[中文 → README.md](README.md)**

Put a **Mistral account's Vibe allowance** behind [magpie](https://github.com/yetone/magpie). One plugin, two engines: official ACP billed to the **$300 Vibe pool**, or an honest direct connection billed to the **$30 API pool**.

> Unofficial plugin, not affiliated with Mistral AI. No client fingerprint spoofing, no faked official User-Agent — the direct engine is an ordinary OpenAI-compatible provider.

The two engines:

- **direct** (default) — plain OpenAI Chat Completions through the account's
  own key. It does not spoof a client, pool keys, or expose another gateway.
- **acp** — runs the official `vibe-acp` child and bridges Magpie's tools over
  MCP, so requests bill to the **Monthly Vibe ($300)** allowance.

Both engines expose the Vibe-surface model catalog and show the plan's two
allowance pools in the usage card.

Provider id: `mistral-vibe`. It is separate from Magpie's built-in `mistral`
API-key provider.

Two entries of this plugin can be loaded side by side — for example ACP on the
`$300` pool as the main route and direct on the `$30` pool as a fallback.
Give the second entry its own `options.providerId`; the id is what the host
keys auth, config and the provider registry by, so the two never share a
credential or a config slot:

```jsonc
[
  { "spec": "github:weijianping/magpie-mistral-pool",
    "options": { "engine": "acp", "proxyUrl": "http://127.0.0.1:7890" } },
  { "spec": "github:weijianping/magpie-mistral-pool",
    "options": { "engine": "direct", "providerId": "mistral-vibe-api",
                 "proxyUrl": "http://127.0.0.1:7890" } }
]
```

The derived provider is named **Mistral Vibe (API)**. A blank `providerId`
falls back to `mistral-vibe`.

## Install

Pick one:

```sh
# 1) GitHub
magpie plugin add github:weijianping/magpie-mistral-pool

# 2) local folder (when editing the code)
magpie plugin add <path-to-this-repo>

# 3) npm package (not published yet; see docs/publish.md)
# magpie plugin add @solary/magpie-mistral-pool
```

Then sign in:

```sh
magpie plugin login mistral-vibe
```

## Engine: ACP ($300 Vibe pool)

ACP needs the official CLI on the machine that runs the Magpie plugin host:

```sh
uv tool install --python 3.14 mistral-vibe
vibe-acp --version
```

Select it in `plugins.json`:

```jsonc
{
  "spec": "github:weijianping/magpie-mistral-pool",
  "options": {
    "engine": "acp",
    "proxyUrl": "http://127.0.0.1:7890"
  }
}
```

The provider is then named **Mistral Vibe (ACP · $300)**. Reload the plugin
host (or restart Magpie) after changing `engine` or `providerId`; the old
provider object can stay cached in a running UI.

How the bridge works:

- One `vibe-acp` child per conversation, each with an isolated temporary
  `VIBE_HOME` and its own `config.toml`.
- Magpie's tools are exposed through a loopback Streamable-HTTP MCP server.
  Tool calls return to Magpie as normal OpenAI `tool_calls`; the next
  `role: tool` message is fed back into the same ACP session.
- Built-in Vibe tools (for example `bash`) are rejected. The bridge only
  permits `run_typescript`, `search_tool_functions`, and the session's own
  MCP tools.
- If a Magpie tool takes longer than `relayAfterMs`, the bridge returns a
  `[MAGPIE_RELAY]` notice and exposes `magpie_await_result` so the model can
  wait without re-running the tool.

ACP options:

```jsonc
{
  "engine": "acp",
  "vibeAcpPath": "C:\\Users\\you\\.local\\bin\\vibe-acp.exe",
  "vibeAcpArgs": [],
  "maxSessions": 4,
  "relayAfterMs": 45000,
  "sessionTtlMs": 600000,
  "firstOutputMs": 720000,
  "idleMs": 300000
}
```

`vibeAcpPath` is optional; the plugin finds `vibe-acp` on `PATH` (or through
`where.exe` on Windows). `vibeAcpArgs` is for test-only wrappers and is used
together with `vibeAcpPath`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| \`engine\` | \`direct\` | \`direct\` / \`acp\` |
| \`providerId\` | \`mistral-vibe\` | provider id; use it to tell two entries apart |
| \`providerName\` | derived from engine | name shown in the UI |
| \`proxyUrl\` | empty | outbound proxy, also handed to the ACP child |
| \`vibeAcpPath\` | \`PATH\` (via \`where.exe\` on Windows) | pin \`vibe-acp\` explicitly |
| \`vibeAcpArgs\` | \`[]\` | test-only wrapper args, used with \`vibeAcpPath\` |
| \`maxSessions\` | 4 | concurrent ACP sessions per bridge |
| \`maxBridges\` | 4 | per-key bridge instances; idle ones are reclaimed LRU |
| \`relayAfterMs\` | 45000 | when a tool call turns into a relay notice |
| \`sessionTtlMs\` | 600000 | idle session expiry |
| \`firstOutputMs\` | 720000 | first-byte budget |
| \`idleMs\` | 300000 | idle budget between stream chunks |
| \`includeApiSurface\` | \`false\` | also expose \`codestral\` / \`ministral\` / \`pixtral\` |

Environment: \`VIBE_ACP_CMD\` overrides the \`vibe-acp\` command; \`HTTP_PROXY\` /
\`HTTPS_PROXY\` / \`NODE_USE_ENV_PROXY\` are covered under *Proxy*.

## Sign in

- **Browser (PKCE)** — the same flow as the official CLI: `POST
  console.mistral.ai/api/vibe/sign-in`, open the returned page, poll, then
  exchange the token for an API key. The key is stored by Magpie's auth store.
- **Vibe API key** — paste a key made in the console under *Code > Vibe Code
  CLI*.

The whoami read is rooted at the console origin. A base that ends in `/v1`
(or `/api/v1`) is stripped before `/api/vibe/whoami` is appended, so the
plugin never requests `/v1/api/vibe/whoami`.

## Billing, and the two pools

`GET /billing/subscription` and `GET /billing/budget` are read with the
account's bearer key. `vibe_budget` is shown as **Monthly Vibe** and
`api_budget` as **Platform API credits**; the pool the key bills to counts,
the other is `aside`.

- From **2026-12-01**, direct API calls made by non-Mistral products count
  against the **$30 API allowance**, not the **$300 Vibe allowance**.
- The `acp` engine runs the official CLI, so its calls count against the
  **$300 Monthly Vibe** allowance. It keeps working when the `$30` API pool is
  exhausted.
- The `direct` engine never fakes a Vibe client to reach the `$300` pool.
- `/billing/budget` can answer 403 for members without the
  `see_org_inference_usage` permission. That degrades to the plan only; it
  never breaks the usage card.

## Models

The account's live `GET /model-catalog?surface=vibe-code` wins; `GET /models`
is the fallback, then a static Vibe-surface list. A Vibe (or unknown) key
never sees `codestral`, `ministral` or `pixtral`, which route on the API
surface. An API key sees them only with `options.includeApiSurface: true`.

## Transport

- First response byte: **720 s** (`options.firstOutputMs`), for both the
  direct transport and the ACP bridge.
- Stream idle between chunks: **300 s** (`options.idleMs`), for both engines.
- TCP keepalive when `undici` is installed. In Magpie's Bun host the plugin
  uses the host's `fetch` instead, which applies `proxyUrl` per request and
  owns the connection settings.
- No 60 s header timeout: it would kill a deep-thinking request before its
  first byte.
- SSE is passed chunk by chunk with backpressure; nothing buffers a whole
  completion.

## Proxy

```jsonc
// plugins.json -> the plugin's options
{ "proxyUrl": "http://127.0.0.1:7890" }
```

On Node, `proxyUrl` needs `undici` (an optional dependency). Node's global
`fetch` ignores `HTTPS_PROXY`; on Node 22.21+/24+ you can instead run Magpie
with `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY` set. That works with or without
`undici`: the transport reads the same flag and builds a `ProxyAgent` when
the package is present, otherwise Node's own fetch does it.

Under Magpie's Bun host the plugin does not load `undici` at all — that would
bypass the host's fetch. It calls the host's `fetch` and passes `proxyUrl` as
Bun's per-request `proxy` option, so the plugin host's proxy settings and CA
store apply as they do for every other provider.

The ACP child receives `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` from
`proxyUrl`, with loopback explicitly excluded through `NO_PROXY`. Its control
plane (whoami/billing) still uses the plugin's normal transport and proxy.

The undici agent's internal `headersTimeout` / `bodyTimeout` are disabled on
purpose. Its 300 s default would otherwise kill a request whose first byte
takes longer, before the 720 s first-output budget is spent.

## Sticky sessions

`chat.headers` writes `x-affinity` and `x-session-id` from Magpie's session
id, only for this provider. To keep one account for a whole session:

```sh
magpie group set <group> stays=session
```

## Troubleshooting

- **402 in direct mode** — the `$30` API pool is exhausted. Switch to
  `engine: "acp"` (and install `vibe-acp`) to bill the `$300` Vibe pool.
- **402 in ACP mode** — the `$300` Vibe pool is exhausted, or the child is
  using an account without the Vibe entitlement. The plugin returns the
  upstream error; it does not retry or cool down on its own.
- **`MAX_SESSIONS`** — four live ACP children is the default. Lower
  `maxSessions` or let idle sessions expire via `sessionTtlMs`.
- **403 on /billing/budget** — expected without the org-usage permission;
  the card shows the plan.
- **429** — Magpie's own retry semantics apply; the plugin does not invent a
  cooldown.
- **Timeouts** — raise `firstOutputMs` / `idleMs`, or check the proxy. A
  timeout before any byte is `TRANSPORT_TIMEOUT_FIRST_OUTPUT`; a stalled
  stream is `TRANSPORT_TIMEOUT_IDLE`.
- **Proxy ignored** — on Node, install `undici` or use
  `NODE_USE_ENV_PROXY=1`; under Magpie's Bun host the per-request `proxy`
  option is already applied.
- **Stale quota card** — the GUI caches usage. Reopen the settings page or
  restart the Magpie plugin host.

## Tests

```sh
npm test
node scripts/acp-smoke.mjs                 # real ACP text stream
node scripts/acp-tool-smoke.mjs            # real MCP tool round-trip
node scripts/billing-probe.mjs snapshot    # 12/1 pre-check
```

CI (`.github/workflows/ci.yml`) runs `node --test` and `npm pack --dry-run`
on ubuntu / windows / macos across node 20/22/24. The `scripts/*.mjs` files
hit the network and stay local.

## Security and scope

- No User-Agent spoofing, no client fingerprint emulation, no multi-key
  rotation; accounts and rotation stay in Magpie's own features.
- Outbound headers go through a whitelist, so unrelated host headers never
  leak upstream.
- Only `billing` and `whoami` are read; no quota is cached locally.
- Each ACP child gets a temporary `VIBE_HOME` that is removed on exit
  (`taskkill /T` as the Windows fallback).

## Layout

| Path | Contents |
| --- | --- |
| `index.mjs` | plugin entry: provider, auth, billing, chat |
| `src/core.mjs` | constants, Vibe-surface model list, key-type detection, header cleanup |
| `src/billing.mjs` | subscription / budget reads mapped into Magpie usage windows |
| `src/thinking.mjs` | rewrites stored reasoning into Mistral's typed content parts |
| `src/transport.mjs` | 720 s / 300 s watchdogs, proxy, retry boundaries |
| `src/acp/` | ACP runtime, JSON-RPC, MCP server, OpenAI mapping, child config |
| `test/` | `node --test` unit and contract tests |
| `scripts/` | live smoke tests and the dual-pool billing probe |

## License

MIT, see [LICENSE](LICENSE). Mistral and Vibe are trademarks of Mistral AI.

