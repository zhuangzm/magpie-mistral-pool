# Plan1 / Plan1.1 联合评审

> 评审对象：`docs/plan1.md`、`docs/plan1.1.md`
> 交叉核对源码：`dsh-plugin-bundle`、`plugins`、`mistral-vibe`、`magpie-mistral-code`、`MistralVibe2API`
> 评审日期：2026-11-27
> 配套交付：`docs/plan1-B-taskbook.md`（路线 B 任务书）、`docs/experiment-1201-billing.md`（12/1 实验说明）、`scripts/billing-probe.mjs`（对照脚本）

## 0. 一页结论

**Plan1 不能按原样执行。** 它不是"细节没补齐"，而是三个承重前提都不成立：

1. **要移植的"Vibe 请求指纹能力"在 `dsh-mistral-pool` 里根本不存在。** 它的直连模式是一个透明字节代理：只重写 `Authorization`，其余请求头原样透传，**没有** User-Agent 注入、**没有** `speakeasy` 头、**没有** `prompt_cache_key`。全仓库 `rg -i 'speakeasy|user-agent|prompt_cache_key'` 均为零命中。
2. **Plan1 的 DoD #1 与 dsh 自身设计相反。** dsh 的 README 明确写：2026-12-01 起，非官方产品直连即使拿 Vibe key 也扣 `$30`；代码在该日期后主动把直连限定到 Studio key（`lib/index.js:544-562`）。Plan1 想移植的"核心能力"，正是 dsh 主动放弃的那条路。
3. **把 Magpie 插件理解成了 DSH 插件。** Magpie provider 插件是 OpenCode 1.x 形状的进程内插件（`config` / `auth` / `provider` / `chat.headers`），没有 Plan1 想象的那种 manifest（端口/进程/配置字段声明；`package.json` 的 `magpie` 字段只是名称/图标/摘要等元数据），没有独立端口、没有 IPC；`/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、协议转换、多账号路由、Stays、401/429 的 rest 与路由回退全部已由 Magpie 网关承担。Plan1 的 §3.1/§3.2/§3.4 是在网关里再造一个网关。

**Plan1.1 的根因诊断也是错的。** 它把失败归因于"缺少 `whoami` + `managed-config` 握手"和"必须发送 `speakeasy-sdk/python 3.5.0 ...`"，但官方 Vibe 3.1.5 源码里：

- `whoami` 失败返回 `None`，不阻塞（`whoami.py:153-170`）；
- `managed-config` 失败保留旧配置，"never stops the client"（`admin_config.py:79-110`）；
- 真实 UA 是 `mistral-client-python/Mistral-Vibe/3.1.5`（`vibe/utils/http.py:291-304`），**不是** Speakeasy 串；
- 主推理路径直接 `Mistral(...).chat.stream_async(...)`，没有任何前置准入握手（`adapters/mistral.py:139-193`）；
- 它自己引用的 `MistralVibe2API/README.md:108-131` 已经实测出相反结论：**三种 UA / 模型名组合全部 200、限流一致；计量归属由 key 类型决定，不由客户端指纹决定。**

**推荐结论：**

| 你的真实目标 | 应选路线 | 工作量 |
| --- | --- | --- |
| 只想"能用"，`$30` 池还有额度/可充值 | **B. 诚实直连 provider**（接受计入 `$30`） | S/M |
| `$300` 是硬指标，`$30` 已耗尽且不愿充值 | **A. ACP（`vibe-acp`）** | XL |
| 不确定 12/1 后到底扣哪个池 | **Phase 0 对照实验**，先不写产品代码 | S |
| 想靠改 UA/头"骗"进 `$300` | **C. 仅作实验**，不建议产品化 | — |

注意：如果你现在的症状就是 `402 API budget exhausted` 且 `$30` 已耗尽，**B 不会让请求恢复**——它只是诚实地继续用 `$30`。这种情况下只有 A（或直接用官方 `vibe` / `vibe-acp`）能恢复。

如果宿主就是 DSH：直接使用 `dsh-mistral-pool` 的 ACP 模式即可，**不要移植**。移植只有在"必须落地到 Magpie"时才成立。

---

## 1. 评审基线与证据分级

### 1.1 版本基线

| 项目 | 版本/位置 | 用途 |
| --- | --- | --- |
| `mistral-vibe` | `3.1.5`，`mistralai==3.5.0`（`pyproject.toml:3,76`） | 官方客户端行为基准 |
| `dsh-mistral-pool` | `D:\workspaceAI\dsh-plugin-bundle\dsh-mistral-pool` | ACP 运行时与直连代理实现 |
| `magpie-mistral-code` | `@solary/magpie-mistral-vibe@0.2.2` | 已可用的 Magpie provider 插件 |
| `MistralVibe2API` | `mistral-vibe-2api@0.1.0` | 已可用的 Magpie provider 插件 + 独立反代 |
| `plugins` | `magpie-community/plugins` 本地快照 | Magpie 插件契约与 `agy-cli` ACP 先例 |

### 1.2 一个必须先说清的时间陷阱

今天是 **2026-11-27**，所有"2026-11 实测"都发生在 **2026-12-01 计费分界之前**。

- `MistralVibe2API/README.md:110` 的"三种 key 交叉实测（2026-11，同账户）"；
- `:118-123` 的"API key + 完整 Vibe 指纹 → API 池 +$0.0073、Vibe 池 $0"；
- `:125-131` 的"三种 UA 组合全部 200、`vibe_budget` 上涨"；

这些只能证明**分界前**的行为，**不能**证明 12/1 之后直连是否仍计入 `vibe_budget`。Plan1 和 Plan1.1 都把这段当成了永久结论，这是两份文档共同的最大方法论错误。

`MistralVibe2API/test/live.test.mjs:272-303` 也只断言"budget 可读、字段类型正确"，**没有**"请求后 vibe_budget 增长而 api_budget 不变"的断言。所以仓库里没有任何自动化证据支持"直连扣 `$300`"。

### 1.3 证据分级

- **[源码]**：本机可直接复核，本文引用均给出文件与行号。
- **[文档·待复核]**：引用官方文档口径，但本评审环境无外网，未逐字复核。
- **[待验证]**：必须在 2026-12-01 之后用真实 key 对照实验才能定论。

---

## 2. Plan1 的五个致命问题

### 2.1 致命一：dsh 里没有"Vibe 协议指纹层"

**Plan1 的主张（§2、§3.3）：** 从 `dsh-mistral-pool` 提取"访问 Vibe 额度池所需的完整请求头（User-Agent SDK 签名、认证头及其他隐式特征头）"，并"严格注入官方 Vibe SDK 请求头"。

**源码事实：**

- dsh 直连代理的上游 URL 是原样拼接：`const url = \`${store.upstream}${req.url}\``（`lib/index.js:2042`）。
- 请求头由 `forwardableHeaders()` 生成：只剔除 hop-by-hop 头、`authorization`、`accept-encoding`，然后写入 `Authorization: Bearer <key>`（`lib/index.js:1574-1597`）。**其余头原样转发**，不注入任何 UA。
- 全仓库检索：`speakeasy` 0 命中，`user-agent` 0 命中，`prompt_cache_key` 0 命中。
- 直连的调用方（`lib/direct-stream.js:235-250`）只发 `content-type`、`authorization: Bearer pool-managed`、可选的 `x-dsh-session`。

