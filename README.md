# magpie-mistral-pool

A Magpie provider plugin for Mistral Vibe. It is the **honest** route: plain
OpenAI Chat Completions on `api.mistral.ai/v1` with the account's own key, the
Vibe-surface model catalog, and the plan's two allowance pools in the usage
card. It does not spoof a client User-Agent, simulate a handshake, pool keys,
or expose its own `/v1` gateway.

Provider id: `mistral-vibe`. It is separate from Magpie's built-in `mistral`
API-key provider.

## Install

```sh
magpie plugin add <path-to-this-folder-or-package>
magpie plugin login mistral-vibe
```

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
- Spending the `$300` Vibe pool requires the official `vibe` CLI / ACP path;
  this plugin deliberately does not fake the client to reach it.
- `/billing/budget` can answer 403 for members without the
  `see_org_inference_usage` permission. That degrades to the plan only; it
  never breaks the usage card.

## Models

The account's live `GET /model-catalog?surface=vibe-code` wins; `GET /models`
is the fallback, then a static Vibe-surface list. A Vibe (or unknown) key
never sees `codestral`, `ministral` or `pixtral`, which route on the API
surface. An API key sees them only with `options.includeApiSurface: true`.

## Transport

- First response byte: **720 s** (`options.firstOutputMs`).
- Stream idle between chunks: **300 s** (`options.idleMs`).
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

- **402** — the pool the key bills to is exhausted. The plugin returns the
  upstream error; it does not retry or cool down on its own.
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

## Tests

```sh
npm test
node scripts/billing-probe.mjs snapshot   # 12/1 pre-check
```
