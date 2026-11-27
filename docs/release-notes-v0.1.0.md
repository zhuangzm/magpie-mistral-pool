把 **Mistral 账号的 Vibe 额度**接进 [magpie](https://github.com/yetone/magpie)。同一个插件提供两种引擎：一种走官方 ACP，消耗套餐的 **$300 Vibe 池**；一种走诚实直连，按非 Mistral 产品计到 **$30 API 池**。

> 非官方插件，与 Mistral AI 无隶属关系。不伪造客户端指纹、不模拟官方客户端 User-Agent——直连引擎就是一个规矩的 OpenAI 兼容 provider。

## 两个引擎的差别

| 引擎 | 请求由谁发出 | 扣哪本账 |
| --- | --- | --- |
| `direct`（默认） | 插件自己，走 OpenAI Chat Completions | 2026-12-01 起，非 Mistral 产品的调用计 **$30 Platform API 额度** |
| `acp` | 官方 `vibe-acp` 子进程（ACP + 本机 MCP 回桥） | 官方产品路径，计 **$300 Monthly Vibe 额度** |

两者暴露同一份 Vibe surface 模型表，并在用量卡里同时展示计划的两本账。

Provider id：`mistral-vibe`，与 Magpie 内置的 `mistral` API key provider 相互独立。同一份插件可加载两次得到 `mistral-vibe`（ACP · $300）与 `mistral-vibe-api`（直连 · $30 兜底）。

## 安装

```sh
magpie plugin add github:zhuangzm/magpie-mistral-pool
magpie plugin login mistral-vibe
```

要消耗 `$300` Vibe 池，需要这台机器 PATH 里有官方 CLI：

```sh
uv tool install --python 3.14 mistral-vibe
vibe-acp --version
```

## 本版内容

- 双引擎：`direct`（诚实 Chat Completions）与 `acp`（官方 vibe-acp 桥接，含 MCP 工具回桥）
- 只暴露 Vibe surface 模型，过滤 `codestral` / `ministral` / `pixtral` 等非 Vibe surface 条目
- 双池用量卡：Vibe 月度池与 Platform API 池各自展示，非主池标为参考快照
- 传输层：首字 720s、空闲 300s 看门狗 + 30s TCP keepalive，规避长思考 `unexpected EOF`
- 61 项单元测试全部走本地 mock，不消耗额度
