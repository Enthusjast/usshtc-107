# usshtc107

USTC 算力平台 SSH 代理客户端，将本地 SSH 工具通过加密 WebSocket 桥接到中国科学技术大学 107 算力平台。

```bash
ssh -o StrictHostKeyChecking=accept-new -i ~/.ssh/usshtc107_ed25519 -p 3000 user@127.0.0.1
```

## 功能

- **SSO 登录**：在隔离的登录窗口中完成学校统一认证，可选安全凭据自动填充。
- **TCP 到 WSS 桥接**：本地 SSH 服务通过验证 TLS 证书的 WSS 连接访问平台。
- **SSH 公钥认证**：首次启动生成独立客户端密钥，代理拒绝密码和未知公钥。
- **密钥管理**：应用级完整 SSH wire 指纹、机器/OS 账号绑定的加密备份、显式修复与带 journal 的轮换；替换不会修改 known_hosts 或放宽 SSH 校验。
- **Exec 命令支持**：支持 `ssh host 'command'`，并对超时与输出大小设限。
- **实时仪表盘**：显示实际运行配置、流量和 B/s；统一采样驱动最近 60 秒速率趋势，会话表格持续更新而不依赖新开 channel。
- **会话与日志管理**：可查看和断开单个会话；Active/History 分页提供当前档案的 7/30 天历史与 UTC 日汇总，内存日志限制为最近 500 条。
- **系统托盘与用户偏好**：关闭窗口后代理可继续运行；自启动必须用户主动开启，四类系统通知及断网/休眠恢复分别可控，实际 OS 注册状态与档案自动连接意图分开显示。
- **SSH Config 管理**：原子更新受管配置块，生成前备份现有配置。
- **连接诊断与安全导出**：依次检查保存设置、既有密钥、受管配置、本地监听、DNS、TLS 和 WSS；日志支持纯文本/级别/来源/UTC 时间筛选及匹配结果复制、JSON 导出。
- **首次使用向导**：按档案保存登录、SSH Config、连接和验证进度；支持跳过与继续，完成状态由主进程复验，不把端口空闲或单纯的 WebSocket 升级当作远端命令成功。
- **安全更新**：全局提示新版本，下载与安装分别由用户触发；安装前复核缓存和平台签名要求，取消或准备失败不退出应用。
- **中英文与明暗主题**：界面、托盘菜单和状态提示支持中英文。

## 安装与开发

要求 Node.js 22.12 或更高版本和 npm 11.18.0；CI 固定 npm 11.18.0。

```bash
NPM_CONFIG_STRICT_ALLOW_SCRIPTS=true npm ci
node node_modules/electron/install.js
npm run dev
```

常用检查：

```bash
npm test                 # Node 核心测试 + React 交互测试
npm run test:coverage    # 带覆盖率门槛
npm run check            # 语法、测试和生产构建
npm run package:smoke    # Linux unpacked 打包冒烟
npm audit --audit-level=high # 包含 Electron 与开发工具的完整依赖审计
```

Electron 二进制通过包内安装器显式供应，并使用包内 checksum 校验；不要设置远端 checksum 绕过变量。Node 测试入口递归枚举 `tests/**/*.test.js`（含 `main-services` 和 `integration`），JSX 测试由 Vitest 执行；语法入口逐一检查 `electron/*.js` 和 `shared/*.mjs`。安装脚本仅批准 `esbuild@0.25.12`，打包保持 `npmRebuild: false`。

### 桌面运行验收

先执行 `npm run build`，再运行 `npm run test:electron`。Linux 使用 `xvfb-run -a npm run test:electron`；Windows/macOS 不需要 Xvfb。Linux/macOS 的真实 PTY 测试需 Python 3，SSH 配置语义验证需系统 `ssh`/`ssh-keygen`。

包烟必须传已存在、与本机架构匹配的绝对可执行文件路径，不会回退 source：

```bash
APP_EXECUTABLE=/absolute/path/to/linux-unpacked/usshtc107 \
  xvfb-run -a npm run test:electron:packaged
```

