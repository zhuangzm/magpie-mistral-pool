# magpie-mistral-pool 开发状态（供第三方审核）

- 日期：2026-11-27（Asia/Shanghai）
- 仓库：`D:\workspaceAI\magpie-mistral-pool`
- 当前 HEAD：`9373f61 fix: tighten transport, acp lifecycle, and billing failure handling`
- 测试：`npm test` → **61 / 61 通过**（0 失败 / 0 跳过，约 6.3s）
- 阶段结论：路线 B（诚实直连，`engine: direct`）与路线 A 的最小实现（`engine: acp` → `vibe-acp` 子进程）**双引擎均已落地**，ACP 实测已在本机 Magpie 内稳定消耗 `$300` Vibe 池；12 月 1 日账期重置前**冻结功能范围**，只做实验数据采集。

---

## 1. 提交链与回退路径

| 提交 | 内容 | 说明 |
| --- | --- | --- |
| `faac0d6` | 路线 B 诚实直连 provider | 基座：`identifyKey`、`surface=vibe-code` 模型过滤、`thinking` 整形 |
| `34d73bf` | Bun 宿主下复用宿主 `fetch` | 修复 Magpie 插件宿主（Bun）里 undici `ProxyAgent` 不可用 |
| `9b97d8e` | ACP 引擎走 `$300` Vibe 池 | `vibe-acp` 子进程池 + ACP→OpenAI 形状转换 |
| `6a8b1f2` | 派生第二个 `providerId` | 同 spec 双 entry 静态加载的隔离基础 |
| `9373f61` | 传输层 / ACP 生命周期 / 计费失败分类收口 | 14 文件 +293/−38，即本次提交批次 |

回退口径：
- 只回退最新修复：`git revert 9373f61`
- 回到 ACP 刚打通那版：`git revert 6a8b1f2`
- 完全不启用 ACP：`git revert 9b97d8e 6a8b1f2`
- 宿主配置回滚：`D:\Program Files\magpie\data\plugins.json.bak-20261127`

---

## 2. 双引擎架构落点

`index.mjs:319` 的 `server(input, options)` 按 `options.engine` 二选一：

- `index.mjs:322` — `const engine = options.engine === 'acp' ? 'acp' : 'direct'`，默认 `direct`（未知值一律回落，不静默升权）。
- `index.mjs:326` — `providerId = options.providerId || PROVIDER`，`PROVIDER` 见 `src/core.mjs:8`（`mistral-vibe`）。
- `index.mjs:593-600` — `engine === 'acp'` 时用 `createAcpFetch({ bridge: acpFor(key), fallback: directFetch })`，即 **ACP 失败可回落直连**，不会硬失败。
- `index.mjs:601-607` — `direct` 时用 `createPluginFetch`，每请求重签 key。
- `index.mjs:612` — provider 声明 `id: providerId`（宿主按 `ownKey(spec, id)` 隔离凭证 / 配置 / 用量）。
- `index.mjs:621-627` — `chat.headers` 仅对 `[providerId, providerId + '-plugin']` 写 `x-affinity` / `x-session-id`，用于下游 `stays=session` 粘性。
- `index.mjs:424-428` — 面板显示名：`Mistral Vibe (ACP · $300)` / `Mistral Vibe (API)`，支持 `options.providerName` 覆盖。

ACP 侧：
- `src/acp/runtime.mjs:259` `class AcpBridge`，`:1004` `createAcpBridge`，`:41` `DEFAULT_MAX_SESSIONS = 4`（单桥并发会话）。
- `src/acp/runtime.mjs:506` 仅协商 `protocolVersion: 1`。
- `src/acp/config.mjs:242` `killTree`：Windows 走 `taskkill.exe /PID … /T`（`:246`），2s 后 `SIGKILL` 兜底。
- `src/acp/openai.mjs`：ACP 事件流 → OpenAI 形状（含 `reasoning` / tool call 合成）。

