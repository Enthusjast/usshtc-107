# CLAUDE.md

## 项目概述

usshtc107 是一个 Electron 桌面客户端，用于将本地 SSH 工具桥接到中国科学技术大学 107 算力平台。
用户通过 SSO 登录后，本机启动 TCP 代理（默认 127.0.0.1:3000），将 SSH 流量经 WebSocket 转发到算力平台。

**核心目标**: `ssh -p 3000 user@127.0.0.1` 直连算力平台运行 Claude Code 等工具。

## 架构

```
Main Process (Electron)              Renderer (React + Vite)
├── main.js                           ├── App.jsx
│   ├── 窗口管理 (mainWindow + loginWindow)   │   ├── Sidebar
│   ├── Cookie 提取与监控               │   ├── DashboardView
│   ├── IPC handlers (settings/sessions/stats/ssh-config/theme)  │   ├── SessionsView
│   ├── 系统托盘 (Tray)                 │   ├── LogsView
│   └── 自动连接 (tryAutoConnect)        │   └── SettingsView
├── proxy-server.js                   ├── components/
│   ├── SSH Server (ssh2)              │   ├── ErrorBoundary
│   ├── WebSocket Client (ws)          │   ├── Icons (SVG, Lucide-style)
│   ├── 双向桥接 (TCP ↔ WSS)           │   ├── Sidebar
│   ├── 会话追踪 (Session)             │   └── Toast
│   └── 流量统计                        ├── contexts/ThemeContext.jsx
├── preload.js (contextBridge)        ├── i18n/LocaleContext.jsx + en.js/zh.js
└── constants.js                       └── lib/electron.js + format.js
```

## 关键技术细节

### 代理服务器 (proxy-server.js)
- 使用 ssh2 的 `Server.injectSocket()` 将 TCP socket 注入 SSH 服务器
- RSA 2048 主机密钥在模块级别缓存（`ProxyServer._hostKey`），避免重启时密钥变化
- JSON WebSocket 协议：消息格式为 `{ "$case": "data", "data": { "data": "<text>" } }`
- `session_ended` 检测：`exit` / `close` / `logout`
- Ctrl+D（0x04 字节）检测：仅当数据长度为 1 且值为 0x04 时触发
- Session 类追踪：id, remoteAddress, connectedAt, bytesSent, bytesReceived, _sshClient
- `disconnectSession()` 通过 session._sshClient 精准关闭，不误杀其他连接
- `_starting` 标志防并发
- `AUTH_CLOSE_CODES = [1008, 1011]`（不含 1006 异常断开，避免网络抖动误判）

### 登录流程
1. 打开 loginWindow → 加载 107.ustc.edu.cn
2. `setWindowOpenHandler` 用 `new URL()` 做 hostname 精确匹配（非子串）
3. 双阶段检测：SSO 认证完成 → `sso_done` → 用户导航到 Web SSH 终端 → `success`
4. Cookie 提取后**先关闭登录窗口**，再 `await startProxyServer()`（避免卡窗口）

### 状态管理
- 主进程维护全局 `state` 对象
- 渲染进程通过 IPC 事件接收状态更新（`login-status`, `proxy-status`, `cookie-status`, `stats-update`, `session-update`, `theme-changed`）
- 所有事件订阅返回 unsubscribe 函数

### 设置持久化
- `app.getPath('userData')/settings.json`
- 默认值定义在 `electron/constants.js` 的 `DEFAULTS`
- IPC `settings:save` 使用白名单过滤（`ALLOWED` keys from DEFAULTS）
- `useRoot` 在前端 select 发字符串，主进程归一化为 boolean

### 国际化
- `src/i18n/LocaleContext.jsx` — React Context，`t(key, ...args)` 翻译函数
- 支持点路径（`parent.child`）和函数参数（`t('nCookies', 3) → "3 个 Cookie"`）
- 优先级：当前语言 → 英文回退 → key 本身
- 语言持久化在 localStorage

## 开发命令

```bash
npm run dev           # Vite :5173 + Electron 同步启动
npm run build         # 构建前端到 dist/
npm start             # 生产模式启动 Electron
npm run dist:linux    # 打包 Linux (AppImage + deb)
npm run dist:mac      # 打包 macOS (dmg)
npm run dist:win      # 打包 Windows (NSIS)
```

## 代码规范

- **不要用 emoji 作图标** — 全部使用 `src/components/Icons.jsx` 中的 SVG 组件
- **所有用户可见字符串必须走 i18n** — `t('key')`，禁止硬编码
- **表单 label 必须有 htmlFor** — 对应 input/select 的 id
- **可点击的非 button 元素必须有** `role="button" tabIndex="0" onKeyDown`
- **useEffect 依赖数组必须完整** — 包含所有引用的外部变量
- **新的格式化函数放到 `src/lib/format.js`** — 不要在视图文件中重复定义
- **主进程 event handler 用 `event.preventDefault()` 模式** — Electron 不等待 async handler
- **IPC 设置 key 必须在 `DEFAULTS` 白名单中**

## 已知注意事项

- `before-quit` 用 `event.preventDefault()` + `stopProxyServer().finally(() => app.exit(0))` 模式
- Tray 图标通过纯 JS PNG 生成器创建（`createTrayIcon`），依赖 zlib 和自实现 CRC32
- 前端 `useRoot` 默认值是 boolean `false`，但 `<select>` 发字符串 `'true'/'false'`，主进程 `settings:save` 中归一化
- `exitApp` 通过 preload 暴露但当前无组件调用（保留以备将来 UI 退出按钮使用）
- 登录窗口 `sandbox: true`，无 preload
- 主窗口 `contextIsolation: true`, `nodeIntegration: false`