Windows PowerShell 先设置 `$env:APP_EXECUTABLE='C:\absolute\win-unpacked\usshtc107.exe'` 再运行 `npm run test:electron:packaged`；macOS 使用 `.app/Contents/MacOS/usshtc107` 的绝对路径，只验收当前主机架构。真实 AppImage 在无 FUSE 时可使用 `APPIMAGE_EXTRACT_AND_RUN=1`；由镜像 runtime 自行设置 APPIMAGE/APPDIR，不手工伪造。解包 deb 的验收额外设置 `APP_EXPECTED_UPDATE_MODE=manual`，该变量仅定义测试预期，不改变产品行为。

source 与 packaged 项目均使用私有 HOME/userData/sessionData/logs/SSH/XDG 目录、关闭自动连接/更新/自启动，并在主进程实查实际路径。测试侧拒绝外网；source 只使用固定本地 TLS/WSS 与隔离 CAS fixture，不代表真实学校登录、OS 密钥环或签名升级证据。packaged 不注入生产测试入口。沙箱保持开启；截图和原生上下文 trace 保存在 `test-results/`，CI 按平台分别保留。

公开设置的默认值与校验由 `shared/settings-schema.mjs` 统一，renderer 校验仅供交互提示，主进程再次权威验证。IPC 成功响应为 `{ok:true,value}`，业务失败为 `{ok:false,error:{code,fieldErrors?}}`；取消操作是成功的 `{cancelled:true}` 值。前端只显示固定错误码的本地化文案，不显示主进程异常正文；缺少桌面 runtime/API 的动作会明确失败，不再静默成功。

## 使用

### 首次使用与登录

全新安装和新档案会进入临时向导；旧设置迁移不会强制打开。没有凭据不等于新用户，已完成的档案也不会因 Cookie 过期再次进入向导。

1. 点击 **Login**，在隔离登录窗口中手动完成统一认证并进入 Web SSH 页面。向导不要求也不保存密码；需要自动填充时，可在 Settings 的 SSO 区域另行主动保存。
2. 预览当前档案已保存设置的 SSH 受管配置块，检查后主动生成；已有配置匹配时可直接继续。向导不会自动改写文件。
3. 启动代理；运行参数与保存参数不一致时，使用 **Restart and apply**，确认后才中断现有连接。
4. 运行诊断。只有当前 scope/保存配置下的本地 SSH 公钥认证、受管配置现场匹配、运行配置一致和平台 WSS 握手均满足条件，主进程才保存完成状态。诊断不发送远端命令，也不证明平台应用已授权。

**Back/Next** 保存当前步骤；**Skip for now** 保留步骤并记为已跳过，之后可从 Dashboard 或 Settings 的 **Resume setup** 继续。取消或失败不伪造完成状态。连接设置保存后，旧诊断立即失效，需重新验证；向导不会开启 OS 自启动或修改通知偏好。

Linux 上若 Electron 只能使用 `basic_text` 后端，应用会把它视为不安全：不会持久化密码，Cookie 仅在本次运行中保留。配置系统密钥环后可恢复安全持久化。

### SSH 连接

推荐在 **Settings -> SSH Config** 先预览当前档案已保存设置的受管块，再明确生成，然后使用：

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

Exec 需要远端提供 POSIX `sh`、`stty` 和 `base64 -d`；缺失工具或协议不兼容会明确失败，不回退到提示符猜测或输出裁剪。命令通过 READY 后的 base64 帧提交，输出逐字节保留空格、换行和终端控制字节；远端 stderr 合并到 stdout，SSH stderr 只用于固定本地诊断。Exec 的 stdin 为 `/dev/null`，非空 SSH stdin 会被拒绝；关闭 SSH stdin 不取消命令输出。超时、资源超限和 END 前断连分别返回 124、125 和 255。

