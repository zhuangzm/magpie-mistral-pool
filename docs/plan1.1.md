> **历史文档（已归档）**：本文为立项初期的补充草案，其前置握手与 Speakeasy UA 假设已在 [plan1-review.md](plan1-review.md) 中核对并推翻。当前实现请以根目录 [README.md](../README.md) 为准。

你测试 `SammySnake-d/magpie-mistral-code` 和 `handsomezhuzhu/MistralVibe2API` 仍无法消耗 `$300` Vibe 额度，核心原因在于 **Mistral 在 `mistral-vibe` v3.x 升级后收紧了 Vibe 额度池的准入校验**。旧版社区插件仅做了简单的 Key 转发，未对齐官方 `mistralai/mistral-vibe`（v3.1.5）的完整握手与请求特征，导致请求被 Mistral 网关判定为普通 API 调用并落入已耗尽的 `$30` 池（触发 `402`）。

结合 **`mistralai/mistral-vibe`**（官方客户端协议标准）、**`SammySnake-d/magpie-mistral-code`**（Magpie 插件生命周期与 OAuth/额度查询框架）以及 **`handsomezhuzhu/MistralVibe2API`**（OpenAI 协议转换与流式适配层），以下是可直接交给开发 Agent 执行的完善版实施方案。

---

## 1. 现有插件无法使用 Vibe 额度的根因诊断

实施 Agent 在编写代码前，必须明确现有两个参考项目失效的四个技术断点：

| 断点维度 | 现有社区插件的实现缺陷 | 官方 `mistralai/mistral-vibe` (v3.1.5) 真实行为 | 改造方案 (`mistral-pool`) |
| --- | --- | --- | --- |
| **认证与握手链路** | 仅将 Key 放入 `Authorization: Bearer` 后直接请求 `/v1/chat/completions` | 启动及会话前会携带凭证请求 `/api/vibe/whoami` 与 `/api/v1/code/managed-config` 获取租户 `api_base` 与 `vibe_base` 状态；控制台 OAuth 走 PKCE 签发专属 Vibe Key | 保留 `magpie-mistral-code` 的 OAuth PKCE 登录与手动填入 Vibe Key 双模式，并在 Key 激活/保活时模拟官方前置握手 |
| **客户端协议指纹** | 使用过时的 `User-Agent`（如 `mistral-vibe/1.x` 或默认 HTTP 客户端头） | 底层调用 Speakeasy 生成的 Python SDK，发送严格格式的 `speakeasy-sdk/python 3.5.0 2.935.1 1.0.0 mistralai` 及特定上下文头 | 直接从本地 `mistralai/mistral-vibe` 源码提取最新 SDK 请求头模板，并支持在插件配置中热更新头模板 |
| **模型白名单与参数** | 默认映射 `codestral`、`devstral` 等旧模型，或未正确处理 `thinking` / `reasoning_effort` 字段 | 仅对 Vibe 套餐内模型（`deepseek-v4-1-flash-1017`、`mistral-large-4`、`glm-5-3` 等）走 `$300` 池，且对深度思考字段格式有严格校验 | 内置 Vibe 3.1.5 实测白名单模型映射，复用 `MistralVibe2API` 的消息转换层并补齐 `thinking` 字段规范化 |
| **号池调度与长连接** | 单账号直连或共用全局连接池，无会话粘性与首字前断流重试 | 多轮长上下文（400k+ token）在思考阶段首字耗时（TTFT）达 10~15 秒，易被代理链路重置导致 `unexpected EOF` | 引入多 Key 号池、基于 `prompt_cache_key` 的会话粘性路由，以及独立代理 + HTTP/1.1 长连接保活 |

---

## 2. 三个参考仓库的代码复用与分工

实施 Agent 需先克隆并分析以下三个仓库（可辅以 `lili-luo/dsh-plugin-bundle` 中的 `dsh-mistral-pool` 校验请求头细节）：

