## 1. 项目背景与核心目标

本计划旨在将开源项目 `lili-luo/dsh-plugin-bundle` 中的 `dsh-mistral-pool` 核心能力，按照 `magpie-community/plugins` 的社区插件规范，移植并重构为独立的 Magpie 插件 **`magpie-mistral-pool`**。

### 解决的核心痛点

1. **额度池精准路由（解决 `402 API budget exhausted`）：** Mistral Pro 订阅包含独立的 `$30` 通用 API 额度池与 `$300` Vibe & Studio 额度池。原生 Magpie 配置无法完整模拟官方 Vibe 客户端的协议指纹与请求头特征，导致请求被 Mistral 网关回退路由至已耗尽的 `$30` 池并报错 `402`。
2. **多账号号池调度与前缀缓存保护（解决缓存 `0%` 问题）：** 支持配置多个 Vibe API Key 组成的号池，并通过会话粘性（Sticky Routing）将同一会话固定路由到同一个 Key，避免跨 Key 漂移破坏 Mistral 的 64-token 前缀缓存（Prefix Caching）。
3. **长上下文流式传输稳定性（解决 `unexpected EOF`）：** 针对大模型深度思考（`Thought`）阶段首字耗时（TTFT）较长、代理链路易发生连接重置的问题，提供独立代理配置、连接保活与首字前异常自动切换/重试机制。

---

## 2. 参考仓库与技术边界

实施 Agent 在编写代码前，需先拉取并分析以下两个参考仓库的源码结构：

| 参考仓库 | 角色定位 | 需提取的关键信息 |
| --- | --- | --- |
| `[https://github.com/lili-luo/dsh-plugin-bundle](https://github.com/lili-luo/dsh-plugin-bundle)` (`dsh-mistral-pool` 目录) | **核心协议与号池实现参考** | 1. 访问 Mistral Vibe 额度池所需的完整请求头（如 `User-Agent` SDK 签名、认证头及其他隐式特征头）<br>

<br>2. Vibe 套餐白名单模型映射关系<br>

<br>3. Key 池轮询、冷却与状态管理逻辑 |
| `[https://github.com/magpie-community/plugins](https://github.com/magpie-community/plugins)` | **Magpie 插件规范参考** | 1. 插件目录结构与清单文件（Manifest）字段定义<br>

<br>2. 插件进程启动、端口/IPC 通信协议与配置注入方式<br>

<br>3. OpenAI 兼容接口（`/v1/chat/completions`、`/v1/models`）及 SSE 流式响应格式要求 |

---

## 3. 系统架构与功能规格

### 3.1 插件配置项设计（Manifest Schema）

插件需向 Magpie 前端暴露以下可配置参数：

* **`api_keys`（必填，多行文本/数组）：** 支持填入一个或多个 Mistral Vibe 专属 API Key（支持备注名称或权重）。
* **`proxy_url`（选填，字符串）：** 支持独立配置 `http://` 或 `socks5://` 代理地址（例如 `[http://127.0.0.1:7890](http://127.0.0.1:7890)`），避免依赖系统环境变量或因直连超时导致 `context deadline exceeded`。
* **`sticky_ttl`（选填，整数，默认 `300` 秒）：** 会话与特定 Vibe Key 的绑定有效期，对齐 Mistral 推理节点的显存缓存存活窗口（约 5 分钟）。
* **`max_retries`（选填，整数，默认 `2`）：** 当某个 Key 触发 `402`/`429` 或在收到首个 SSE 数据块前发生 `unexpected EOF` 时的自动重试次数。

### 3.2 内置 Vibe 套餐白名单模型

插件的 `/v1/models` 接口及模型注册表需默认暴露以下 Vibe 额度池支持的模型 ID（同时允许用户在配置中追加自定义模型 ID）：

* `deepseek-v4-1-flash-1017`（DeepSeek V4.1 Flash，1M 上下文）
* `mistral-large-4` / `mistral-large-latest`（Mistral Large 4）
* `mistral-medium-3.5` / `mistral-medium-latest`（Mistral Medium 3.5）
* `glm-5-3` / `glm-5-3-flash`（GLM 5.3 系列，Mistral Hosted）
* `mistral-vibe-cli-latest` / `mistral-vibe-cli-fast`

### 3.3 请求改写与协议指纹层（核心）

1. **请求头清洗与注入：** 剥离下游 Agent（如 Claude Code、OpenCode）透传的原始 `User-Agent` 与无关追踪头，严格注入从 `dsh-mistral-pool` 提取的官方 Vibe SDK 请求头（如 `speakeasy-sdk/python ... mistralai` 及配套标识）。
2. **缓存键（`prompt_cache_key`）透传：** 保留 Magpie 或下游客户端传入的 `prompt_cache_key`（若请求未携带，则基于 `system` 提示词与首条 `user` 消息的 SHA-256 前缀自动生成确定性 `prompt_cache_key`），不得注入无效的字面量字符串。
3. **请求体规范化：** 确保多轮对话中的历史消息与 `thinking` 块结构不被动态改写，保障前序 Token 严格一致。

### 3.4 号池调度与容错机制

