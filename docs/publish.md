# 发布与分发指南

维护者清单：从本机推到 GitHub、装进 Magpie，以及可选的 npm 与插件市场上架。全程只用你自己的账号，仓库里不放任何密钥。

## 0. 现状

| 项 | 值 |
| --- | --- |
| 代码仓库 | `D:\workspaceAI\magpie-mistral-pool`，分支 `master` |
| npm 名 | `@solary/magpie-mistral-pool`，版本 `0.1.0` |
| Magpie 插件名 | `Mistral Vibe (honest)`；provider `mistral-vibe`（第二条入口 `mistral-vibe-api`） |
| 已就绪 | 中英双 README（`README.md` / `README.en.md`）、MIT LICENSE、`magpie.*` 元数据、CI（ubuntu/windows/macos × node 20/22/24） |
| 已验证 | `node --test` 61/61；`npm pack --dry-run` 15 文件 / 46 kB，不含 `docs/`、`test/`、`fixtures/`、实验 JSON |
| 未就绪 | 远端仓库、tag、npm 发布、市场上架 |

## 1. 推到 GitHub

仓库名与作者已写进 `package.json`（`weijianping/magpie-mistral-pool`），远端 `origin` 也已配好。只差在 GitHub 上建一个空仓库：

1. 打开 <https://github.com/new>，Owner 选 `weijianping`，Name 填 `magpie-mistral-pool`，可见性 **Public**。
2. **不要**勾选 Add a README / .gitignore / license —— 本地已有，勾了会造出一次无谓的合并。
3. 建完直接推：

```powershell
cd D:\workspaceAI\magpie-mistral-pool
git push -u origin master
```

本机没有 `gh` CLI，也没有 `GITHUB_TOKEN`，第一次推会由 Git Credential Manager 弹浏览器登录，那是预期行为。若想走 token，用 `git push https://<token>@github.com/weijianping/magpie-mistral-pool.git master`，但别把带 token 的 URL 留在 `git remote -v` 里。

**必须 Public**：Magpie 的 `github:owner/repo` spec 是匿名拉取的，私有仓库装不上。

推完检查两件事：

- Actions 里 CI 首跑全绿（3 平台 × 3 个 node 版本，约 2 分钟）；
- 仓库首页的 CI 徽章转绿（徽章 URL 已指向这个仓库，地址不对就会一直是灰的）。

## 2. 打 tag 与 Release

```powershell
git tag -a v0.1.0 -m "0.1.0: honest direct engine + ACP engine"
git push origin v0.1.0
```

然后在 GitHub → Releases → Draft a new release 选 `v0.1.0`，摘要可以直接抄 README 开头两段，附上「两个引擎扣哪本账」那张表。

## 3. 装进 Magpie（最小路径，不依赖 npm）

```powershell
magpie plugin add github:weijianping/magpie-mistral-pool
magpie plugin login mistral-vibe
magpie plugin
```

- 改代码时用本地目录：`magpie plugin add D:\workspaceAI\magpie-mistral-pool`，改完重载宿主生效。
- `engine` 默认 `direct`；要消耗 `$300` Vibe 池，需要这台机器 PATH 里有 `vibe-acp`（`uv tool install --python 3.14 mistral-vibe`）。
- 设置选项用 `magpie plugin options <name> "{\"engine\":\"acp\"}"`，不要手改运行态文件。
- 同一份 spec 加载两条 entry 就是双入口（`mistral-vibe` / `mistral-vibe-api`），宿主按 providerId 隔离凭证与用量。
- 改完 `engine` / `providerId` 必须重载插件宿主或重启 Magpie，面板里可能还缓存着旧 provider 对象。

## 4. 发 npm（可选）

现状：`registry.npmjs.org` 上 `@solary/magpie-mistral-vibe` 与 `@solary/magpie-mistral-pool` 都是 404，说明 `@solary` 这个 scope 还没在官方 npm 上建起来（母仓库 `magpie-mistral-code` 一直靠 GitHub 分发）。所以这条路要先做账号侧的事：

1. `npm login --registry=https://registry.npmjs.org`（本机 `npm whoami` 目前是 `ENEEDAUTH`）；
2. 在 npmjs 建 scope：`npm org create solary`，或者把包名改成已有的 scope；
3. 发布时必须显式指定官方 registry —— 本机默认是 npmmirror 镜像，**镜像不能发布**：

```powershell
npm publish --registry=https://registry.npmjs.org --access public
```

发布之后 `magpie plugin add @solary/magpie-mistral-pool` 和 `magpie plugin add npm:@solary/magpie-mistral-pool` 都能用，README 里那三种装法才全部成立。

## 5. 上 Magpie 插件市场（可选）

市场列表是 `D:\workspaceAI\plugins` 的 `registry.json`，加一条 entry 提 PR：

```json
{ "package": "@solary/magpie-mistral-pool", "name": "Mistral Vibe (Pool)", "providers": ["mistral-vibe", "mistral-vibe-api"], "community": true,
  "summary": {
    "en": "Mistral Vibe key with two engines: the official vibe-acp bridge billed to the monthly Vibe pool, or an honest Chat Completions provider billed to the API credits. Vibe-surface models and dual-pool usage; no fingerprint spoofing.",
    "zh": "Mistral Vibe key 的两种引擎：官方 vibe-acp 桥接消耗套餐月度 Vibe 额度，或诚实直连按 API 额度计费。只暴露 Vibe surface 模型，双池用量展示，不伪造客户端指纹。"
  } }
```

注意三条评审规则：

- 市场按「通道」判重，`mistral-vibe` 与 `magpie-mistral-code` 的 `mistral-vibe-code` 同属 Mistral 通道（当前 `registry.json` 里还没有任何 mistral 条目，属于首次上架）。所以 PR 描述、包 README、registry `summary` 三处都要写清差异：本插件多一条官方 ACP 路径、可切 `$300` 池、直连不做指纹伪装。
- 市场按 npm 包名安装，所以这一步依赖第 4 步先发版；只有 `@magpie-community/*` 的包才有 `dist` 分支兜底，外部 scope 没有。
- `bun scripts/check.mjs <name>` 只对放在该仓 `packages/` 下的包生效，外部仓库靠自己的 CI 加一次真机 `plugin add` 验证即可。

## 6. 发版前检查清单

- `node --test` 61/61 通过（全部打本地 mock，不耗额度）。
- `npm pack --dry-run` 的 15 个文件里没有 `docs/`、`test/`、`fixtures/`、`scripts/`、`billing-probe-*.json`、`1201-billing*.json`、`.tmp-shot*.png`。
- `git status` 干净；`git log -p` 里没有密钥、`VIBE_HOME` 缓存。
- 两个 README 互链有效，徽章 URL 与 `repository` / `homepage` / `bugs` 都指向真实地址。
- `package.json` 的 `version` 与 tag 一致。
- 2026-12-01 账期重置前，`mistral-vibe-api`（`engine: direct`）只做静态加载与面板展示，不进任何路由组。

