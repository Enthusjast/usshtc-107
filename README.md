# usshtc107

USTC 算力平台 SSH 代理客户端 — 将本地 SSH 工具通过 WebSocket 桥接到中国科学技术大学 107 算力平台。

```bash
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2222 user@127.0.0.1
```

## 功能

- **SSO 自动登录** — 内嵌浏览器完成学校统一认证，自动提取鉴权 Cookie
- **TCP ↔ WebSocket 桥接** — 本地 SSH 服务器（ssh2）将标准 SSH 流量实时转发到平台 WSS
- **实时仪表盘** — 连接数、Cookie 状态、流量统计（上行/下行字节数、运行时长）
- **会话管理** — 查看所有活跃 SSH 会话，支持逐会话强制断开
- **系统托盘** — 关闭窗口时最小化到托盘，代理持续在后台运行
- **自启动连接** — 启动时自动检测有效 Cookie 并启动代理（可配置）
- **SSH Config 生成** — 一键写入 `~/.ssh/config`，随后只需 `ssh ustc107`
- **中英文切换** — 完整 i18n 覆盖，支持中/英一键切换
- **暗色/亮色主题** — OLED 暗色主题默认，可切换亮色
- **设置持久化** — 端口、集群、终端行列数等配置重启不丢失

## 架构

```
┌───────────────── Electron ─────────────────┐
│  ┌── Main Process ──────────────────────┐  │
│  │  main.js      窗口管理 · Cookie 监听 · IPC · 托盘   │
│  │  proxy-server.js  TCP(ssh2) ↔ WSS(ws) 桥接        │
│  │  preload.js    contextBridge 安全 IPC 暴露  │
│  │  constants.js  共享配置常量              │
│  └───────────────────────────────────────┘  │
│  ┌── Renderer (React + Vite) ───────────┐  │
│  │  Dashboard  ·  Sessions  ·  Logs  ·  Settings │
│  │  TailwindCSS v4 · Inter 字体 · SVG 图标  │
│  └───────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

## 技术栈

| 层 | 技术 |
|---|------|
| 框架 | Electron 35 |
| 前端 | React 19 + Vite 6 + TailwindCSS 4 |
| SSH 服务端 | ssh2 |
| WebSocket 客户端 | ws |
| 构建 | electron-builder |
| 日志 | electron-log |

## 开发

```bash
# 安装依赖
npm install

# 开发模式（Vite HMR + Electron 热重载）
npm run dev

# 仅构建前端
npm run build

# 启动 Electron（需先 build）
npm start
```

## 打包

```bash
npm run dist:linux   # AppImage + deb
npm run dist:mac     # dmg
npm run dist:win     # NSIS installer
```

构建产物在 `release/` 目录。

## 使用

1. 启动应用 → 点击 **Login** 打开 SSO 认证窗口
2. 完成学校统一认证后，导航到 **Web SSH** 页面
3. Cookie 自动提取 → 代理服务自动启动
4. 在终端执行 SSH 命令连接：

```bash
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2222 user@127.0.0.1
```

也可在 Settings → SSH Config 中生成 `~/.ssh/config` 条目，之后直接：

```bash
ssh ustc107
```

## 配置

| 设置 | 默认值 | 说明 |
|------|--------|------|
| Host | 127.0.0.1 | 代理监听地址 |
| Port | 2222 | 代理监听端口 |
| Cluster | training | 算力平台集群 |
| Login Node | 11.11.10.202 | 登录节点 IP |
| Cols / Rows | 80 / 24 | 终端行列数 |
| Auto-connect | 开启 | 启动时自动连接 |
| Start minimized | 关闭 | 启动时最小化到托盘 |

## 目录结构

```
usshtc107/
├── electron/
│   ├── main.js            # Electron 主进程
│   ├── proxy-server.js    # TCP ↔ WSS 代理核心
│   ├── preload.js         # contextBridge 安全桥接
│   └── constants.js       # 共享常量与默认配置
├── src/
│   ├── App.jsx            # 根组件 + 路由
│   ├── main.jsx           # React 入口
│   ├── index.css          # 全局样式 + 主题变量
│   ├── components/        # ErrorBoundary, Icons, Sidebar, Toast
│   ├── contexts/          # ThemeContext
│   ├── i18n/              # LocaleContext + en/zh 翻译字典
│   ├── lib/               # electron API 封装 + format 工具
│   └── views/             # Dashboard, Sessions, Logs, Settings
├── build/                 # 应用图标
├── index.html             # Vite HTML 入口
├── vite.config.js
├── electron-builder.yml   # 打包配置
└── package.json
```

## License

MIT