交互会话按 channel 独立解码 UTF-8，并转发初始 PTY 尺寸和窗口变化。交互 EOF 在待发送输入排空后发送 disconnect，再进行有期限的输出排空，不承诺远端原生半关闭语义。PKCS#8 主机密钥迁移和诊断所用客户端内存格式转换保留同一个 Ed25519 身份；指纹为完整 SSH 公钥 wire blob 的 SHA-256。

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

- 单个 v2 设置根文档管理最多 8 个档案，包含全局偏好、当前档案、档案连接设置与独立秘密；没有第二套 ProfileStore。档案别名大小写不敏感且唯一，新档案不会复制凭据；同一时间只运行一个代理，SSH 密钥为应用共享。
- 设置文件最多 1 MiB；临时文件在 fsync/rename 前设置 0600，POSIX 在 rename 后同步父目录。写入已替换但持久性不确定、或无法确定提交结果时，应用停止监听并锁定写入/登录/启动，需“重新加载设置”验证一致且耐久后解除，不盲目回滚磁盘。
- 未来 schema、引用错误、超限和无效结构保留源文件，只提供只读、无秘密的默认 DTO。损坏 JSON 使用私有备份，恢复默认根前需要明确确认；不会把 fallback 默认值自动覆盖到未知文档。
- SSO 密码和 Cookie 只通过 Electron `safeStorage` 加密持久化，不存在明文或 XOR 降级。迁移在候选根中完成，保留有效但当前无法解密的密文；旧明文 Cookie 无安全存储时仅留当前进程，旧 XOR 不再落盘，迁移失败不制作含原始秘密的备份。
- 密码不会返回渲染进程，日志也不会记录 Cookie 值、命令或远端输出。空密码保留已保存值，清除走显式 API。
- 登录窗口使用唯一专用持久分区，只允许平台和 USTC CAS HTTPS 导航并拒绝权限请求。切换档案先停止旧代理、撤销浏览器归属并完成分区清理，再原子选择目标并绑定目标凭据；普通切换不删除旧档案保存的 Cookie，迟到结果不能借给新档案。
- WSS 始终验证服务端证书；代理对连接数、会话数、缓冲区、负载和超时设置上限。
- `~/.ssh/config` 只替换 `# BEGIN/END usshtc107 managed` 区块；受管 Host 前置、块末用 `Host *` 重置上下文，保留其余原始字节（包括 BOM、CRLF 和无末尾换行），写前备份原始字节到 `~/.ssh/config.usshtc107.bak`。生成绑定预览时的源文件 hash 与档案配置 hash；源或保存设置变化必须重新预览，非法 UTF-8、异常标记、符号链接和未受管同名别名拒绝写入。
- 切档案不自动改写 SSH Config，旧别名仍连接本地当前活跃代理。`IdentityFile` 可以累加，`Include`、`Match` 和用户代理规则仍可能影响附加行为；前置块不清除所有用户规则。应用不对真实用户配置运行 `ssh -G`，避免 `Match exec` 执行用户命令；仅受控测试 fixture 使用该命令。

会话历史保存在私有 `session-history.json`，仅记录运行唯一 ID、档案 ID、shell/exec 类型、起止时间、字节总数、退出码和固定原因；不保存命令、输出、用户名或远端地址。最多保留 1000 条、30 天且文件不超过 1 MiB，活动摘要合并写入、关闭立即写入，启动时未完成记录标为 interrupted。历史持久化失败只显示可重试错误，不中断健康 SSH。清空历史需要原生确认，并先停止、最终化当前档案会话；取消保留连接与草稿。删除档案也删除其历史。

Diagnostics 每项最多 5 秒、整体最多 30 秒，可取消；保存相关配置（包括同值重存）、切档案和退出都会使旧结果失效。代理运行时仅使用应用实际客户端密钥和固定主机指纹完成本地 SSH 认证，不发命令；停止时的 bind-only 只证明端口可绑定。`WSS_HANDSHAKE_OK` 仅证明验证 TLS 后 HTTP 升级成功，不证明远端应用授权或命令可执行；只有握手 HTTP 401/403 会撤销当前 Cookie。