1. **`SammySnake-d/magpie-mistral-code`（作为项目脚手架与 Magpie 宿主适配层）**
* **复用部分：** Magpie 插件目录结构、Manifest 配置声明、PKCE 浏览器登录流程、以及通过 `x-api-key` 请求 `GET /v1/billing/budget` 读取 `$300 Included Vibe & Studio usage` 独立余额卡片的逻辑。
* **重构部分：** 将单账号存储结构扩展为支持多 Key 数组的号池存储（`PoolStore`），修复其对 `thinking` 字段转换不完整导致的兼容问题。


2. **`handsomezhuzhu/MistralVibe2API`（作为协议转换与 SSE 流式转发内核）**
* **复用部分：** OpenAI `/v1/chat/completions` 请求体到 Mistral API 格式的双向转换、工具调用（Tool Calls）解析、以及 SSE 流式响应中 `usage`（含缓存命中 Token）的提取逻辑。
* **重构部分：** 替换其硬编码的旧版请求头与端点常量，接入动态指纹注入器与错误重试中间件。


3. **`mistralai/mistral-vibe`（作为协议与指纹基准源）**
* **提取部分：** 从官方仓库 `vibe/core/llm/` 及依赖定义中提取最新的 `User-Agent` 版本号、内置模型列表（`config.toml` 默认模型定义）、以及请求体序列化规范。



---

## 3. `mistral-pool` 插件详细架构设计

### 3.1 插件配置项（Manifest Schema）

在 Magpie 插件设置面板中提供以下配置项：

* **`vibe_keys`（多 Key 号池）：** 支持通过 PKCE 一键登录追加账号，也支持手动粘贴多个 `mstr...` Vibe 专属 Key（每行一个，支持备注标签）。
* **`proxy_url`（独立代理地址）：** 支持填写 `[http://127.0.0.1](http://127.0.0.1):端口` 或 `socks5://127.0.0.1:端口`，解决本机直连 `api.mistral.ai` 超时问题。
* **`custom_user_agent`（SDK 指纹覆盖，选填）：** 默认内置 `speakeasy-sdk/python 3.5.0 2.935.1 1.0.0 mistralai`，允许用户在 Mistral 升级 Vibe CLI 版本后无需重编译即可手动更新。
* **`sticky_ttl_seconds`（默认 `300`）：** 同一会话锁定同一个 Key 的时长（对齐 Mistral 显存前缀缓存约 5 分钟的生命周期）。
* **`pre_first_byte_retries`（默认 `2`）：** 收到首个 SSE 数据块前遇到 `unexpected EOF` 或 `402`/`429` 时的无感切换重试次数。

### 3.2 核心请求流水线（Request Pipeline）

当 Magpie 网关将下游 Agent（Claude Code / OpenCode）的请求转发至 `mistral-pool` 时，按以下顺序处理：

1. **会话指纹提取（保障 90%+ 前缀缓存命中）：**
* 优先读取请求体中的 `prompt_cache_key`；若下游未传，则提取 `messages` 中 `system` 与第一条 `user` 消息的拼接文本计算 SHA-256 哈希作为 `session_id` 并写入 `prompt_cache_key`。


2. **粘性 Key 路由（`KeyPoolManager`）：**
* 根据 `session_id` 查询 `LRU + TTL` 路由表：若存在未过期且状态为 `HEALTHY` 的绑定 Key，直接复用并续期 TTL；否则从健康池中选择并发最低的 Key 建立绑定。


3. **协议指纹与请求体清洗：**
* **请求头：** 剥离下游客户端自带的 `User-Agent`、`X-Stainless-*` 等泄露第三方身份的 Header，严格写入官方 Vibe SDK 的 `User-Agent` 与标准 `Authorization: Bearer <vibe_key>`。
* **请求体：** 校验模型名称是否属于 Vibe 套餐白名单（默认支持 `deepseek-v4-1-flash-1017`、`mistral-large-4`、`mistral-medium-3.5`、`glm-5-3`、`glm-5-3-flash`）；规范化 `reasoning_effort` 与多轮历史中的 `thinking` 块，避免因前缀字节变动破坏 Mistral 64-token 缓存块。