多桥池：`index.mjs:391-415`
- `maxBridges` 默认 4（`index.mjs:391`），限制的是 **按 API key 区分的 `AcpBridge` 实例数**。
- 淘汰前用 `isBridgeBusy`（`index.mjs:392`）过滤：**有在途请求或停泊工具调用的桥不淘汰**，只回收空闲桥；淘汰到 `maxBridges` 以下即止（`index.mjs:409`）。

---

## 3. 传输层（长思考不中断的关键）

`src/transport.mjs:70-115` `createTransport`：

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `firstOutputMs` | `720_000`（720s） | 请求开始到响应头的首字节预算（`src/transport.mjs:72`） |
| `idleMs` | `300_000`（300s） | 流式两个 chunk 之间的空闲预算（`:73`） |
| `keepAliveInitialDelayMs` | `30_000` | TCP keepalive 首探延迟（`:74`） |
| `maxRetriesBeforeFirstByte` | `0` | 默认**不重试**（`:75`） |
| `headersTimeout` / `bodyTimeout` | `0` / `0` | 关掉 undici 自带 300s 内部超时，交权给上面的看门狗（`:109-110`） |
| `keepAliveTimeout` | `60_000` | 连接复用（`:108`） |

代理与宿主：
- `src/transport.mjs:44-48` — 自读 `NODE_USE_ENV_PROXY`（Node 原生 fetch 读、npm undici 构建不读），也可用 `proxyUrl` 显式指定。
- `src/transport.mjs:82-98` 与 `:124` — Bun 宿主（Magpie 插件运行时）下直接用 `globalThis.fetch` + 上述两层看门狗，不起 undici dispatcher。
- 重试边界：`src/transport.mjs:144` — 仅 `TRANSPORT_RESET` / `TRANSPORT_NETWORK`、**响应头前**、请求体非 `ReadableStream`、signal 未中止时才可能重试；默认 `maxRetriesBeforeFirstByte = 0` 意味着**不会重复扣费**。
- 预中止：`fetchImpl` 调用前直接拒绝已 abort 的 caller signal（回归测试 `a pre-aborted caller signal rejects before calling fetchImpl`）。

控制面 URL：
- `src/core.mjs:28-29`、`:46-49` — `whoamiUrlOf` 取 **origin** 再拼 `/api/vibe/whoami`，从根上避免 `/v1/api/vibe/whoami` 404。
- `src/core.mjs:376` `identifyKey`，whoami 走轻量重试（`index.mjs:373-374` `whoamiRetryMs`，默认 15s TTL），非 2xx 时 `cancel()` 响应体。

---

## 4. 计费：双池读取与展示

- `src/billing.mjs:77` `fetchBilling(key, options)` 读 `/billing/subscription` 与 `/billing/budget`。
- `src/billing.mjs:45` `budgetToWindows(budget, counting)`：主池正常展示，另一池标 `aside: true`（`:66`）；无 `limit` 时显示百分比，不再除零。
- `src/billing.mjs:112` `usageFromBilling`：401 / 不可达 / 5xx+0 的**混合失败**分别归类，不再一律报「读取失败」。

实测证据（本机，2026-11-27）：

| 项 | 数值 |
| --- | --- |
| `Vibe ($300)` 池 | `0.764389 → 0.801182 → 1.44 / 300 USD`（面板「已用 0.5%」，重置 12/1 08:00） |
| `API ($30)` 池 | `30 / 30 USD · 已用 100%`，ACP 通道未触发 402 |
| ACP 冒烟 | 9 个 surface 模型全部 HTTP 200，SSE 流式正常 |
| `direct` 引擎 | 在 `$30` 耗尽下返 `402 · API budget exhausted`（**预期行为**，非缺陷） |

面板上「9 个模型中有 9 个没有响应；mistral-large-4-0：402 · API budget exhausted」来自 `direct` provider（`mistral-vibe-api` 或旧内置 `mistral`），与 ACP 通道无关。

---