**结论：** Plan1 §2 表格里"需提取的关键信息 #1"是一个不存在的东西。按 Plan1 实施，得到的插件只会把下游 Agent 的 UA（例如 OpenCode/Claude Code 的 UA）继续透传给 Mistral，然后期待它产生和官方 Vibe 一样的计费结果。这不是"移植"，是"想象"。

### 2.2 致命二：DoD #1 与 dsh 自身设计、以及官方计费口径冲突

**Plan1 的主张（§5 DoD #1）：** 配置 Vibe key 后调用必须不再 402，且网页端 `$300` 已用额度实时增长。

**源码/文档事实：**

- `dsh-mistral-pool/README.md:7`：从 **2026-12-01** 起，非 Mistral 官方产品直连 `api.mistral.ai` 时，即使使用 Vibe key 也统一扣 `$30`；只有通过官方产品（包括 `vibe-acp`）的调用继续扣 `$300`。
- `lib/index.js:155-156` 定义了 `DIRECT_API_CUTOFF_MS = 2026-12-01T00:00:00Z`。
- `lib/index.js:548-562` 的 `eligibleKeysForMode()`：直连模式在 cutoff 后（`directKeyScope: 'auto'`）**只选 Studio key**，目的正是"不要误耗 `$300` Vibe key"。
- Mistral 官方计费文档（`https://docs.mistral.ai/admin/billing-usage/subscriptions`）的表述是：经由非 Mistral 产品（第三方 coding tool / harness）的用量计入 API 月度用量。**[文档·待复核]**

**结论：** Plan1 的 DoD #1 要求"客户端伪装成官方产品、把用量记到 `$300`"，这在方向上就是与官方口径对冲。除非 12/1 后的实验推翻官方口径，否则该 DoD 不可达。把它写成验收标准，等于让开发 Agent 去撞一堵已经写明"此路不通"的墙。

### 2.3 致命三：Magpie 插件不是 DSH 插件

**Plan1 的主张（§2、§3.1、§3.2）：** 插件需要"清单文件（Manifest）字段定义""插件进程启动、端口/IPC 通信协议与配置注入方式"，并自建 `/v1/models`、`/v1/chat/completions`。

**Magpie 的真实契约：**

- 一个 provider 包是一个目录，含 `package.json` + `index.mjs`；`index.mjs` 导出**一个 async 插件函数**，返回 `auth` / `config` / `provider` / `chat.headers` 等 hook（`plugins/README.md:369-398`）。
- 没有 manifest schema，没有插件进程，没有端口，没有 IPC。`package.json` 的 `magpie` 字段只是名称/图标/摘要/并发上限等元数据；配置以 `plugins.json` 的 `options` 自由对象传入（例：`MistralVibe2API/index.mjs:40-53` 与 `package.json:30-38`）。
- 网关本身已经提供 `/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages` 与协议转换；插件只需要把"模型"接进来。
- 多账号、路由策略（`smart/order/rotate/usage/pace/weight/manual`）、`stays=session`、以及 401/402/403/429 的 "rest" 语义都是 Magpie 原生能力（`plugins/README.md:97-114,177`；`skills/magpie-setup/SKILL.md:110-124`）。