日志筛选是大小写不敏感的纯文本匹配，不执行正则。复制和日志 JSON 导出只包含当前匹配项（ISO 时间、级别、来源和脱敏消息）；诊断包则明确包含当前最多 500 条安全日志，不受筛选影响。诊断包为单个 JSON，只含版本/架构、公开连接设置、诊断状态和再次脱敏的日志，替换 HOME/USERDATA 路径；总量最多 8 MiB，必要时逐条裁剪最旧完整日志并记录数量。不会读取原始设置、日志文件或私钥打包，也不包含账号、Cookie、密文、命令或远端输出。保存位置由原生对话框选择，取消不写文件。

密钥在所有档案间共享：客户端私钥仍位于 `~/.ssh/usshtc107_ed25519`，主机私钥位于 userData 的 `proxy_host_ed25519`。已初始化身份缺失、损坏或意外变更时不会静默重建；Settings 的密钥面板独立提供状态、完整 SHA256 指纹和恢复步骤，读取失败不影响其他设置。

备份只使用同一 `safeStorage` 后端，格式为 `usshtc107-key-backup` schema 1；私钥明文不跨 IPC、不进 DOM/日志。备份绑定原机器、OS 账号及安全存储环境，不保证可迁移，即使硬件相同，丢失原 OS 密钥环也可能无法解密；无安全后端时不提供明文或自制加密回退。导入先限长、解密、验证实际 Ed25519 私钥并派生指纹，不信任文件内路径或指纹元数据。

Rotate 替换选中的可用身份前必须成功导出加密备份；原生确认或备份保存取消都不改变密钥、监听或草稿。Rebuild 是明确修复：只重建选中的非 ready 身份，选中的 ready 身份逐字节保留；缺失、无效或意外变更身份的旧材料不会被假称已备份，原生确认会提示不可恢复的材料风险。主机变更确认显示实际旧/新指纹及 SSH 信任后果。

替换用 0600、fsync 的 stage/rollback 文件和根 journal 协调 prepared/installed/committed；候选监听绑定后拒绝 TCP/SSH，只有新指纹与 committed 阶段同一次根提交且确认耐久后才接纳连接。未知文件 hash/缺失回滚材料会锁定 `KEY_ROLLBACK_FAILED` 并保留材料；根已实际 committed 时绝不回滚为旧私钥。遇到事务或持久性错误，保留现有密钥和事务文件，修正源问题后用“Retry key recovery”重新加载/恢复，必要时重启，不用重建覆盖未解决 journal。

自启动仅支持已安装/打包应用，开发和 unpacked 运行明确显示不支持，读取状态不会自动注册。Windows 按同一路径、参数和本应用 launch-item 的实际 enabled 状态读取；macOS 如需 Login Items 批准会如实显示，不能把登录启动来源当作已启用。Linux 只管理用户 XDG autostart 下带 `X-usshtc107-Managed=true` 的文件，不覆盖同名他人文件；Exec 不使用 shell，并按 freedesktop 规则转义。先更改 OS 状态再保存偏好，保存失败会恢复原 OS 状态；SSO/自动连接仍由当前档案独立控制。

恢复遵循 `desiredRunning`：用户 Start/Restart/Login 请求连接，Stop 取消意图；后台检查不改变意图。自动恢复开关关闭会中止探测和 timer，不停止健康 SSH；显式 Retry 仍可执行一轮。退避间隔固定为 1/2/4/8/16/30 秒、最多六次，每次 WSS 握手最多 5 秒；证书、配置、端口和凭据错误不会无限自动重试。只有监听已确实停止且仍有连接意图才启动代理，已有健康监听/会话不重启；停止、切档案、认证撤销、退出和安装准备使旧回调失效。恢复后的旧 SSH 连接需客户端重连，不重放 exec、不重建 channel；可以自行使用 tmux，应用不会自动执行它。

新会话、认证失效、网络恢复、更新通知各有独立开关，默认开启；系统通知不含账号、Cookie、命令或远端输出，认证/恢复通知按状态边沿去重。