## 5. 宿主加载实况

- `D:\Program Files\magpie\data\plugins.json` 末尾两条同 spec entry：
  - `engine=acp`，`proxyUrl=http://127.0.0.1:7890`
  - `engine=direct`，`providerId=mistral-vibe-api`，`includeApiSurface=false`，同 proxyUrl
- `plugin-providers.json` 中两条并存：

| provider id | 显示名 | 状态 | models |
| --- | --- | --- | --- |
| `mistral-vibe` | `Mistral Vibe (ACP · $300)` | signedIn=true，key hint `aTHf` | 9 |
| `mistral-vibe-api` | `Mistral Vibe (API)` | signedIn=false | 9 |

- **同 spec 双 entry 成立**：宿主按 `ownKey(spec, id)` 隔离，且每条 entry 各自加载、不去重，因此不需要目录 junction 退路。
- 面板出现两张同名「Mistral Vibe (honest)」卡属宿主预期——卡片标题读 `package.json` 的 `magpie.name`，而 Provider 视图内已用 `(ACP · $300)` / `(API)` 区分。12/1 实验定论前**不合并**为单 entry。
- 未登录时 `GET 127.0.0.1:3425/v1/models` 只回内置 12 个 id、不含 `mistral-vibe*/*`，属宿主既有权限行为，非报错。
- 宿主 pid 7676 / version 0.1.4924，仅监听 `127.0.0.1:3425`，**无 HTTP reload 入口**，以 `plugins.json` mtime 变化触发 reload。

---

## 6. 本次提交批次（`9373f61`，14 文件 +293/−38）

| 文件 | 改动要点 |
| --- | --- |
| `index.mjs` | `maxBridges` 默认 4 + 忙碌感知淘汰（`:391-415`）；`whoamiRetryMs` 短 TTL（`:373`）；`options.providerName`；whoami 非 2xx 取消响应体 |
| `src/transport.mjs` | `sleepWithSignal`；预中止 signal 直接拒绝；流式 body 不重试；去掉多余 logger 透传 |
| `src/core.mjs` | `isStreamBody` 改为 JSON 解析确认 `stream === true`，解析失败回落正则 |
| `src/acp/jsonrpc.mjs` | 关闭后不再写响应 |
| `src/acp/mcp.mjs` | keepalive 检查 `res.destroyed` |
| `src/acp/openai.mjs` | 事件到 OpenAI 形状的边界收口 |
| `src/acp/runtime.mjs` | 会话 / 进程生命周期加固 |
| `src/billing.mjs` | 无 `limit` 显示百分比（`:62`）；401 / 不可达 / 5xx+0 混合失败分类（`:112-131`） |
| `test/acp.test.mjs` +78 / `test/plugin.test.mjs` +28 / `test/billing.test.mjs` +25 / `test/transport.test.mjs` +17 / `test/core.test.mjs` +1 | 对应回归 |
| `.gitignore` | 新增 `.tmp-shot*.png`（收窄此前的 `*.png`，避免误忽略真实资源） |

提交信息按 transport / acp / billing / plugin+core 四组分段，便于逐条 review。

---

## 7. 审方重点的逐条回应

1. **`headersTimeout: 0` 是否会掩盖僵死？**
   不会。`src/transport.mjs:107-110` 只关掉 undici 内部 300s；首字节前由 `firstOutputMs`（720s）AbortController 看门狗接管，首字节后每个 chunk 间由 `idleMs`（300s）空闲看门狗兜底，另有 30s TCP keepalive。

2. **重试会不会重复扣费？**
   不会。默认 `maxRetriesBeforeFirstByte = 0`；显式开启时也只在响应头前、请求体非流、signal 未中止时重试（`src/transport.mjs:144`）。

3. **`maxBridges=4` 会不会误踢 `stays=session` 活跃会话？**
   不会。淘汰前 `isBridgeBusy` 过滤，在途请求与停泊工具调用都受保护（`index.mjs:392`、`:406`）；单桥内另有 `DEFAULT_MAX_SESSIONS = 4` 管理并发会话。