**后果：**

- Plan1 §3.1 的 "Manifest Schema" 找不到落地位置；正确做法是 `auth.methods` + `plugins.json.options`。
- Plan1 §3.2 的"插件自建 `/v1/models`"是重复建设；正确做法是 `config.provider[id].models` 与 `provider.models()`（`magpie-mistral-code/index.mjs:470-478,630-639`；`MistralVibe2API/index.mjs:121-129,264-297`）。
- Plan1 §3.3 的"请求转换中间件"在 provider 插件里没有这个层；它是网关的 middleware 包类型（`<name>.middleware.js` 的 `onRequest/onEvent/onResponse`），而且与 provider 插件是两个不同的包。
- Plan1 §3.4 的 `KeyPoolManager` 是把 Magpie 已经做好的号池调度又写了一遍，并且会因为拿不到 Magpie 的 seat/额度信息而做得更差。
- Plan1 §4 阶段一让开发 Agent "确定插件使用的开发语言（Go / Node.js / Python）"——这个选择不存在。provider 插件是 JS/TS（运行在 Magpie host），middleware 是单文件 JS（运行在 moejs 且不能 import）。没有 Go/Python 插件形态。

### 2.4 致命四：`prompt_cache_key` 是凭空发明的字段

**Plan1 / Plan1.1 的主张：** 透传或生成 `prompt_cache_key` 作为会话指纹，配合 `sticky_ttl=300s` 保证前缀缓存。

**源码事实：**

- 官方 `mistral-vibe` 全仓库 `prompt_cache_key` **0 命中**。
- dsh 全仓库 `prompt_cache_key` **0 命中**。它的会话亲和来自 `x-dsh-session` / `x-session-id` / `x-conversation-id` / `x-affinity`，否则取前两条消息做 SHA-1（`lib/index.js:721-757`）。
- 官方 Vibe 的传输层用 `x-affinity`（`_runtime_config.py:577-587`），也不是 `prompt_cache_key`。
- Magpie 给插件的稳定会话标识是 `chat.headers` 的 `input.sessionID`（`zen-free/provider.mjs:861-867`），粘性由 `stays=session` 承担。

**结论：** 插件往上游写一个 Mistral 不读的字段，既不会提升缓存命中，也不会改变计费归属。真正该做的是：用 `chat.headers` 把 Magpie 的 `sessionID` 变成 `x-affinity`/`x-session-id`，然后让 Magpie 的 `stays=session` 固定账号。`sticky_ttl=300s` 也与 dsh 的真实行为不符（dsh 是 LRU cap，不是 300 秒 TTL）。

> 另外一个常被误解的点：前缀缓存是**服务端自动**的，块大小与存活时间不是公开契约。DoD 里写"命中率 ≥90%"是拿一个不可控的服务端行为当验收门槛，应改为"同会话落在同一 key，且 `cached_tokens` 有增长"。

### 2.5 致命五：模型 ID 与"模型面（surface）"错误

Plan1 §3.2 的白名单与真实 Vibe surface 不一致：

| Plan1 写的 | 实际 canonical ID / 说明 |
| --- | --- |
| `glm-5-3` / `glm-5-3-flash` | `zai-glm-5-3` / `zai-glm-5-3-flash` |
| `mistral-large-4` / `mistral-large-latest` | `mistral-large-4-0`；别名需以 live catalog 为准 |
| `mistral-medium-3.5` | 显示名/别名，canonical 是 `mistral-medium-latest` |
| `mistral-vibe-cli-fast` | 存在，alias 于 Medium 3.5 的快速 utility 模型 |
| 未提 | `mistral-vibe-cli-latest`、`mistral-vibe-cli-with-tools`、`zai-glm-5-3-flash-vibe-free` |

依据：`MistralVibe2API/src/core.mjs:140-217`（静态目录，注明按 live `/v1/models` 与 `/v1/model-catalog?surface=vibe-code` 校准）、`MistralVibe2API/README.md:63-90`。

更重要的是**不能把 `/v1/models` 全量当 Vibe 白名单**。`MistralVibe2API/src/core.mjs:146-149` 明确写：`codestral`、`ministral`、`pixtral` 等不在 Vibe surface 上，走了就会计 API 池。`magpie-mistral-code/index.mjs:294-350` 恰恰是全量暴露 `/v1/models`，没有 surface 过滤——这是它可被复用时必须补的洞。

---

## 3. Plan1.1 的根因诊断逐条核对

### 3.1 总表

| Plan1.1 的断点 | 官方源码事实 | 判定 |
| --- | --- | --- |
| 必须是 `whoami` + `managed-config` 前置握手，否则被降级 | 两者都 fail-open，失败不阻塞；主推理路径不经过它们 | ❌ 错 |
| 必须发 `speakeasy-sdk/python 3.5.0 2.935.1 1.0.0 mistralai` | 真实 UA 是 `mistral-client-python/Mistral-Vibe/3.1.5`；仓库里 `speakeasy` 0 命中 | ❌ 错 |
| 现有插件失败只因缺少上述"指纹" | 它自己引用的项目实测三种 UA 组合全部 200；归属由 key 类型决定 | ❌ 自相矛盾 |
| 模型/参数需要按 Vibe 3.1.5 白名单规范化 | 方向对，但 ID 写错，且模型面比模型名更关键 | ⚠️ 部分对 |
| 号池/长连接/首字前重试是真实痛点 | 真实痛点，但归属是 Magpie + 传输层，不是"伪装插件" | ✅ 对 |