4. **独立传输层与断流自愈（解决 `unexpected EOF`）：**
* 使用独立配置的 `proxy_url` 构建 HTTP 客户端，强制禁用 HTTP/2 多路复用（使用 HTTP/1.1）并设置较长的响应头超时（`ResponseHeaderTimeout: 60s`），防止长上下文深度思考阶段被代理网关发送 `RST_STREAM` 掐断。
* **容错逻辑：** 若上游返回 `402`（该 Key 的 `$300` 池耗尽或被风控），立即将该 Key 标记为 `EXHAUSTED`（冷却 1 小时），解除当前会话绑定并自动换下一个健康 Key 重放请求；若在发送首个 SSE chunk 前发生 `unexpected EOF`，重建 TCP 连接并换 Key 重试。


5. **额度与缓存统计回传：**
* 实时透传上游 SSE 流，并在流结束时保留 `usage.prompt_tokens_details.cached_tokens` 供 Magpie 统计缓存命中率；同时后台异步调用 `GET /v1/billing/budget`（使用 `x-api-key` 头）刷新每个 Key 的 `$300 Vibe & Studio` 剩余额度并在 Magpie 卡片中展示。



---

## 4. 分阶段实施与验证步骤

将以下四个阶段交给开发 Agent 依次执行，每完成一步需通过对应的验证检查点：

1. **克隆三个仓库并比对协议差异:** 阶段一：源码对齐与指纹提取.
克隆 `mistralai/mistral-vibe`、`SammySnake-d/magpie-mistral-code` 与 `handsomezhuzhu/MistralVibe2API`。从 `mistral-vibe` 源码中确认最新的 SDK `User-Agent`、`/api/vibe/whoami` 握手端点及内置模型配置；以 `magpie-mistral-code` 为基础初始化 `mistral-pool` 工程骨架。
*Verification:* 工程目录可正常编译/运行，且已整理出完整的 Vibe 请求头字典与白名单模型映射表。


2. **移植 MistralVibe2API 转换逻辑并加固 HTTP 客户端:** 阶段二：请求转换与防断流传输层开发.
将 `MistralVibe2API` 的 OpenAI 协议转换与 SSE 流式解析模块接入插件，补全 `thinking` 字段兼容处理；实现支持独立 `proxy_url` 的 HTTP/1.1 传输层，剥离下游第三方 `User-Agent` 并注入官方 Vibe SDK 指纹。
*Verification:* 使用 `curl` 向本地插件端口发送 `deepseek-v4-1-flash-1017` 请求，不再返回 `402 · API budget exhausted`，且 Mistral 网页端 `$300 Included Vibe & Studio usage` 已用额度实时上涨。


3. **实现多 Key 粘性路由、402 自动切换与余额读取:** 阶段三：号池粘性调度与额度监控集成.
实现基于 `prompt_cache_key` 的粘性路由表、首字前 `unexpected EOF` 与 `402`/`429` 自动重试切换机制，并复用 `x-api-key` 请求 `/v1/billing/budget` 的逻辑在 Magpie 界面展示每个 Key 的 `$300` 池剩余额度。
*Verification:* 在 Magpie 监控面板中连续发送两轮长上下文对话，第二轮缓存命中率达到 `90%` 以上且落在同一 Key；混入失效 Key 时请求能自动无缝切换至健康 Key。


4. **接入下游编程 Agent 验证长上下文稳定性:** 阶段四：端到端 Agent 联调压测.
将打包后的 `mistral-pool` 挂载至 Magpie，在 Claude Code / OpenCode 中发起超过 200k token 的多轮复杂代码任务，观察开启 `high` 思考强度时的流式完整性与响应速度。
*Verification:* 全程无 `unexpected EOF` 会话中断，Magpie 监控日志中缓存命中与费率统计正常。