4. **`chat.headers` 变体是否覆盖？**
   覆盖。宿主注入的 `model.providerID` 恒为 `id`（即派生后的 `providerId`），代码同时匹配 `${providerId}-plugin` 历史变体（`index.mjs:621-627`）。

5. **双 entry 会不会重复计账？**
   不会。宿主按 `providerId` 隔离凭证与用量；两条 entry 各自只读展示 `/billing/budget` 快照（`src/billing.mjs:45-69`），不产生上游二次扣费。

---

## 8. 遗留风险与已知边界

- **`vibe-acp` 版本漂移无降级矩阵**：目前只协商 `protocolVersion: 1`，官方 CLI 升级后需人工回归（`scripts/acp-smoke.mjs`、`scripts/acp-tool-smoke.mjs` 可作探针）。
- **`headersTimeout: 0` 的正确性依赖看门狗**：若未来有人绕过 `createTransport` 直连 undici，长思考会重新被 300s 掐断。
- **`maxBridges` 淘汰策略**：当前按 LRU + 忙碌过滤；若单 key 并发长期超过 4，会出现桥重建开销（有 `fallback: directFetch` 兜底，不报错）。
- **双 entry 面板冗余卡片**：宿主行为，暂不合并；12/1 后若确认只需一路，可退回单 entry。
- **`direct` 引擎在 `$30` 耗尽期不可用**：属配额事实，非代码缺陷。

---

## 9. 12 月 1 日（UTC 00:00 / 北京 08:00）计划

红线：**今天不把 `mistral-vibe-api` 挂进任何路由组**，仅静态加载 + 面板展示验证。

步骤：
1. 设置代理环境变量 `HTTPS_PROXY=http://127.0.0.1:7890` 与 `NODE_USE_ENV_PROXY=1`
2. `node scripts/billing-probe.mjs snapshot` → 确认 `reset_at` 已刷新、两池归零
3. 给 `mistral-vibe-api` 填同一把 key
4. `node scripts/billing-probe.mjs run --arms direct,direct-noua --repeats 3 --settle-ms 60000 --out 1201-billing.json`
5. 按 `used_usd_delta` 判定 `direct` 在 12/1 后是否固定扣 `$30` 池。若确认扣 `$30`，则 `$300` 只能走 ACP，`mistral-vibe-api` 仅作 `$30` 备用通道（届时再补 `surface=vibe-code` 过滤等约 30 行）。

三臂（含 `acp`）对照的完整手册见 `docs/experiment-1201-billing.md`；`acp` 臂需要 `vibe` / `vibe-acp` 在 `PATH`（当前 3.1.5，位于 `C:\Users\Administrator\.local\bin`）。

---

## 10. 审方 checklist

- [ ] `npm test` 是否 61/61（`9373f61`）
- [ ] `index.mjs:391-415` 淘汰逻辑是否存在「活跃会话被回收」路径
- [ ] `src/transport.mjs:103-150` 看门狗与重试边界是否自洽
- [ ] `src/billing.mjs:112-131` 混合失败分类是否会漏报真实错误
- [ ] `src/acp/config.mjs:242-272` `killTree` 在 Windows 上是否可能残留孙进程
- [ ] `.gitignore` 的 `.tmp-shot*.png` 是否应保留
- [ ] 双 entry 是否带来宿主层面的 model id 冲突（当前证据：无）

---

## 11. 相关文档与脚本

- 方案与评审：`docs/plan1.md`、`docs/plan1.1.md`、`docs/plan1-review.md`、`docs/plan1-B-taskbook.md`
- 实验手册：`docs/experiment-1201-billing.md`
- 探针脚本：`scripts/billing-probe.mjs`、`scripts/acp-smoke.mjs`、`scripts/acp-tool-smoke.mjs`、`fixtures/fake-vibe-acp.mjs`

