# 路线 B 可执行任务书：`magpie-mistral-pool`

> **历史任务书**：本文记录了初期仅做路线 B（`direct`）时的任务拆解；随后项目已追加实现路线 A（`acp`）及双入口派生能力。当前完整说明请以根目录 [README.md](../README.md) 为准。

> 目标：在 Magpie 内交付一个**诚实的** Mistral Vibe provider 插件。
> 计费预期：2026-12-01 后走 `$30` API 池；不伪造客户端指纹、不模拟握手、不自建网关。
> 工期目标：0.5–1 人日；先交付可运行 MVP，再做 12/1 计费验证。

## 0. 交付边界

### 做

- Magpie provider 插件：`config` / `auth` / `provider.models` / `chat.headers`。
- 复用 `magpie-mistral-code` 的 OAuth PKCE 与 thinking 整形。
- 复用 `MistralVibe2API` 的头清洗、Vibe surface 目录、key 类型识别、双池 usage。
- 自定义 `fetch`：首字 720s、流空闲 300s、TCP keepalive、可选代理。
- 12/1 对照实验脚本：`scripts/billing-probe.mjs`（已交付）。

### 不做

- 不做 KeyPoolManager / 粘性 TTL 路由（交给 Magpie 多账号 + `stays=session`）。
- 不自建 `/v1/models`、`/v1/chat/completions`、`/v1/messages`（Magpie 网关已有）。
- 不写 `prompt_cache_key`（Mistral/Vibe 都不读）。
- 不默认伪造 `User-Agent`、不模拟 `whoami` / `managed-config` 握手。
- 不强制 HTTP/1.1（Node/undici 默认就是 HTTP/1.1）。
- 不用 60s 头超时（会杀掉长思考请求）。
- 不在 12/1 实验前启动 ACP 移植。

## 1. 目标仓库结构

```text
magpie-mistral-pool/
├── package.json
├── index.mjs                 # 插件入口：config / auth / provider / chat.headers
├── src/
│   ├── core.mjs              # 常量、模型目录、key 类型、头清洗
│   ├── thinking.mjs          # reasoning_content -> Mistral thinking part
│   ├── billing.mjs           # subscription/budget -> Magpie usage windows
│   └── transport.mjs         # 720s/300s 超时、keepalive、可选代理
├── test/
│   ├── core.test.mjs
│   ├── thinking.test.mjs
│   ├── billing.test.mjs
│   ├── transport.test.mjs
│   └── plugin.test.mjs
├── scripts/
│   └── billing-probe.mjs     # 12/1 对照实验（已交付）
├── docs/
│   ├── plan1-review.md
│   ├── plan1-B-taskbook.md
│   └── experiment-1201-billing.md
└── README.md
```

## 2. 复用映射（先抄哪一段）

| 来源 | 目标 | 复用内容 | 必须改的地方 |
| --- | --- | --- | --- |
| `magpie-mistral-code/index.mjs:467-639` | `index.mjs` | 插件骨架、`auth.methods`、`auth.loader`、`provider.models` | provider id 改 `mistral-vibe`；UA 默认改为不设置 |
| `magpie-mistral-code/index.mjs:398-462` | `src/thinking.mjs` | `thinkingText` / `asMistralMessage` / `mistralBody` | 原样搬，补单测 |
| `MistralVibe2API/src/core.mjs:33-117` | `src/core.mjs` | 头白名单、`sanitizeHeaders` | **删掉强制写 `user-agent` 的分支**；保留 `x-affinity`/`x-session-id` |
| `MistralVibe2API/src/core.mjs:140-217` | `src/core.mjs` | Vibe surface 静态目录、live 目录合并 | 校正 canonical ID；按 key 类型过滤 |
| `MistralVibe2API/src/core.mjs:313-401` | `src/core.mjs` / `src/billing.mjs` | `identifyKey`、`fetchBilling`、`budgetToWindows` | 用 Bearer；403 降级 |
| `MistralVibe2API/index.mjs:74-118` | `index.mjs` | key 类型缓存、`countingPool` | 只做类型识别，不做号池 |
| `plugins/packages/zen-free/provider.mjs:861-867` | `index.mjs` | `chat.headers` 写 `sessionID` | 改成 `x-affinity` / `x-session-id` |
| `plugins/README.md:369-398` | 全局 | 插件契约 | 不要引入 manifest/端口/IPC |