### 3.2 `whoami` 不是准入门

- `vibe/setup/auth/whoami.py:153-170`：`fetch_whoami()` 的文档字符串写明"without raising — returns None on any failure"，失败只 `logger.info` 后返回 `None`。
- `:418-468`：`resolve_tenant_domains()` 只用它发现租户的 `api_base` / `vibe_base`；失败时原样返回输入。
- `MistralVibe2API` 用它判断 key 类型（`src/core.mjs:313-347`），这是**计费归属识别**，不是**推理准入**。Plan1.1 把"识别"误读成"握手准入"。

### 3.3 `managed-config` 也不是准入门

- `vibe/core/config/admin_config.py:79-110`：失败时"the caller keeps what the admin layer already holds ... a fetch problem never stops the client"。
- `vibe/app_server/_org_config_service.py:168-185`：拿不到就返回 `FETCH_FAILED` / `timed out`，调用方继续。
- 它的用途是组织/工作区强制配置（模型白名单、工具策略等），不是每次请求的认证。

### 3.4 真实 UA 链路

1. `vibe/utils/http.py:291-296`：`get_user_agent(backend)`；
   - backend 为 `mistral` 时：`mistral-client-python/Mistral-Vibe/3.1.5`；
   - 其他：`Mistral-Vibe/3.1.5`。
2. `:299-304`：`with_user_agent()` 只在调用方没有 UA 时添加。
3. `app_server/_runtime.py:640`、`app_server/_completion_facts.py:77`：把结果写入 provider 的 `extra_headers`。
4. `_runtime_config.py:577-587`：`request_headers()` 返回 `extra_headers`（含 UA）+ `x-affinity`。
5. `adapters/mistral.py:168-169`：作为 `http_headers` 交给 SDK。
6. 凭证头只有 `Authorization: Bearer`（`_credentials.py:95-111`）。

关于 SDK 层：按 `mistralai` Python v3.5.0 的 `CustomUserAgentHook` 公开实现，UA 若已以 `mistral-client-python/` 开头则原样保留，否则改写成 `mistral-client-python/<SDK 版本>`（**[文档·待复核]**，本机未安装该 SDK 源码）。

但结论不依赖这个细节，两种情况都指向同一结果：

- 若 hook 保留显式 UA → 上游看到 `mistral-client-python/Mistral-Vibe/3.1.5`；
- 若 hook 覆盖显式 UA → 上游看到 `mistral-client-python/3.5.0`。

**两种都不会是** `speakeasy-sdk/python 3.5.0 2.935.1 1.0.0 mistralai`。Plan1.1 若把这个 Speakeasy 串设成默认 UA，反而是从"官方客户端 UA"退化成"SDK 默认 UA"，保真度更低。

### 3.5 "UA 决定计费归属"被它自己引用的项目否定

`MistralVibe2API/README.md` 的三段实测：

- `:110-116`：Vibe key（付费）→ `plan_type=CHAT` → Vibe 池；Vibe key（免费）→ 仅 `*-vibe-free` → Vibe 池；API key → `plan_type=API` → API 池。
- `:118-123`：拿 **API key** 穿"完整 Vibe CLI 指纹"发 3 个请求 → Vibe 池 `$0` 变化，API 池 `+$0.0073`。
- `:127`：真 Vibe key 下，Vibe UA / Claude UA / 无 UA 三种组合**都 200**，限流头一致（1M tokens/min、2000 req/min，跟着 key 走）。

这三条合起来就是一句话：**在它测过的 Vibe key 与 API key 上，功能上 UA 不设门槛，计费上 UA 不决定归属。** Plan1.1 却把 UA 当成总开关，与自己的证据链相反。

### 3.6 `x-api-key` 与计费接口

Plan1.1 说"通过 `x-api-key` 请求 `GET /v1/billing/budget`"。两个参考项目都不是这么做的：

- `magpie-mistral-code/index.mjs:356-366`：`Authorization: Bearer <key>` 请求 `/billing/subscription`、`/billing/budget`、`whoami`。
- `MistralVibe2API/src/core.mjs:382-392`：`sanitizeHeaders(null, { apiKey })` 生成 Bearer，再请求同样两个端点。

另外 `/budget` 需要 `see_org_inference_usage` 权限，成员拿不到时 403 是正常的，要降级而不是报错（`MistralVibe2API/src/core.mjs:378-380`；`test/live.test.mjs:279-283`）。

### 3.7 超时参数与官方实现相反

Plan1.1 建议 `ResponseHeaderTimeout: 60s` 来"防 RST"。官方 Vibe 的默认值是：

