v0.1.1 聚焦一件事：**自动解析代理**。0.1.0 及之前需要手动配置 `proxyUrl`，0.1.1 之后同一把 key 在任何机器上都能自己找到正确的出口。

## 变更

- 新增 `src/proxy.mjs` 代理解析链，优先级固定：`proxyUrl` 配置 → `none`（强制直连）→ 系统代理 → 环境变量（`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY`）→ Windows WinINET 注册表（`ProxyEnable` / `ProxyServer` / `ProxyOverride`）→ 直连兜底
- 探测到的代理统一生效：chat 请求、控制面请求（`whoami` / `billing`）、ACP 子进程（`vibe-acp` 继承同一套代理环境变量）
- `proxyUrl: "none"` 永不探测；回环地址永远直连；bypass 列表支持 CIDR / 通配符 / `<local>` 与 Windows `ProxyOverride` 两种写法；非 Windows 平台不触碰注册表，探测失败自动降级直连
- 传输层重构：`headersTimeout: 0` 关闭 undici 内建 300s 超时，交由首字 720s + 空闲 300s 双看门狗接管；Bun 宿主回退宿主 fetch 同样受双看门狗保护
- 测试从 61 项扩到 82 项（新增 `test/proxy.test.mjs` 全矩阵），全部走本地 mock，不消耗额度

## 升级

```sh
magpie plugin update mistral-vibe
```

升级后删除旧的 `proxyUrl` 配置（除非确实要固定某个代理），插件会自己按上面的优先级解析。