## 3. 文件级改动

### 3.1 `package.json`

```json
{
  "name": "@solary/magpie-mistral-pool",
  "version": "0.1.0",
  "description": "Mistral Vibe provider for Magpie: honest Chat Completions, Vibe-surface models, dual-pool usage.",
  "type": "module",
  "main": "./index.mjs",
  "files": ["index.mjs", "src/", "README.md", "LICENSE"],
  "license": "MIT",
  "engines": { "node": ">=20" },
  "optionalDependencies": { "undici": "^7.16.0" },
  "scripts": {
    "test": "node --test",
    "probe": "node scripts/billing-probe.mjs"
  },
  "magpie": {
    "name": "Mistral Vibe (honest)",
    "summary": {
      "en": "Mistral Vibe/Studio key as a Magpie provider. Vibe-surface models, dual-pool usage, no client fingerprint spoofing.",
      "zh": "把 Mistral Vibe/Studio key 接成 Magpie provider：只暴露 Vibe surface 模型，双池用量展示，不伪造客户端指纹。"
    },
    "icon": "data:image/svg+xml,..."
  }
}
```

说明：

- `undici` 是 **optional**：有它才启用 `ProxyAgent` 与 TCP keepalive；没有它时退回全局 `fetch`，超时逻辑仍然生效。
- 不声明 manifest schema；配置走 `plugins.json` 的 `options`。

### 3.2 `index.mjs`

导出 `default { id, server }`，`server(input, options)` 返回：

```js
{
  config,
  auth: { provider, methods, loader, usage },
  provider: { id, models },
  'chat.headers': async (input, output) => {},
}
```

#### `config`

```js
cfg.provider ??= {}
cfg.provider[PROVIDER] ??= {
  name: 'Mistral Vibe',
  npm: '@ai-sdk/openai-compatible', // Chat Completions
  api: opts.baseUrl,
  models: STATIC_VIBE_MODELS,
}
```

- `PROVIDER = 'mistral-vibe'`，不要覆盖内置 `mistral`。
- `opts.baseUrl` 默认 `https://api.mistral.ai/v1`。

#### `auth.methods`

- `{ type: 'oauth', label: 'Sign in with Mistral (browser)', authorize }`：从 `magpie-mistral-code/index.mjs:513-629` 原样移植 PKCE 流程。
- `{ type: 'api', label: 'Vibe API key' }`：手动粘贴。
- OAuth 返回的 key 写入 Magpie 的 auth store；不要自己落盘。

#### `auth.loader`

```js
loader: async (getAuth) => {
  const auth = await getAuth()
  const key = auth?.key
  if (!key) return {}
  return {
    baseURL: opts.baseUrl,
    apiKey: key,
    fetch: createPluginFetch({ key, options: opts }),
  }
}
```

`createPluginFetch` 的职责：

1. 用 `sanitizeHeaders` 清洗下游头（只留 `content-type`、`accept`、`x-affinity`、`x-session-id`）。
2. 设置 `authorization: Bearer <key>`。
3. 调 `normalizeBody`（thinking 整形）。
4. 交给 `transport.fetch`（720s/300s）。
5. 不设置 UA（除非 `opts.userAgent` 显式配置）。

AI SDK 可能把 `Request` 对象传进来，也可能传 `(url, init)`。先统一成 `{ url, init }`：

- `input instanceof Request` 时取 `input.url` 与 `input.headers`；
- `init.body` 为空但 `input.body` 存在时，用 `input.clone().arrayBuffer()` 读出再整形；
- 整形后删除 `content-length`，交给 fetch 重新计算。

#### `provider.models`

```js
async models(provider, { auth } = {}) {
  if (!auth?.key) return STATIC_VIBE_MODELS
  const keyType = await identifyKey(auth.key, opts)
  return loadModels({ key: auth.key, keyType, options: opts })
}
```