- 首字等待：`DEFAULT_API_TIMEOUT = 720.0` / `FIRST_OUTPUT_WAIT_SECONDS = 720.0`（`vibe/core/config/_defaults.py:20`；`completion_profile/stream_guard.py:18`）；
- 流空闲：`DEFAULT_API_STREAM_IDLE_TIMEOUT = 300.0` / `STREAM_IDLE_SECONDS = 300.0`（`_defaults.py:24`；`stream_guard.py:19`）；
- TCP keepalive：idle 30s、interval 10s、3 probes（`_http_transport.py:63-78`）。

顺带修正 Plan1 §4 阶段二的"禁用 HTTP/2 多路复用"：Node/undici 的 `fetch` 默认就是 HTTP/1.1，不显式开 `allowH2` 不会走 HTTP/2。这条建议大概率是空操作；真正需要调的是首字/空闲超时与 TCP keepalive。

用 60s 的头超时会**先杀掉**深度思考的长请求，制造 Plan1 想解决的"首字前断流"。正确做法是分阶段超时：首字 720s、空闲 300s，并开启 TCP keepalive，而不是一刀切 60s。

### 3.8 复用分工错位

Plan1.1 说"复用 `MistralVibe2API` 的 OpenAI 请求体到 Mistral 格式的双向转换，并补齐 `thinking` 规范化"。事实是：

- `MistralVibe2API` 的 OpenAI 路径几乎是**字节透传**：只做 `body.model = mapModel(...)`，然后原样 `JSON.stringify` 发上游（`src/server.mjs:210-223`）。它真正有转换的是 Anthropic `/v1/messages`（`src/anthropic.mjs`）。
- `thinking` 规范化不在 `MistralVibe2API`，而在 **`magpie-mistral-code/index.mjs:398-462`**：把 `reasoning_content` / `reasoning` / `reasoning_details` 转成 Mistral 接受的 `{type:"thinking", thinking:[{type:"text", text}]}`，并删除 Mistral 会以 422 `extra_forbidden` 拒掉的字段。

所以复用清单应该互换：**thinking/消息整形取 `magpie-mistral-code`，头清洗/目录/SSE usage 取 `MistralVibe2API`。**

### 3.9 Plan1.1 与 Plan1 的关系

Plan1.1 不是 Plan1 的修正版，而是**同一个错误前提的加强版**：

- Plan1 说"dsh 有指纹，搬过来"；
- Plan1.1 说"dsh 的指纹也不够，要补 `whoami` + `managed-config` + Speakeasy UA"。

两者都假设"客户端特征决定计费归属"。而现有证据（官方源码 + 它自己引用的实测）指向"key 类型决定归属"。这是必须在写代码前推翻或证实的**唯一核心假设**。

---

## 4. 三个参考项目的真实定位

### 4.1 `dsh-mistral-pool`：ACP 才是资产，直连是反面教材

| 部分 | 能否复用 | 说明 |
| --- | --- | --- |
| `lib/acp-runtime.js`（约 80KB） | ✅ 核心资产 | `vibe-acp` 子进程、stdio JSON-RPC、每会话隔离 `VIBE_HOME`、进程池/回收、首输出前故障轮换 |
| `lib/mcp-bridge.js`、`lib/jsonrpc.js` | ✅ | 回环 Streamable-HTTP MCP 桥、JSON-RPC peer |
| `affinityOf()` / `selectKey()` | ✅ 语义可借鉴 | 会话亲和 + priority/weight，但 Magpie 有原生等价物 |
| 直连 `forwardableHeaders()` | ❌ | 透明代理，没有任何 Vibe 指纹 |
| 直连的 `directKeyScope` | ❌（对 Plan1 而言） | 它是"cutoff 后只用 Studio key"的合规开关，不是要移植的漏洞 |

`README.md:61-73` 明确写了 ACP 机制：`enabled_tools` 禁用 Vibe 内置工具，所有工具调用经 `run_typescript` 转发到 MCP 桥；长工具用 `[DSH_RELAY]` 中继；空闲 8 分钟回收；首输出前 401/402/403 自动换 key。

### 4.2 `magpie-mistral-code`：已经是合格的 Magpie provider

- 形状正确：`config`（`index.mjs:470-478`）、`auth.usage`（`:481-489`）、`auth.loader`（`:491-511`，自定义 `fetch` 逐请求签名）、`auth.methods`（OAuth PKCE，`:513+`）、`provider.models`（`:630-639`）。
- 已有能力：浏览器 PKCE 登录、手动 key、`/v1/models` 动态目录、`/billing/*` 双池展示、thinking 整形。
- 缺口：① 不区分 `plan_type`，可能把 API-surface 模型暴露给 Vibe key；② `/v1/models` 全量暴露，未按 `surface=vibe-code` 过滤；③ 单账号心智（多账号交给 Magpie 即可）；④ UA 默认值仍是 `3.1.3`（已有 `MISTRAL_VIBE_UA` 覆盖开关，但默认值落后于 Vibe `3.1.5`）。

### 4.3 `MistralVibe2API`：头清洗与目录最完整，但不是"转换内核"

