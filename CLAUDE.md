# CLAUDE.md

## 项目概述

usshtc107 是 Electron 桌面客户端：本机启动仅受公钥保护的 SSH 服务，将 shell/exec 流量桥接到 USTC 107 平台 WSS。默认连接方式为：

```bash
ssh -o StrictHostKeyChecking=accept-new -i ~/.ssh/usshtc107_ed25519 -p 3000 user@127.0.0.1
```

不要在代码、界面或文档中加入 `StrictHostKeyChecking=no`、`UserKnownHostsFile=/dev/null`、TLS 校验关闭或密码认证降级。

## 模块边界

```text
electron/main.js                 Electron 生命周期、窗口、IPC、托盘、状态整合
electron/proxy-server.js         TCP/SSH/WSS 生命周期、认证、桥接与资源上限
electron/settings-store.js       设置 schema、公开 DTO、原子 JSON 写入
electron/credential-store.js     safeStorage、只写密码 API、旧凭据迁移
electron/ssh-key-service.js      稳定客户端 key 和 OpenSSH proxy host key
electron/ssh-config-service.js   受管 SSH 配置块、校验、备份和原子写入
electron/preload.js              contextBridge 白名单
src/                             React 界面、i18n 和 Electron API wrapper
tests/                           Node 核心测试与 Vitest/jsdom 交互测试
```

新增逻辑应放在其所有权模块，避免继续扩大 `main.js`。结构化设置、密钥和 SSH 配置必须走现有 service，不要复制解析或持久化代码。

## 安全不变量

- 主窗口保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- 所有 IPC handler 必须经过 `assertTrustedIpc`，只接受主窗口 main frame 和本地应用 URL。
- 主窗口禁止未知导航、弹窗和 webview；外部 URL 只能通过主进程验证后的 HTTPS IPC 打开。
- 登录窗口使用 `persist:usshtc107-auth` 专用分区，只允许 `107.ustc.edu.cn` 与 `id.ustc.edu.cn`，并拒绝权限请求。
- WSS `rejectUnauthorized` 始终为 `true`；自定义 CA 只能追加信任，不能关闭验证。
- 只有 WSS 握手 HTTP `401/403` 能使 Cookie 失效。WebSocket close code `1008/1011` 和网络错误不能推断认证失效。
- SSH 只接受生成的 Ed25519 客户端公钥，并验证签名。认证配置解析失败时必须 fail closed。
- 不记录 Cookie 值、密码、命令、远端输出或响应正文。所有进入日志 UI/文件的信息仍需经过 `redactLogMessage`。
- 密码绝不返回 renderer。空密码表示保留已保存密码，清除必须使用显式 API。
- 不允许明文或自制加密回退。MD5/XOR 代码仅为旧数据迁移，迁移后必须删除旧值。

## 凭据与设置

- `DEFAULTS` 同时包含公开设置和内部存储字段；renderer 只能收到 `publicSettings()` 的白名单 DTO。
- `normalizePublicSettings()` 拒绝未知键、换行、控制字符、非法 host、越界端口和终端尺寸。
- `CredentialStore` 在 Linux 上把 `basic_text`/`unknown` backend 视为不可用。此时 Cookie 仅驻留内存，密码保存失败并由 UI 提示。
- `SettingsStore` 使用 0600 临时文件、fsync 和 rename；损坏 JSON 会备份后恢复默认值。
- 修改公开设置时保留内部字段，不能用 renderer payload 覆盖整个持久化对象。

## SSH 密钥与配置

- 客户端私钥位于 `~/.ssh/usshtc107_ed25519`，公钥原始 32 字节用于本地代理授权。
- proxy host key 位于 Electron userData，必须是 `ssh2` 可解析的 OpenSSH Ed25519 私钥并跨重启稳定。
- 旧版 PKCS#8 proxy host key 只在确认为 Ed25519 时迁移；其他损坏或异类 key 必须拒绝。
- SSH Config 值使用严格 token/host/integer 校验，路径需正确引用，禁止 `ProxyCommand` 或换行注入。
- 只管理 `# BEGIN usshtc107 managed` 到 `# END usshtc107 managed`，保留其他用户配置，写前备份 `config.usshtc107.bak`。
- 生成配置使用 `IdentitiesOnly yes` 和 `StrictHostKeyChecking accept-new`。

