# 2026-12-01 计费归属对照实验

> 目的：用一次可复现的实验回答一个问题——**2026-12-01 之后，用 Vibe key 直连 `api.mistral.ai`，到底扣 `vibe_budget` 还是 `api_budget`？**
> 脚本：`scripts/billing-probe.mjs`（零依赖，Node >= 18.3）
> 结论用途：决定路线 B 是否足够；只有实验满足三道门槛，才启动路线 A（ACP）。

## 1. 为什么必须做

现有两份"实测"都发生在 2026-11，即计费分界之前：

- `MistralVibe2API/README.md:110-131`：Vibe key 走 Vibe 池；API key 穿完整 Vibe 指纹仍走 API 池；三种 UA 组合全部 200。
- `dsh-mistral-pool/README.md:7`：从 2026-12-01 起，非官方产品直连即使拿 Vibe key 也扣 `$30`。

两种说法可以这样调和：**分界前**按 key 类型归属，**分界后**按"是否官方产品"归属。但这只是假设，正是本实验要验证的东西。所以 11 月的实验无法回答 12 月的问题，必须在 12/1 之后重跑。

## 2. 前置条件

- [ ] 已过 **2026-12-01 00:00 UTC**（北京时间 12/1 08:00）；最终以 `snapshot` 里的 `reset_at` 为准，不要只看日历。
- [ ] 一个 Vibe key，且 `/v1/billing/budget` 可读（需要 `see_org_inference_usage`；403 就换 key 或让管理员开权限）。
- [ ] `vibe-acp` 可用（路线 A 的实验臂需要）：
  ```powershell
  uv tool install --python 3.14 mistral-vibe
  vibe --setup
  vibe-acp --version
  vibe-acp --help
  ```
  如果 `vibe-acp` 不在 PATH，设置 `VIBE_ACP_CMD` 为完整路径（`.exe` 优先；`.cmd` 也可，脚本会走 shell）。
  脚本用临时 `VIBE_HOME`，不依赖你 `~/.vibe` 的登录态；但 `vibe --setup` 仍建议跑一次，用来确认 CLI 本身可用。
  如果 `vibe-acp` 启动即报 "Unified Harness runtime is required"，执行 `uv tool upgrade mistral-vibe` 或重装；该 runtime 随发行版提供。
- [ ] Node >= 18.3：`node --version`。
- [ ] 当前目录是 `magpie-mistral-pool` 仓库根目录。

## 3. 预检：先看当前池

```powershell
$env:MISTRAL_API_KEY = '<your-vibe-key>'
node scripts/billing-probe.mjs snapshot
```

预期输出：

```text
=== snapshot @ 2026-12-01T... ===
plan: Pro
Vibe ($300) : used $... / $300.00 (...) reset=...
API ($30)   : used $... / $30.00 (...) reset=...
```

如果 `/billing/budget` 返回 403，先解决权限；否则实验无法测量。

## 4. 跑实验

### 4.1 最小实验（direct + acp）

```powershell
node scripts/billing-probe.mjs run `
  --arms direct,acp `
  --model deepseek-v4-1-flash-1017 `
  --repeats 3 `
  --settle-ms 60000 `
  --out 1201-billing.json
```

### 4.2 完整实验（再加"无 UA"对照组）

```powershell
node scripts/billing-probe.mjs run `
  --arms direct,direct-noua,acp `
  --model deepseek-v4-1-flash-1017 `
  --repeats 3 `
  --settle-ms 60000 `
  --out 1201-billing-full.json
```

### 4.3 如果增量看起来是 0

计费百分比可能有舍入。按顺序尝试：

1. `--settle-ms 120000`（账单可能延迟）。
2. `--repeats 10`。
3. 用更大的 prompt：
   ```powershell
   node scripts/billing-probe.mjs run --arms direct,acp `
     --prompt-file .\docs\plan1-review.md --repeats 3 --settle-ms 60000
   ```
4. 换一个更贵的模型（如 `mistral-large-4-0`），让单位 token 成本更高。

## 5. 脚本做了什么

每个 arm 前后各读一次：

- `GET /v1/billing/subscription`
- `GET /v1/billing/budget`

然后计算两个池的增量：

- `usage_percentage_delta`
- `used_usd_delta = initial_budget * usage_percentage_delta / 100`

三个 arm：

| arm | 请求 | 说明 |
| --- | --- | --- |
| `direct` | `POST /v1/chat/completions`，显式官方 Vibe UA | 给"指纹假说"最强的一次机会 |
| `direct-noua` | 同上，不设 Vibe UA | 排除 UA 变量 |
| `acp` | spawn `vibe-acp`，走 `initialize` → `session/new` → `session/prompt` | 官方产品路径 |

ACP arm 使用临时 `VIBE_HOME`：

- `active_model` 固定为 `--model`；
- `enabled_tools = ["__billing_probe_no_tools__"]`，禁用所有工具；
- `include_project_context = false`、`enable_subagents = false`；
- 结束后删除临时目录，不碰你的 `~/.vibe`。

脚本不会打印 key，只把完整的 budget JSON 写进 `--out` 文件。

## 6. 结果判读

把 summary 表抄下来，对照下表：

| direct vibe Δ | direct api Δ | acp vibe Δ | acp api Δ | 结论 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| > 0 | ≈ 0 | > 0 | ≈ 0 | 直连仍进 `$300` | **B 足够**；A 不必做 |
| ≈ 0 | > 0 | > 0 | ≈ 0 | 直连只进 `$30`，ACP 进 `$300` | **B 只能当 `$30` 兜底；`$300` 必须走 A** |
| ≈ 0 | > 0 | ≈ 0 | > 0 | ACP 也进 `$30` | **A 也救不了；只能回到官方交互式 CLI/官方产品** |
| > 0 | ≈ 0 | ≈ 0 | > 0 | 结果互相矛盾 | 重跑；检查 key/model 是否一致 |
| ≈ 0 | ≈ 0 | ≈ 0 | ≈ 0 | 测量失败 | 加 settle / repeats / prompt，或检查 budget 权限 |

注意：

- 不要比较 direct 与 acp 的 token 数或成本；ACP 会加自己的 system prompt 和 agent 逻辑，token 必然不同。**只比较"哪个池在动"**。
- `usage_percentage` 可能被舍入；以 `used_usd_delta` 为主，百分比为辅。
- 如果 `vibe_budget` 与 `api_budget` 同时增长，先怀疑账单延迟或账户级共用额度；隔 5 分钟再跑一次单臂。

## 7. 路线 A 的三道门槛

只有以下三条**全部满足**，才启动 ACP 移植：

1. 12/1 后实测 direct 只进 `api_budget`；
2. 实测 `vibe-acp` 进 `vibe_budget`；
3. 你确实需要在 Claude Code / OpenCode 里共享 `$300`，而不是用官方 `vibe` CLI 或现成的 DSH ACP 模式。

否则：

- 第 1 条不满足 → B 已经够用，别做 A。
- 第 2 条不满足 → A 没有意义，别做 A。
- 第 3 条不满足 → 用官方 CLI/DSH，零开发成本。

## 8. 交付物

实验结束后保留：

- `1201-billing.json`（或你指定的文件名）；
- summary 表截图/文本；
- 当时的 `snapshot` 输出（plan、reset_at、两个池的初始值）；
- 如果失败，附上 `vibe-acp` 的 stderr 尾部与 `--verbose` 日志。

把这些发回来，就能直接判定走 B、走 A，还是回到官方 CLI。