- 头白名单严格：只放行 `content-type` / `accept`，其余（含 `user-agent`、`x-stainless-*`、`origin`、`cookie`、`anthropic-*`）全部丢弃，再注入自己的 UA（`src/core.mjs:33-117`）。
- 目录扎实：静态 Vibe surface + live `model-catalog?surface=vibe-code` 合并（`src/core.mjs:140-217`；`index.mjs:264-297`）。
- key 类型识别与双池 usage：`src/core.mjs:313-347,357-401`；`index.mjs:208-262`。
- 不是"OpenAI→Mistral 双向转换"：OpenAI 路径是透传；只有 Anthropic 有转换层。
- 它的 UA 选择（Speakeasy 串）是一个**未经验证的假设**，而且与它自己的实测结论冲突；复用时应改成官方真实 UA 或干脆不设。

### 4.4 `plugins`：契约 + ACP 先例

最重要的发现不是 `zen-free`，而是 **`packages/agy-cli`**：

- 它是一个 **ACP provider 插件**：客户端 Anthropic Messages → ACP → 本机 `agy acp` 进程 → 流式译回（`README.md:11-20`）。
- 它有**进程池、会话 resume、MCP 工具桥**（`README.md:30-56`）。
- 它证明：Magpie provider 插件可以驱动外部 CLI/ACP，不需要改 Magpie 网关。

这意味着 **A 路线（`vibe-acp`）在 Magpie 里是可行的**，但工程量参照 `agy-cli`：`index.mjs` 约 472KB，外加 20+ 模块与大量测试。这不是"一个下午的插件"。

---

## 5. 正确的架构选项

### 5.1 A：ACP（`vibe-acp`）——目前唯一已知可能合规消耗 `$300` 的路线

**做法：** 参照 `agy-cli`，写一个 Magpie provider 插件：

- `auth.methods` 提供 OAuth PKCE / 手动 Vibe key；
- `provider.models` 返回 `vibe-acp` 实际开放的模型；
- 插件内部 spawn `vibe-acp`，stdio JSON-RPC 驱动会话；
- 客户端工具通过 MCP 桥暴露给 Vibe（`enabled_tools` 只放桥接工具）；
- 会话键用 Magpie 的 `input.sessionID`，同会话复用 ACP session，支持 `session/resume`；
- 首输出前 401/402/403 换 key 重放；
- usage 从 ACP 的 `usage_update` / `PromptResponse.usage` 结算。

**优点：** 计费归属最接近官方；不依赖任何伪装。
**缺点：** 工作量 XL；依赖用户安装 `vibe-acp`；ACP 协议与 Vibe 版本耦合；工具所有权/权限模型需要重新设计（dsh 是"DSH 拥有工具"，Magpie 是"客户端拥有工具"，两者语义不同）。
**前置验证：** `vibe-acp` 是否真的被 Mistral 认定为"官方产品"路径——这同样要在 12/1 后用 `vibe_budget` 对照实验确认，不能只信 dsh README。

### 5.2 B：诚实直连 provider——默认推荐

**做法：** 基于 `magpie-mistral-code` 改造：

- `config.provider['mistral-vibe'] = { npm: '@ai-sdk/openai-compatible', api: 'https://api.mistral.ai/v1', models }`；
- `auth.methods` 保留 OAuth PKCE + 手动 key；
- `auth.loader` 返回的自定义 `fetch` 里用 `sanitizeHeaders` 清洗下游头（复用 `MistralVibe2API/src/core.mjs:84-117`），但**不伪装** UA；
- `provider.models` 用 `/v1/model-catalog?surface=vibe-code`，失败退 `/v1/models`，并按 key 类型过滤；
- `auth.usage` 读 `/billing/subscription` + `/billing/budget`，双池展示；
- `chat.headers` 写 `x-affinity`/`x-session-id`，粘性交给 Magpie `stays=session`；
- 多账号、401/402/429 的 rest 与路由回退全部交给 Magpie。

**优点：** 工作量 S/M；诚实、可维护；不碰合规红线；立刻可用（前提是 `$30` 有额度）。
**缺点：** 12/1 后计入 `$30`；如果 `$30` 已耗尽，仍然 402。

### 5.3 C：头部伪装——只做实验，不做产品

如果仍想验证"指纹是否有用"，把它限定为 Phase 0 的一次性实验：

- 同一 key、同一模型、同一 prompt、同一时间窗；
- 三组：`vibe-acp` 真实调用 / 直连 + 官方 Vibe UA / 直连无 UA；
- 每组前后读 `/billing/budget`，比较 `vibe_budget` 与 `api_budget` 的增量；
- 记录 `whoami.plan_type`、HTTP 状态、限流头。

**预期：** 直连两组都进 `api_budget`（依据官方口径与 dsh 设计）。若结果相反，再谈 C 是否有产品价值。
**风险：** 违反 Mistral 使用条款/账号风控；即使技术上 200，也不代表可持续。

### 5.4 推荐组合：双 provider + 路由组

这不是二选一。最稳的落地是注册两个 provider：

| provider id | 路径 | 计费 | 用途 |
| --- | --- | --- | --- |
| `mistral-vibe` | ACP（`vibe-acp`） | `$300`（待验证） | 主力，优先 |
| `mistral-vibe-api` | 直连 Chat Completions | `$30` | 兜底/低成本任务 |

再用 Magpie routing group（`routing=order` + `stays=session`）让请求优先走 ACP，ACP 不可用时降级到直连。这样既不需要伪装，也不会在 `$30` 耗尽时整组不可用。