- `loadModels` 先请求 `GET {base}/model-catalog?surface=vibe-code`，失败退 `GET {base}/models`，再失败用静态目录。
- `keyType === 'vibe'` 或 `unknown`：只保留 Vibe surface。
- `keyType === 'api'`：可保留全量，但建议用另一个 provider id（`mistral-vibe-api`）以免混池。
- 输出 OpenCode 1.x 模型形状：`name`、`limit`、`tool_call`、`attachment`、`reasoning`、`modalities`、`cost`。

#### `auth.usage`

- 读 `GET {base}/billing/subscription` 与 `GET {base}/billing/budget`，Bearer。
- `vibe_budget` → `Monthly Vibe`，主窗口。
- `api_budget` → `Platform API credits`，按 key 类型决定主/旁路（`aside: true`）。
- `budget` 403 时只返回 plan，不抛错。

#### `chat.headers`

```js
async 'chat.headers'(input, output) {
  if (![PROVIDER, `${PROVIDER}-plugin`].includes(input.model?.providerID)) return
  if (!input.sessionID) return
  output.headers['x-affinity'] = input.sessionID
  output.headers['x-session-id'] = input.sessionID
}
```

- 不写 `x-dsh-session`（DSH 专用）。
- README 里写明：`magpie group set <group> stays=session`。

### 3.3 `src/core.mjs`

导出：

| 函数/常量 | 作用 |
| --- | --- |
| `PROVIDER` / `DEFAULT_BASE` | 常量 |
| `STATIC_VIBE_MODELS` | 静态 Vibe surface 目录 |
| `sanitizeHeaders(incoming, { key })` | 头白名单 + Bearer |
| `identifyKey(key, opts)` | `/api/vibe/whoami` → `vibe`/`api`/`unknown` |
| `loadModels(...)` | live 目录 + 静态合并 + surface 过滤 |
| `toOpenCodeModel(...)` | 目录项 → Magpie 模型形状 |

`sanitizeHeaders` 规则：

- 只放行：`content-type`、`accept`、`x-affinity`、`x-session-id`、`x-session-affinity`。
- 丢弃：`user-agent`、`x-stainless-*`、`origin`、`referer`、`cookie`、`x-api-key`、`anthropic-*`、`x-forwarded-*`、`via`、`host`、`content-length`、`connection`、`transfer-encoding`、`accept-encoding`。
- 设置：`authorization: Bearer <key>`。
- 流式请求：`accept: text/event-stream`；非流式：`application/json`。
- **不设置** `user-agent`。如果 `opts.userAgent` 非空，才显式设置（实验用）。

`STATIC_VIBE_MODELS` 至少包含：

```text
deepseek-v4-1-flash-1017
mistral-large-4-0
mistral-medium-latest
mistral-vibe-cli-latest
mistral-vibe-cli-with-tools
mistral-vibe-cli-fast
zai-glm-5-3
zai-glm-5-3-flash
zai-glm-5-3-flash-vibe-free
```

不要放 `codestral` / `ministral` / `pixtral` 等 API-surface 模型。

### 3.4 `src/thinking.mjs`

从 `magpie-mistral-code/index.mjs:398-462` 原样移植，导出 `mistralBody(body)`：

- 输入 `string` / `Uint8Array` / `ArrayBuffer`；其他类型原样返回。
- 无 `reasoning` 字段时，字节级原样返回。
- `reasoning_content` / `reasoning` / `reasoning_details` → `{ type: 'thinking', thinking: [{ type: 'text', text }] }`。
- `prefix: true` 的 assistant 消息只删字段，不插入 thinking。
- 解析失败时原样返回。

### 3.5 `src/billing.mjs`

从 `MistralVibe2API/src/core.mjs:357-460` 移植：

- `fetchBilling(key, opts)`：并行读 subscription + budget；403 降级。
- `poolForKeyType(keyType)`：`api` → `api_budget`，否则 `vibe_budget`。
- `budgetToWindows(budget, counting)`：`used` / `limit` / `amount` / `unit: 'USD'` / `resetsAt` / `span` / `aside`。
- `used = initial_budget * usage_percentage / 100`；`initial_budget` 缺失时只报百分比。