Windows 若端口被 Hyper-V/WSL 预留，可在管理员 PowerShell 中运行：

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

然后在 Settings 中选择未被预留的端口。

## 安全更新

更新源固定为公开 HTTPS GitHub 仓库 `Enthusjast/usshtc-107` 的稳定发布，不接收 renderer feed URL 或访问 token。启用“自动检查更新”后，在应用 ready 30 秒后检查，此后每 24 小时检查；关闭会取消尚未开始的自动检查，手动 **Check now** 仍可使用。自动检查只提示，不下载、不停止 SSH；普通退出也绝不自动安装。

在任意页面可通过全局提示进入 **Settings -> Updates**。先主动 **Download update**，缓存验证后再主动 **Install and restart**。有连接或未保存内容时统一请求原生确认；取消保留连接和草稿。确认后才取消恢复、停止代理并 flush；准备失败保留窗口，不调用退出协调器安装。只有当前安装 intent 的一次性原生退出标记通过主进程复验，才清理草稿/托盘并交接退出。

- **Windows**：下载后和安装前均流式复核 size/SHA512，并再次用系统 Authenticode 检查已下载或缓存的安装包；要求 packaged `app-update.yml` 的非空 publisherName 与有效签名的完整 CN/DN 按配置精确匹配，不能使用子串或跳过缓存命中验签。
- **macOS**：包装层 ZIP 下载完成不代表原生验签。用户确认、stop/flush 和缓存复核后才启动原生 loopback staging，最长 60 秒；只有当前 intent 的原生成功事件可继续安装。平台安装或 staging 失败后，本进程禁止再次安装，需重启应用后重查与复核。
- **Linux**：只有属于当前应用且文件/父目录可写的真实 AppImage 支持应用内安装；保证为 HTTPS + metadata SHA512，不冒充 publisher 签名。安装前预检已启用的 owned XDG 自启动项，镜像改名后仅原子更新其 Desktop Entry 的 Exec；关闭或非本应用管理的条目不改，失败如实报告，不声称旧镜像路径仍有效。
- **deb / 只读 AppImage**：仅检查和打开官方发布页，手动安装；开发及标准 unpacked 构建不自动请求更新，也不伪造 APPIMAGE 或强制开启开发更新。

检查/下载网络失败可重试；`UPDATE_RESTART_REQUIRED` 表示必须先重启应用，不能在当前进程反复调用原生安装器。可观察到的退出前安装错误会保留 UI，但不承诺恢复退出后或外部安装器静默失败。真实签名 N→N+1 升级需要两个不同版本、连续签名身份及目标 OS 的受保护验收；本次不改版本或发布，不能用本地 fixture 或跨编译替代这些证据。

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

`MAC_CSC_LINK` 和 `WIN_CSC_LINK` 可使用 electron-builder 支持的 base64 证书值。`APPLE_API_KEY_BASE64` 是 App Store Connect `.p8` 私钥的 base64 内容。用于签名或发布的标签必须严格等于 `v<package.json version>`，例如当前版本使用 `v1.2.2`，且标签提交必须属于默认分支历史。应在仓库设置中保护 `v*` 标签。

发布流水线会验证签名和 macOS 公证，生成产物 SHA-256 校验文件和 GitHub 构建来源证明，并为实际生产依赖生成 CycloneDX SBOM。普通手动构建可以选择单个平台；Linux 可从功能分支构建，使用证书的 macOS/Windows 构建只能从默认分支或匹配版本的标签发起。创建 GitHub Release 时必须构建全部平台。

所有本地/CI builder 调用显式使用 `--publish never`，只有 release job 发布。macOS 单次构建产出 x64/arm64 DMG 和 ZIP，合并 `latest-mac.yml` 仅引用 ZIP；Windows 保留 exe、exe.blockmap 和 latest.yml，Linux 保留 AppImage、deb 和 latest-linux.yml，AppImage blockmap 位于镜像内。`scripts/verify-update-artifacts.cjs <目录> <win|mac|linux|all>` 在上传/发布前核对最终产物的版本、文件名、size/SHA512 和 blockmap；metadata 与 blockmap 一同进入 checksum 和 provenance，不能删除后再上传。