**零代码选项：** 如果只是你一个人用，`uv tool install mistral-vibe` 后直接使用官方 `vibe` CLI 就是成本最低、计费最确定的方案；ACP 插件只在"必须让 Claude Code / OpenCode 等第三方 Agent 共用这个额度"时才有必要。

---

## 6. 修正后的实施计划

### Phase 0：决策实验（不写产品代码）

| 编号 | 任务 | 产出 | 退出条件 |
| --- | --- | --- | --- |
| P0-1 | 12/1 后做 A/B/C 三组计费对照 | 一张"请求前后 `vibe_budget`/`api_budget` 增量"表 | 能明确回答"直连扣哪个池" |
| P0-2 | 确认 `$300` 是否硬指标、`$30` 是否可充值 | 一句产品决策 | 选定 A 或 B |
| P0-3 | 确认目标 Magpie 版本是否支持：多账号 per provider、`stays`、routing group、`chat.headers`、`plugins.json.options` | 版本清单 | 所有依赖有明确版本号 |
| P0-4 | 用真实 key 跑通两个参考项目的现状（各发 1 条请求，记录 402/200 与池增量） | 基线日志 | 知道"现在到底卡在哪" |

**Phase 0 的纪律：** 在 P0-1 出结果前，不写任何"指纹注入""握手模拟""KeyPoolManager"代码。

### Phase 1：B 路线 MVP

1. fork `magpie-mistral-code`，改名 `magpie-mistral-pool`；
2. 补 key 类型识别（复用 `MistralVibe2API/identifyKey`），按类型过滤模型面；
3. 把 `/v1/models` 换成 `model-catalog?surface=vibe-code` 优先；
4. 移植头清洗逻辑：保留"只放行 `content-type`/`accept`"的白名单，但去掉其中强制写 `user-agent` 的分支（不伪造 UA）；保留 `mistralBody` 的 thinking 整形；
5. `auth.usage` 同时展示 `vibe_budget` 与 `api_budget`，403 降级；
6. `chat.headers` 写 `x-affinity`，文档写明 `stays=session` 的配置方法；
7. 测试：`chat.headers` 的 provider 隔离、模型面过滤、thinking 422 回归、budget 403 降级。

**验收：** 用 Vibe key 发一条 `deepseek-v4-1-flash-1017`，200；`usage` 卡片两个池都有数；12/1 后 `api_budget` 增长（符合预期）。

### Phase 2：A 路线（仅当 `$300` 是硬指标）

1. 移植 `acp-runtime.js` + `jsonrpc.js` + `mcp-bridge.js` 到插件目录；
2. 设计"客户端工具 → ACP"的桥：Magpie 的工具调用如何映射为 ACP 的 `tool_call`/`tool_result`（参照 `agy-cli` 的 `mcp-server.mjs` 与 `tool-schema.mjs`）；
3. 会话键 = `input.sessionID`；实现 `session/resume` 与 park/miss 日志；
4. 每账号独立 `VIBE_HOME`；进程池与内存回收；
5. 首输出前故障换 key；usage 结算；
6. 测试：并发会话、resume、工具桥、402 轮换、长上下文首字。

**验收：** `vibe-acp` 路径下 200，且 12/1 后 `vibe_budget` 有增量（这才是 DoD #1 的正确写法）。

### Phase 3：组合与运维

1. 双 provider + routing group；
2. 文档：安装 `vibe-acp`、登录、池选择、故障排查；
3. 观测：每 key 的 `vibe_budget`/`api_budget`、cache hit、TTFT、断流率；
4. 升级策略：`vibe-acp` / SDK 版本变化时的兼容矩阵。

---

## 7. 重写后的验收标准

把 Plan1 §5 的五条改成可证伪的表述：

1. **计费归属（替换 DoD #1）**：在 2026-12-01 后，对同一 key/模型/prompt，记录请求前后 `vibe_budget` 与 `api_budget` 的 `usage_percentage` 变化；断言"所选路线只让目标池增长"。**不再写"必须让 `$300` 增长"**，而是写"实际增长与路线声明一致"。
2. **会话粘性（替换"缓存 90%"）**：同一 `sessionID` 的连续 3 轮请求落在同一 key（Magpie 日志/`/v1/magpie/route` 可查），且第 2 轮 `usage.prompt_tokens_details.cached_tokens > 0`。不承诺具体百分比。
3. **号池容错**：池中混入 1 个 401 key + 1 个 402 key + 1 个健康 key，请求成功；日志显示跳过原因与耗时。
4. **流式稳定**：`reasoning=high`、首字 > 10s、总时长 > 5min 的请求完整结束；超时参数符合官方基线（首字 720s、空闲 300s），不是 60s。
5. **协议正确性**：`thinking` 历史消息不再触发 422；`/v1/models` 只暴露当前 key 可计费 surface 的模型。
6. **合规**：插件不伪造 `User-Agent`、不模拟官方握手、不写入上游不读的字段；文档明确写出计费归属与账号风险。

---

## 8. 风险与待决策