1. **基于会话粘性的路由：**
* 提取请求中的 `prompt_cache_key`（或首轮消息前缀哈希）作为 `session_fingerprint`。
* 查询内存路由表：若存在未过期的健康 Key 绑定记录，优先复用该 Key 并刷新 `sticky_ttl`；否则从健康池中选择负载最低/轮询到的 Key 建立绑定。


2. **错误分级与自愈：**
* **触发 `402`（额度耗尽）或 `401`（Key 失效）：** 立即将该 Key 标记为冷却状态（如冷却 1 小时或直至手动重置），解除当前会话绑定，并无缝切换至池内下一个健康 Key 重试当前请求。
* **触发 `429`（速率限制）：** 对该 Key 施加短时退避冷却（如 `30s` 或遵循响应头 `Retry-After`），切换 Key 重试。
* **触发连接超时 / 首字前 `unexpected EOF`：** 销毁当前失效的底层 HTTP 连接池实例，切换代理连接或备用 Key 发起重试。



### 3.5 流式响应与统计兼容

* 完整透传上游 `text/event-stream` 数据块，禁止在代理层缓冲整个响应体，确保低首字延迟。
* 完整保留最后一个 SSE chunk 中的 `usage` 对象（特别是 `prompt_tokens`、`completion_tokens` 以及 `prompt_tokens_details.cached_tokens`），确保 Magpie 监控面板能准确计算缓存命中率与节省费用。

---

## 4. 分阶段实施计划

### 阶段一：仓库调研与工程初始化

1. 克隆 `lili-luo/dsh-plugin-bundle` 与 `magpie-community/plugins` 到本地工作区。
2. 阅读 `dsh-mistral-pool` 源码，提取其构造 Mistral Vibe 请求的完整 HTTP Header 字典、Endpoint URL、错误处理逻辑及测试脚本。
3. 阅读 `magpie-community/plugins` 中的现有插件模板与文档，确定插件使用的开发语言（Go / Node.js / Python）、构建命令、清单文件名及 Magpie 加载本地插件的目录路径。
4. 创建 `mistral-pool` 插件项目骨架，完成基础的 `manifest` 声明与配置加载模块。

### 阶段二：核心转发与协议适配开发

1. 实现 HTTP 客户端工厂：支持配置独立代理（HTTP/SOCKS5）、禁用不稳定的 HTTP/2 多路复用（强制 HTTP/1.1 或配置合理的 TLS 握手与空闲超时，降低长连接 `unexpected EOF` 概率）。
2. 实现请求转换中间件：将 Magpie 下发的标准 OpenAI Chat Completions 请求转换为符合 `dsh-mistral-pool` 规范的上游请求，注入 Vibe 专属 Header 与确定性 `prompt_cache_key`。
3. 实现 `/v1/models` 端点：返回 Vibe 套餐白名单模型列表及对应的上下文窗口元数据。

### 阶段三：号池管理、粘性路由与重试引擎

1. 实现线程/协程安全的 `KeyPoolManager`：维护每个 Vibe Key 的状态（`ACTIVE`、`COOLDOWN`、`EXHAUSTED`）、冷却截止时间及累计请求统计。
2. 实现基于 `LRU + TTL` 的会话粘性映射表，确保同一会话在缓存有效期内锁定同一 Key。
3. 实现请求重试包装器：拦截上游 `401`/`402`/`429` 及首字前网络断流错误，执行自动 Key 切换与重放；若所有 Key 均不可用，向 Magpie 返回结构化的 OpenAI 错误 JSON。

### 阶段四：本地联调与端到端验收

1. 将编译/打包后的 `mistral-pool` 插件挂载到本地 Magpie 实例中，在 Magpie 管理界面填入 Vibe API Key 与代理地址。
2. 使用 `curl` 及下游真实 Agent（如 Claude Code / OpenCode）发起多轮对话测试。
3. 登录 Mistral 后台观察 `Subscription -> Included Vibe & Studio usage` 进度条，确认调用成功扣减 `$300` 额度池。

---

## 5. 验收标准（Definition of Done）

* [ ] **额度池验证通过：** 配置 Vibe API Key 后，调用 `deepseek-v4-1-flash-1017` 与 `mistral-large-4` 不再返回 `402 · API budget exhausted`，且 Mistral 网页端 `$300 Included Vibe & Studio usage` 已用额度实时增长。
* [ ] **前缀缓存生效：** 同一会话连续发送两轮以上长上下文对话（间隔 `< 3 分钟`），Magpie 监控面板显示第二轮请求的缓存命中率达到 `90%` 以上，且路由落在同一个 Key 上。
* [ ] **号池容错有效：** 在配置 1 个已耗尽（`402`）的普通 Key + 1 个有效 Vibe Key 的混合池场景下，发起请求能自动跳过失效 Key 并成功返回结果，下游会话不中断。
* [ ] **流式传输稳定：** 在开启深度思考（`reasoning/high`）且首字耗时超过 `10s` 的长上下文场景下，SSE 流式输出完整结束，无 `unexpected EOF` 断流报错。
* [ ] **可交付文档：** 仓库根目录包含清晰的 `README.md`，说明插件安装路径、配置字段含义及故障排查方法。