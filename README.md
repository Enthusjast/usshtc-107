# usshtc107

USTC 算力平台 SSH 代理客户端，将本地 SSH 工具通过加密 WebSocket 桥接到中国科学技术大学 107 算力平台。

```bash
ssh -o StrictHostKeyChecking=accept-new -i ~/.ssh/usshtc107_ed25519 -p 3000 user@127.0.0.1
```

## 功能

- **SSO 登录**：在隔离的登录窗口中完成学校统一认证，可选安全凭据自动填充。
- **TCP 到 WSS 桥接**：本地 SSH 服务通过验证 TLS 证书的 WSS 连接访问平台。
- **SSH 公钥认证**：首次启动生成独立客户端密钥，代理拒绝密码和未知公钥。
- **Exec 命令支持**：支持 `ssh host 'command'`，并对超时与输出大小设限。
- **实时仪表盘**：显示代理、Cookie、流量、运行时间和连接数量。
- **会话与日志管理**：可查看和断开单个会话；内存日志限制为最近 500 条。
- **系统托盘与自动连接**：关闭主窗口后代理可继续运行，并可在启动时恢复连接。
- **SSH Config 管理**：原子更新受管配置块，生成前备份现有配置。
- **中英文与明暗主题**：界面、托盘菜单和状态提示支持中英文。

## 安装与开发

要求 Node.js 22.12 或更高版本、npm 11.18.0 或更高版本。

```bash
npm ci
npm run dev
```

常用检查：

```bash
npm test                 # Node 核心测试 + React 交互测试
npm run test:coverage    # 带覆盖率门槛
npm run check            # 语法、测试和生产构建
npm run package:smoke    # Linux unpacked 打包冒烟
```

## 使用

### 首次登录

1. 打开 **Settings -> SSO Auto Login**。
2. 如果系统安全存储可用，可保存学号和密码用于自动填充；也可以留空并在登录窗口手动输入。
3. 点击 **Login**，完成统一认证并进入 Web SSH 页面。
4. 应用取得当前会话 Cookie 后启动本地代理。

Linux 上若 Electron 只能使用 `basic_text` 后端，应用会把它视为不安全：不会持久化密码，Cookie 仅在本次运行中保留。配置系统密钥环后可恢复安全持久化。

### SSH 连接

推荐在 **Settings -> SSH Config** 生成配置，然后使用：

```bash
ssh usshtc107
```

也可直接连接：

```bash
ssh -o StrictHostKeyChecking=accept-new \
  -i ~/.ssh/usshtc107_ed25519 \
  -p 3000 user@127.0.0.1
```

`accept-new` 会在首次连接时记录代理主机密钥，后续密钥变化将触发 SSH 警告。不要删除 `known_hosts` 条目来绕过意外变化；先确认 Electron 用户数据目录中的代理主机密钥是否被重置。

### 远程命令

```bash
ssh usshtc107 'ls -la'
ssh usshtc107 'cd /path && make build'
```

## 配置与数据安全

| 设置 | 默认值 | 说明 |
|---|---:|---|
| Host | `127.0.0.1` | 本地代理监听地址 |
| Port | `3000` | 本地代理监听端口 |
| Cluster | `training` | 平台集群 |
| Login Node | `11.11.10.202` | 登录节点 |
| Cols / Rows | `80 / 24` | 远程终端尺寸 |
| Auto-connect | 开启 | 启动时尝试恢复代理 |
| Start minimized | 关闭 | 启动后只显示托盘图标 |
| SSH Alias | `usshtc107` | 生成的 SSH Host 别名 |

- 设置文件使用私有权限和原子替换写入。
- SSO 密码和 Cookie 只通过 Electron `safeStorage` 加密持久化，不存在明文或 XOR 降级。
- 旧版明文 Cookie 和 XOR 密码只用于一次性迁移；无法安全迁移时会被删除。
- 密码不会返回渲染进程，日志也不会记录 Cookie 值、命令或远端输出。
- 登录窗口使用专用持久分区，只允许平台和 USTC CAS 的 HTTPS 导航，并拒绝权限请求。
- WSS 始终验证服务端证书；代理对连接数、会话数、缓冲区、负载和超时设置上限。
- `~/.ssh/config` 只替换 `# BEGIN/END usshtc107 managed` 区块，写入前备份到 `~/.ssh/config.usshtc107.bak`。

Windows 若端口被 Hyper-V/WSL 预留，可在管理员 PowerShell 中运行：

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

然后在 Settings 中选择未被预留的端口。

## 打包与发布

```bash
npm run dist:linux
npm run dist:mac
npm run dist:win
```

Linux 可直接本地打包。项目使用 npm 11.18.0 的依赖安装脚本白名单；发布和 CI 会固定该版本并在严格模式下安装。macOS 和 Windows 配置了强制代码签名，缺少证书时会失败，以避免发布未签名安装包。

GitHub Actions 发布需要以下仓库 Secrets：

| 平台 | Secrets |
|---|---|
| macOS | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` |
| Windows | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` |

`MAC_CSC_LINK` 和 `WIN_CSC_LINK` 可使用 electron-builder 支持的 base64 证书值。`APPLE_API_KEY_BASE64` 是 App Store Connect `.p8` 私钥的 base64 内容。用于签名或发布的标签必须严格等于 `v<package.json version>`，例如当前版本使用 `v1.2.1`，且标签提交必须属于默认分支历史。应在仓库设置中保护 `v*` 标签。

发布流水线会验证签名和 macOS 公证，生成产物 SHA-256 校验文件和 GitHub 构建来源证明，并为实际生产依赖生成 CycloneDX SBOM。普通手动构建可以选择单个平台；Linux 可从功能分支构建，使用证书的 macOS/Windows 构建只能从默认分支或匹配版本的标签发起。创建 GitHub Release 时必须构建全部平台。

## 架构

```text
electron/
  main.js                 窗口、登录、IPC、托盘与生命周期
  proxy-server.js         SSH 到 WSS 桥接、会话和资源限制
  credential-store.js     safeStorage 凭据与旧数据迁移
  settings-store.js       设置校验和原子持久化
  ssh-key-service.js      客户端与代理主机密钥
  ssh-config-service.js   受管 SSH Config 写入与备份
  preload.js              最小化 IPC API
src/
  components/             通用界面组件
  views/                  Dashboard、Sessions、Logs、Settings
  i18n/                   中英文资源和 Locale Context
tests/                    核心代理、安全服务和前端交互测试
```

技术栈为 Electron 43、React 19、Vite 6、Tailwind CSS 4、ssh2、ws 和 electron-builder。

## License

MIT