## 代理生命周期

- `ProxyServer.start()`/`stop()` 通过串行 lifecycle promise 协调；必须支持 start 中 stop、stop 中 restart 和幂等调用。
- 原始 TCP socket 在 SSH 握手完成前受握手超时约束，之后使用 idle timeout；所有 socket/channel/timer 必须在 stop 时释放。
- 连接、会话、WSS payload、pending input、exec output 和 `bufferedAmount` 都有常量上限。
- TCP 到 WSS 与 WSS 到 SSH 两个方向都需背压。不得通过无界数组或字符串累积绕过限制。
- 一个会话断开只能关闭自己的 channel/WSS，不能结束共享 SSH client 上的其他 channel。
- exec 通过交互式 shell 和唯一 DONE marker 模拟；命令本身不进入日志。超时返回 124，输出超限返回 125，断连返回 255，未知失败不能返回 0。

## 登录与状态

1. 创建隔离登录窗口并加载平台 HTTPS URL。
2. 平台页可自动点击认证按钮；只有安全存储中有密码时才在 CAS 页自动填充。
3. CAS 完成后进入平台 shell 页面，读取专用 session 的平台 Cookie。
4. 先保存/缓存 Cookie 并关闭登录窗口，再启动代理。
5. Cookie 删除时清理加密持久化并停止现有代理会话。

`state` 只能包含可结构化克隆的数据。timer、socket、BrowserWindow、ProxyServer 等句柄保留在模块变量或类实例中。

## 前端约定

- 所有用户可见文案必须走 `t()`，新增 key 同时补 `en.js` 和 `zh.js`。
- 图标使用 `src/components/Icons.jsx`；不要用 emoji 代替工具图标。
- 表单 label 关联 `htmlFor/id`，按钮有明确 type，异步动作提供 pending/error/retry 状态。
- destructive action 需要确认，设置脏数据离开前需要提醒。
- 订阅 Electron event 的 effect 必须返回 unsubscribe，定时器也必须清理。
- renderer 日志最多保留 500 条，动态内容不能造成布局跳动或文本覆盖。
- 密码输入始终为空；已有密码只显示布尔状态，不得写回 DOM 或组件 state。

## 验证与发布

```bash
npm run check:electron
npm test
npm run test:coverage
npm run build
npm run package:smoke
npm audit
```

CI 使用 Node 22 LTS（最低 22.12）和 npm 11.18.0，执行语法检查、覆盖率、生产依赖审计和 Linux 打包冒烟。依赖安装脚本通过 `allowScripts` 明确批准或拒绝，并在 CI/发布中启用严格模式；修改相关版本时同步审核该列表。

electron-builder 的 `npmRebuild` 保持关闭，避免打包阶段绕过 `allowScripts` 重编译被拒绝的可选原生依赖。若新增必需的 Electron 原生运行时依赖，必须同时重新评估此设置、脚本白名单和各平台产物测试。

macOS 和 Windows 在 electron-builder 中启用 `forceCodeSigning`；发布工作流还验证签名、公证、tag/version 一致性，生成产物 checksum 和 provenance attestation，并为实际生产依赖生成 CycloneDX SBOM。不得为了让 CI 通过而关闭签名或公证。

## 代码修改检查表

- 是否新增了秘密、远端内容或用户输入日志？
- 是否扩大了 renderer、登录窗口、IPC 或 shell 的权限边界？
- 是否为并发 start/stop、失败和资源上限添加了测试？
- 是否保持设置与 SSH config 的原子写入及用户数据备份？
- 是否在中英文、键盘操作、加载/空/错误状态中行为一致？
- 是否运行了与改动风险相匹配的测试、构建和打包验证？