### 8.1 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 12/1 后直连计费归属未知 | 可能整个 B 路线不满足 `$300` 目标 | Phase 0 实验 |
| 伪装 UA 违反 ToS / 触发风控 | 账号封禁 | 不产品化；实验也需评估 |
| `vibe-acp` 协议随版本变化 | A 路线维护成本高 | 版本探测 + 兼容矩阵 |
| 前缀缓存不可控 | "90% 命中"无法保证 | 改为可观测指标 |
| Magpie 版本能力差异 | `stays`/多账号/`chat.headers` 不可用 | P0-3 版本清单 |
| 60s 头超时 | 杀掉长思考请求 | 改用官方 720s/300s 基线 |

### 8.2 需要你拍板的三件事

1. **`$300` 是硬指标，还是"能跑就行"？** 这决定 A 还是 B。
2. **能否接受"用户本机安装 `vibe-acp`"这一前置条件？** 不能接受的话，A 直接出局。
3. **是否接受 12/1 后再做实验？** 如果现在就要交付，只能先做 B 的 MVP，并在文档里写明计费归属待验证。

---

## 附录 A：关键证据索引

| 结论 | 证据 |
| --- | --- |
| dsh 直连是透明代理、无 UA 注入 | `dsh-mistral-pool/lib/index.js:1574-1597,2042-2051` |
| dsh 全仓库无 `speakeasy`/`user-agent`/`prompt_cache_key` | `rg -i` 0 命中（本机复核） |
| dsh 12/1 后直连只用 Studio key | `lib/index.js:155-156,548-562`；`README.md:7` |
| dsh 直连走 `/responses` | `lib/direct-stream.js:235-250` |
| dsh 亲和键不是 `prompt_cache_key` | `lib/index.js:721-757` |
| 官方 UA 是 `Mistral-Vibe/3.1.5` | `vibe/utils/http.py:291-304`；`tests/utils/test_http.py:35-53` |
| UA 由 `extra_headers` 传给 SDK | `_runtime_config.py:577-587`；`adapters/mistral.py:168-169`；`_credentials.py:95-111` |
| `whoami` fail-open | `vibe/setup/auth/whoami.py:153-170,418-468` |
| `managed-config` fail-open | `vibe/core/config/admin_config.py:79-110`；`_org_config_service.py:168-185` |
| 官方超时基线 720s/300s | `vibe/core/config/_defaults.py:20-24`；`completion_profile/stream_guard.py:18-19`；`_http_transport.py:63-78` |
| Magpie provider 插件形状 | `plugins/README.md:369-398` |
| Magpie 原生路由/Stays | `plugins/README.md:97-114`；`skills/magpie-setup/SKILL.md:110-124` |
| `chat.headers` 给 `sessionID` | `plugins/packages/zen-free/provider.mjs:861-867` |
| ACP provider 先例 | `plugins/packages/agy-cli/package.json`；`README.md:11-20,30-56` |
| magpie-mistral-code 的 thinking 整形 | `magpie-mistral-code/index.mjs:398-462` |
| magpie-mistral-code 全量暴露 `/v1/models` | `index.mjs:294-350` |
| MistralVibe2API 头白名单 | `MistralVibe2API/src/core.mjs:33-117` |
| MistralVibe2API 目录与双池 | `src/core.mjs:140-217,313-347,357-401` |
| MistralVibe2API 是透传而非转换 | `src/server.mjs:210-223` |
| "UA 不影响归属"的实测 | `MistralVibe2API/README.md:108-131` |
| live test 未断言池增量 | `MistralVibe2API/test/live.test.mjs:272-303` |

## 附录 B：两份文档的逐段处置

| 文档位置 | 处置 |
| --- | --- |
| Plan1 §2 表格"需提取的关键信息 #1/#2" | 删除。dsh 没有 Header 字典，也没有 Vibe 白名单 |
| Plan1 §3.1 Manifest Schema | 改为 `auth.methods` + `plugins.json.options` |
| Plan1 §3.2 自建 `/v1/models` | 删除；用 `config.provider.models` + `provider.models()` |
| Plan1 §3.3 请求改写/指纹注入 | 删除；只保留"头清洗"（去第三方身份），不伪造 UA |
| Plan1 §3.3 `prompt_cache_key` | 删除；改 `chat.headers` + `stays=session` |
| Plan1 §3.4 `KeyPoolManager` | 删除；交给 Magpie 多账号/路由 |
| Plan1 §3.4 `sticky_ttl=300` | 删除；无官方依据 |
| Plan1 §3.5 SSE/usage | 保留，正确 |
| Plan1 §5 DoD #1 | 改写为"计费归属与路线声明一致" |
| Plan1 §5 DoD #2 90% 命中 | 改写为"同 key + cached_tokens 增长" |
| Plan1.1 §1 四个断点表 | 保留第 4 行（传输痛点），前三行按本文 §3 重写 |
| Plan1.1 §3.1 `custom_user_agent` 默认 Speakeasy | 删除；默认应为 `mistral-client-python/Mistral-Vibe/3.1.5` |
| Plan1.1 §3.2 前置握手 | 删除 |
| Plan1.1 §3.2 `x-api-key` | 改 `Authorization: Bearer` |
| Plan1.1 §3.2 60s 头超时 | 改 720s 首字 / 300s 空闲 |
| Plan1.1 §4 阶段二"复用转换层" | 改为"复用头清洗 + 目录；thinking 从 magpie-mistral-code 取" |