### 3.6 `src/transport.mjs`

这是本次改造的核心。

```js
export function createTransport({
  proxyUrl,
  firstOutputMs = 720_000,
  idleMs = 300_000,
  keepAliveInitialDelayMs = 30_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  return { fetch: (url, init) => fetchWithDeadlines(url, init, {...}) }
}
```

#### 超时语义

1. **首字超时**：从 `fetch` 开始到响应头到达，超过 `firstOutputMs` → abort，抛 `TransportTimeoutError('first-output')`。
2. **流空闲超时**：响应头到达后，每收到一个 chunk 重置计时；超过 `idleMs` 没有新 chunk → abort，抛 `TransportTimeoutError('stream-idle')`。
3. 这两个值来自官方 `vibe/core/config/_defaults.py:20-24`：`DEFAULT_API_TIMEOUT = 720.0`、`DEFAULT_API_STREAM_IDLE_TIMEOUT = 300.0`。
4. **不要**用 60s 头超时；那会在深度思考的首字前杀掉请求。

#### 实现要点

- 用 `AbortController`；把调用方的 `init.signal` 与内部 timer 合并。
- 响应头到达后清掉首字 timer，再包装 `response.body`：
  ```js
  const reader = response.body.getReader()
  const wrapped = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          clearIdle()
          controller.close()
          return
        }
        resetIdle()
        controller.enqueue(value)
      } catch (error) {
        clearIdle()
        controller.error(error)
      }
    },
    cancel(reason) {
      clearIdle()
      return reader.cancel(reason)
    },
  })
  return new Response(wrapped, { status, statusText, headers })
  ```
- `pull` 每次只读一个 chunk，天然带背压；**不要**在 `start` 里 `for(;;)` 读完，那会把整条 SSE 流缓冲进内存。
- idle timer 触发时要同时 `abort()`、`reader.cancel()`、`controller.error(timeoutError)`，否则消费者可能一直等不到结束。
- 不要在代理层缓冲整个响应；逐 chunk 透传。
- 错误类型：
  - `TRANSPORT_TIMEOUT_FIRST_OUTPUT`
  - `TRANSPORT_TIMEOUT_IDLE`
  - `TRANSPORT_RESET`
- 重试策略：只在**首字节前**重试（`maxRetriesBeforeFirstByte`，默认 0）；首字节后绝不重放，避免重复输出。

#### 代理与 keepalive

- 有 `undici` 时：
  ```js
  const { Agent, ProxyAgent, fetch: undiciFetch } = await import('undici')
  const dispatcher = proxyUrl
    ? new ProxyAgent(proxyUrl)
    : new Agent({
        connect: { keepAlive: true, keepAliveInitialDelay: 30_000 },
        keepAliveTimeout: 60_000,
      })
  ```
- 没有 `undici` 时：退回全局 `fetch`；`proxyUrl` 只记录一条 warning，不静默假装生效。
- 不要强制 HTTP/1.1；Node/undici 默认就是 HTTP/1.1，`allowH2` 不开即可。

### 3.7 `README.md`

必须写清：

- 安装：`magpie plugin add <path-or-package>`。
- 登录：OAuth PKCE 或手动 Vibe key。
- 计费：12/1 后直连计入 `$30`；`$300` 需要官方 CLI/ACP。
- 模型面：只列 Vibe surface；API-surface 模型不会出现在 Vibe key 下。
- 代理：`options.proxyUrl`；需要 `undici`。
- 超时：720s/300s，可在 `options` 覆盖。
- 粘性：`magpie group set <group> stays=session`。
- 故障排查：402、403（budget 权限）、429、超时、代理。

## 4. 测试清单

### 单元测试