## 架构

```text
electron/
  main.js                 私有路径、主窗口、trusted IPC、组装与退出协调
  app-controller.js       独占动作、epoch、运行快照和中断确认
  proxy-controller.js     代理实例、串行生命周期和有 scope 的统计
  login-controller.js     隔离登录分区、认证 generation 和 Cookie 查询
  tray-service.js         托盘图标、菜单和受控通知
  autostart-service.js     真实 OS 注册状态与 owned desktop 管理
  recovery-controller.js  意图约束、可取消退避和握手恢复
  update-service.js       固定 provider、候选/缓存、原生安装 intent 与退出标记
  update-security.js      metadata、流式校验及 fail-closed publisher 验签
  proxy-server.js         SSH 到 WSS 桥接、会话和资源限制
  credential-store.js     safeStorage 凭据与旧数据迁移
  settings-store.js       设置校验和原子持久化
  session-history-store.js 注册会话终结、有界历史和失败重试
  diagnostics-service.js  有界连接检查与无命令探测
  diagnostic-export-service.js 脱敏 JSON 和筛选日志导出
  wss-connection.js        统一平台 URL、TLS 和系统追加信任政策
  ssh-key-service.js      客户端与代理主机密钥
  ssh-config-service.js   受管 SSH Config 写入与备份
  preload.js              最小化 IPC API
src/
  components/             通用界面组件
  views/                  Dashboard、Sessions、Logs、Diagnostics、Settings，以及临时 Setup 向导
  i18n/                   中英文资源和 Locale Context
tests/                    核心代理、安全服务和前端交互测试
```

技术栈为 Electron 43、React 19、Vite 6、Tailwind CSS 4、ssh2、ws 和 electron-builder。

运行状态由 `runtime-state` 完整快照发布，renderer 只接收更新的 revision。保存连接设置不会更改已运行的监听地址；运行中的 SSH 命令始终来自 `runningConfig`，设置差异通过“重启并应用”生效。重启、重新登录和退出使用带父窗口、默认取消的异步原生确认；取消保留现有连接与设置草稿，确认后仍复验草稿 revision。

`runningConfig` 保留实例启动时的 hostname 和实际绑定端口；DNS 解析出的 IP 不会伪装成设置变化，也不会让未修改的 `localhost` 配置永久提示重启。`ProxyServer` 的 started 事件仍报告真实绑定地址与端口，临时端口测试不使用请求中的 0 作为运行端口。

每个新 renderer 文档先通过现有 `runtime:get-info` 的只读 `{scope,draftRevision}` 基线，确认严格更大的草稿 revision，再接纳运行快照和启用动作。硬刷新不会把主进程草稿计数归零或关闭健康 SSH；旧文档的确认不能清除新文档的草稿。`RuntimeSnapshot` 字段仍保持不变。

动作的成功回复可能早于最终运行事件。设置页消耗草稿确认前会先刷新权威 scope，再读取保存值；只有读取确实应用且 revision 未变化才清理对应草稿。刷新期间禁用冲突动作，后来发生的编辑或读取失败不会被误判为已清理。

代理只在收到首条有效终端 `data` 帧后发送输入（包括 exec bootstrap 和 resize），空字符串帧也视为就绪。WSS Upgrade 成功不代表远端 shell 可用；连接建立后 10 秒没有终端数据会以 `REMOTE_READY_TIMEOUT` 和退出码 255 结束该会话，保留 Cookie，并提示检查连接或重新登录。只有握手 HTTP 401/403 才会使 Cookie 失效。

隔离运行可传 `--user-data-dir=<绝对路径>`，应用在访问设置、日志和登录 session 前创建私有目录并设置 userData/sessionData/logs；空值或相对路径被拒绝。主进程 fixture 可导入 `startApplication(deps)` 注入本地适配器，不提供 renderer 任意 URL 或凭据注入入口。

## License

MIT