| 文件 | 用例 |
| --- | --- |
| `test/core.test.mjs` | 头清洗丢弃 UA / `x-stainless-*` / `cookie`；保留 `x-affinity`；Bearer 覆盖；surface 过滤排除 `codestral`；`identifyKey` 映射 `CHAT`/`API`/unknown |
| `test/thinking.test.mjs` | `reasoning_content` → thinking part；`reasoning_details` 合并；`prefix` 只删不插；无 reasoning 时字节不变；非法 JSON 原样返回 |
| `test/billing.test.mjs` | 双池解析；`initial_budget` 缺失；403 降级；`aside` 标记；`resetsAt` 解析 |
| `test/transport.test.mjs` | 首字超时；空闲超时；正常流不被误杀；调用方 abort 透传；错误码正确 |
| `test/plugin.test.mjs` | `chat.headers` 只对自己 provider 生效；`sessionID` → `x-affinity`；`provider.models` 按 key 类型过滤；`auth.usage` 形状 |

### 手动验收

1. `node --test` 全绿。
2. 在 Magpie 里安装插件，模型列表只出现 Vibe surface。
3. 发一条 `deepseek-v4-1-flash-1017`，200；usage 卡片两个池都有数。
4. 带 `reasoning_content` 的多轮对话不 422。
5. 12/1 后用 `scripts/billing-probe.mjs` 验证 direct 的池归属。
6. `rg -i 'user-agent|prompt_cache_key|x-api-key' src index.mjs`：不应出现伪造 UA、缓存键、`x-api-key`。

### 回归测试

- 402：`$30` 耗尽时返回结构化错误，不挂起。
- 403：`/billing/budget` 无权限时 usage 卡片只显示 plan。
- 429：Magpie 的 rest 语义生效；插件不自己冷却。
- 长上下文：首字 > 10s、总时长 > 5min 的流完整结束。

## 5. 实施顺序（半天）

| 顺序 | 工作 | 产出 |
| --- | --- | --- |
| 1 | 建骨架 + `package.json` + `config` hook | Magpie 能加载空插件 |
| 2 | 搬 `thinking.mjs` + 单测 | 422 回归通过 |
| 3 | 搬 `core.mjs` 头清洗 + 目录 + key 类型 | 模型列表正确 |
| 4 | 搬 `billing.mjs` + `auth.usage` | 双池卡片 |
| 5 | 写 `transport.mjs` + 超时测试 | 长流不误杀 |
| 6 | 接 `auth.methods` / `loader` / `chat.headers` | 端到端 200 |
| 7 | README + 手动验收 | 可交付 |

## 6. 验收标准

- [ ] Magpie 能加载插件，`provider.models` 只暴露 Vibe surface。
- [ ] Vibe key 下 `codestral` / `ministral` / `pixtral` 不可见。
- [ ] `chat.headers` 写入 `x-affinity` / `x-session-id`，且只对自己 provider 生效。
- [ ] `thinking` 历史不触发 422。
- [ ] 首字 720s、空闲 300s 可配置；60s 不出现在代码里。
- [ ] `/billing/budget` 403 时 usage 不崩。
- [ ] 代码中无伪造 UA、无 `prompt_cache_key`、无 `x-api-key`、无自建 `/v1/*`。
- [ ] 12/1 实验脚本可独立运行，输出 JSON 含双池增量。

## 7. 风险与注意事项

| 风险 | 处理 |
| --- | --- |
| `undici` 在 Magpie 宿主（Bun）不可用 | 动态 import + 全局 fetch 回退；代理功能显式 warning |
| 宿主自己的超时比 720s 短 | README 写明；端到端压测确认 |
| `usage_percentage` 精度不足 | 用 `--prompt-file` 加大 prompt 或 `--repeats 10` |
| Vibe surface 目录变化 | live catalog 优先；静态目录只做 fallback |
| OAuth PKCE 流程随 Mistral 改动 | 复用 `magpie-mistral-code` 的现有实现，保持可替换 |
| 12/1 后 direct 仍进 `$300` | 那是好消息：B 路线可用，A 不必做；以实验为准 |

## 8. 与路线 A 的接口

本任务书不实现 ACP，但保留两个扩展点：

- `provider.models` 的模型形状与 ACP 版本一致，未来可并列注册 `mistral-vibe-acp`。
- `transport.mjs` 的错误分类（首字/空闲/重置）可直接复用于 ACP 的首输出前换 key。

等 12/1 实验满足三道门槛后，再按 `docs/plan1-review.md` 第 6 节 Phase 2 拆 ACP 任务书。

