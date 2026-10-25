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
- **连接诊断与安全导出**：检查设置、密钥、SSH Config、本地监听、DNS/TLS、token、门户 setup、首条终端数据及真实轻量命令；日志支持筛选及脱敏导出。
- **首次使用向导**：按档案保存登录、SSH Config、连接和验证进度；支持跳过与继续，完成状态由主进程复验，不把端口空闲或单纯的 WebSocket 升级当作远端命令成功。
- **安全更新**：全局提示新版本，下载与安装分别由用户触发；安装前复核缓存和平台签名要求，取消或准备失败不退出应用。
- **官方 API 文件传输**：CLI 与 GUI 共用流式下载、服务端协商分块上传、SHA-256 验证、取消和显式覆盖；不再经 SSH/Base64 搬运文件。
- **桌面与应用入口**：列出本人已有桌面/应用；仅在点击后拉起 VNC 或准备 GET 网页连接，由主进程在系统浏览器打开或复制链接，renderer 不接触密码。
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

Electron 二进制通过包内安装器显式供应，并使用包内 checksum 校验；不要设置远端 checksum 绕过变量。Node 测试递归枚举 `tests/**/*.test.js`，JSX 测试由 Vitest 执行；语法入口递归检查 `electron/`、`shared/` 与 `cli/` 下的 JS/MJS/CJS，覆盖率也包含新增 API 子目录。安装脚本仅批准 `esbuild@0.25.12`，打包保持 `npmRebuild: false`。

### 桌面运行验收

先执行 `npm run build`，再运行 `npm run test:electron`。Linux 使用 `xvfb-run -a npm run test:electron`；Windows/macOS 不需要 Xvfb。Linux/macOS 的真实 PTY 测试需 Python 3，SSH 配置语义验证需系统 `ssh`/`ssh-keygen`。

包烟必须传已存在、与本机架构匹配的绝对可执行文件路径，不会回退 source：

```bash
APP_EXECUTABLE=/absolute/path/to/linux-unpacked/usshtc107 \
  xvfb-run -a npm run test:electron:packaged
```

Windows PowerShell 先设置 `$env:APP_EXECUTABLE='C:\absolute\win-unpacked\usshtc107.exe'` 再运行 `npm run test:electron:packaged`；macOS 使用 `.app/Contents/MacOS/usshtc107` 的绝对路径，只验收当前主机架构。真实 AppImage 在无 FUSE 时可使用 `APPIMAGE_EXTRACT_AND_RUN=1`；由镜像 runtime 自行设置 APPIMAGE/APPDIR，不手工伪造。解包 deb 的验收额外设置 `APP_EXPECTED_UPDATE_MODE=manual`，该变量仅定义测试预期，不改变产品行为。

source 与 packaged 项目均使用私有 HOME/userData/sessionData/logs/SSH/XDG 目录、关闭自动连接/更新/自启动，并在主进程实查实际路径。测试侧拒绝外网；source 只使用固定本地 TLS/WSS 与隔离 CAS fixture，不代表真实学校登录、OS 密钥环或签名升级证据。packaged 不注入生产测试入口。沙箱保持开启；截图和原生上下文 trace 保存在 `test-results/`，CI 按平台分别保留。

文件传输 fixture 使用真实本地 HTTPS 与原始二进制，不再需要 GNU coreutils 或远端 shell 工具。source 的命令 fixture 在 POSIX 使用真实 Python PTY，在 Windows 使用已安装的 Git Bash 执行命令，仅对管道模式的终端设置做测试侧建模；这不是原生 Windows PTY 或真实学校平台的通过证据。

公开设置的默认值与校验由 `shared/settings-schema.mjs` 统一，renderer 校验仅供交互提示，主进程再次权威验证。IPC 成功响应为 `{ok:true,value}`，业务失败为 `{ok:false,error:{code,fieldErrors?}}`；取消操作是成功的 `{cancelled:true}` 值。前端只显示固定错误码的本地化文案，不显示主进程异常正文；缺少桌面 runtime/API 的动作会明确失败，不再静默成功。

## 使用

### 首次使用与登录

全新安装和新档案会进入临时向导；旧设置迁移不会强制打开。没有凭据不等于新用户，已完成的档案也不会因 Cookie 过期再次进入向导。

1. 点击 **Login**，在隔离登录窗口中手动完成统一认证并进入 Web SSH 页面。向导不要求也不保存密码；需要自动填充时，可在 Settings 的 SSO 区域另行主动保存。
2. 预览当前档案已保存设置的 SSH 受管配置块，检查后主动生成；已有配置匹配时可直接继续。向导不会自动改写文件。
3. 启动代理；运行参数与保存参数不一致时，使用 **Restart and apply**，确认后才中断现有连接。
4. 运行诊断。主进程要求当前 scope、配置和认证 generation 下的 `TOKEN_OK`、`SETUP_OK`、本地公钥认证、有效 SSH Config、首条终端数据及真实随机标记命令全部通过，才保存完成状态。只完成 WebSocket Upgrade、只有旧版八项检查或 token 校验失败均不能完成向导。

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

交互会话按 channel 独立解码 UTF-8，并转发初始 PTY 尺寸和窗口变化。交互 EOF 先排空输入，再进行有上限的输出静默等待，之后才发送 disconnect；不承诺远端原生半关闭或任意慢脚本的完成语义。PKCS#8 主机密钥迁移和诊断所用客户端内存格式转换保留同一个 Ed25519 身份；指纹为完整 SSH 公钥 wire blob 的 SHA-256。

## 配置与数据安全

| 设置 | 默认值 | 说明 |
|---|---:|---|
| Host | `127.0.0.1` | 本地代理监听地址 |
| Port | `3000` | 本地代理监听端口 |
| Cluster | `training` | 平台集群 |
| Login Node | `11.11.10.202` | 登录节点 |
| Starting directory | 空 | 档案的远端目录 `path`，按 URL 参数编码，不作为 shell 命令拼接 |
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

Diagnostics 依次提供十项证明：设置、密钥、受管配置、本地监听、DNS、TLS、token 校验、门户 setup、WSS 首帧和真实轻量命令。本地/DNS/TLS/握手检查各最多 5 秒，token 校验默认 10 秒，setup 最多 4 秒，Upgrade 后首帧最多 10 秒，命令证明最多 15 秒，并受整体 30 秒上限约束。`LOCAL_SSH_OK`、`WSS_SHELL_READY` 与 `REMOTE_COMMAND_OK` 分别证明本地认证、首条终端数据和精确随机标记输出且退出 0；端口 bind-only 不证明可用。token/setup 失败会跳过 WSS 与命令检查，不伪造成功。配置、scope 或认证变化会使旧证明失效。

每个新的 GUI/CLI 代理生命周期在监听前主动请求 `GET /api/auth/validateToken?token=...`，只使用 `SCOW_USER` 的值；被拒绝则提示核实登录，不进入监听。校验返回 valid 后才调用一次幂等 `GET /api/setup`，每个 SSH channel 不重复调用；恢复探测也先校验与 setup。setup、网络和超时失败不能证明 token 失效。REST 拒绝只阻止新操作并提示，不删除已保存 Cookie、不终止既有健康 SSH；只有既有 WSS 握手 HTTP 401/403 路径自动撤销 Cookie。文件 API 的 403 权限错误明确区别于 AUTH。

`validateTokenPeriodically` 默认关闭，启用后至少每五分钟校验一次，不建立 shell 会话；繁忙、暂停、切档案、认证变化和退出会取消旧请求。API 拒绝抑制此凭据上下文的后续定期轮询，等待凭据变化；网络失败不推断过期。校验服务内部故障也可能被门户返回为拒绝，所以应用不会因此删除凭据。

日志筛选是大小写不敏感的纯文本匹配，不执行正则。复制和日志 JSON 导出只包含当前匹配项（ISO 时间、级别、来源和脱敏消息）；诊断包则明确包含当前最多 500 条安全日志，不受筛选影响。诊断包为单个 JSON，只含版本/架构、公开连接设置、诊断状态和再次脱敏的日志，替换 HOME/USERDATA 路径；总量最多 8 MiB，必要时逐条裁剪最旧完整日志并记录数量。不会读取原始设置、日志文件或私钥打包，也不包含账号、Cookie、密文、用户 exec 命令或远端输出；公开的 `startupCommand` 仅允许下述固定 tmux 选项。保存位置由原生对话框选择，取消不写文件。

密钥在所有档案间共享：客户端私钥仍位于 `~/.ssh/usshtc107_ed25519`，主机私钥位于 userData 的 `proxy_host_ed25519`。已初始化身份缺失、损坏或意外变更时不会静默重建；Settings 的密钥面板独立提供状态、完整 SHA256 指纹和恢复步骤，读取失败不影响其他设置。

备份只使用同一 `safeStorage` 后端，格式为 `usshtc107-key-backup` schema 1；私钥明文不跨 IPC、不进 DOM/日志。备份绑定原机器、OS 账号及安全存储环境，不保证可迁移，即使硬件相同，丢失原 OS 密钥环也可能无法解密；无安全后端时不提供明文或自制加密回退。导入先限长、解密、验证实际 Ed25519 私钥并派生指纹，不信任文件内路径或指纹元数据。

Rotate 替换选中的可用身份前必须成功导出加密备份；原生确认或备份保存取消都不改变密钥、监听或草稿。Rebuild 是明确修复：只重建选中的非 ready 身份，选中的 ready 身份逐字节保留；缺失、无效或意外变更身份的旧材料不会被假称已备份，原生确认会提示不可恢复的材料风险。主机变更确认显示实际旧/新指纹及 SSH 信任后果。

替换用 0600、fsync 的 stage/rollback 文件和根 journal 协调 prepared/installed/committed；候选监听绑定后拒绝 TCP/SSH，只有新指纹与 committed 阶段同一次根提交且确认耐久后才接纳连接。未知文件 hash/缺失回滚材料会锁定 `KEY_ROLLBACK_FAILED` 并保留材料；根已实际 committed 时绝不回滚为旧私钥。遇到事务或持久性错误，保留现有密钥和事务文件，修正源问题后用“Retry key recovery”重新加载/恢复，必要时重启，不用重建覆盖未解决 journal。

自启动仅支持已安装/打包应用，开发和 unpacked 运行明确显示不支持，读取状态不会自动注册。Windows 按同一路径、参数和本应用 launch-item 的实际 enabled 状态读取；macOS 如需 Login Items 批准会如实显示，不能把登录启动来源当作已启用。Linux 只管理用户 XDG autostart 下带 `X-usshtc107-Managed=true` 的文件，不覆盖同名他人文件；Exec 不使用 shell，并按 freedesktop 规则转义。先更改 OS 状态再保存偏好，保存失败会恢复原 OS 状态；SSO/自动连接仍由当前档案独立控制。

恢复遵循 `desiredRunning`，后台检查不改变连接意图。每轮先执行 token 校验和 setup，再等待真实 WSS 首帧；网络故障按 1/2/4/8/16/30 秒、最多六次退避。REST 拒绝是终止性的登录提示，不进入网络退避、不撤销 Cookie；只有 WSS 握手 401/403 自动撤销。首帧静默同样抑制该 scope/config/Cookie 的自动恢复，显式 Retry 或上下文变化才可重试。不会重启健康监听、重放 exec 或重建旧 channel。

交互会话保持为每档案主动选择：`startupCommand` 只允许空字符串（关闭）或 `tmux new -A -s usshtc`，不接受任意启动脚本。仅在收到首条终端数据后、用户排队输入之前注入交互 shell；先检查 `command -v tmux`，缺少时显示提示并保留普通 shell，exec 一律不注入。tmux 会话名固定为 `usshtc`，因此同一远端账号/节点的启用连接会附加到同一会话。

`healthProbeEnabled` 默认关闭；启用后仅对已运行、空闲且认证可用的代理每 60 秒执行一次只读 `true`，每轮总计最多 15 秒、不重叠，必须收到真实退出码 0 才显示可用。每轮都会建立远端会话并产生平台 `shellLogin` 日志；关闭偏好、切档案、暂停、停止、退出和认证变化会取消旧探测。首帧静默错误也禁止后台健康探测，不会自动删除 Cookie 或启动代理。

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

检查/下载网络失败可重试；`UPDATE_RESTART_REQUIRED` 表示必须先重启应用，不能在当前进程反复调用原生安装器。可观察到的退出前安装错误会保留 UI，但不承诺恢复退出后或外部安装器静默失败。真实签名 N→N+1 升级需要两个不同版本、连续签名身份及目标 OS 的受保护验收；本地版本更新不代表发布或目标平台验收，不能用本地 fixture 或跨编译替代这些证据。

## Headless CLI 与文件传输

CLI 不依赖 Electron。安装依赖后使用 `npm run cli -- --help` 或 `node cli/main.cjs`；`package.json.bin` 的 Node CLI 名为 `usshtc107`，不等同于 Electron 安装后的同名桌面可执行文件。默认 `serve` 启动经过 API 前置校验的回环 SSH 代理，SIGINT/SIGTERM 等待资源关闭。连接参数与档案沿用统一 schema，短期 Cookie 只在内存使用。

`SCOW_TOKEN` 是短期 `SCOW_USER` 值，`serve`、`get` 与 `put` 都需要；通过环境变量安全输入，不写配置、日志或命令历史。`--cookie` 仍可显式提供，但会暴露在进程参数中并显示警告。严格 JSON 配置拒绝凭据和未知键；文件操作不读取、生成或依赖本地 SSH 身份。`dataDir`、`sshDirectory`、host/port 等只影响 `serve`。远端文件路径必须为绝对路径，拒绝控制字符、目录根和路径穿越，不假设用户家目录。

```bash
# 先安全设置 SCOW_TOKEN，不把 token 写在命令行中
npm run cli -- serve
# 文件 API 直接使用 Cookie 与 cluster，不需要先运行 serve
npm run cli -- put -- ./local.bin /remote/new-file.bin
npm run cli -- get -- /remote/new-file.bin ./downloaded.bin
```

`get`/`put` 及 **File transfers** 页面直接使用官方 HTTPS file API，不再使用 SSH/Base64、远端 shell 工具或旧传输回退。默认/最大单文件 64 MiB、总时限 10 分钟；CLI 可用 `--max-bytes` 缩小上限、`--timeout-ms` 指定时限（最多一小时）。上传先协商服务端 `chunkSizeByte`，小于阈值使用单次 multipart，达到阈值按服务端大小串行分块；块名是原始块 SHA-256 加一基索引，`chunk`/`originPath` 经 URL query 编码，merge 的 `sizeByte` 是完整原文件大小。init 明确返回 UNIMPLEMENTED 时仅使用已确认的官方普通 upload，不回退到 SSH，也不声称进行了分块。

上传先写唯一暂存文件，完整下载回读并核对 SHA-256 后，再通过官方 move API 发布；本地源文件变化、远端回读不一致或 AUTH 都会明确失败。进度只计算 HTTP 成功确认的字节，最后一块不超计。默认通过 `fileExist` 拒绝已存在目标，`--overwrite` 或 GUI 明确确认才可替换普通文件，不替换目录。**门户没有原子排他写入契约：存在性检查之后仍有并发写入竞态，不能保证远端原子 no-clobber。**这是用户明确接受的官方 API 边界。

下载前、写入期间及完成后分别计算/核对 SHA-256，本地使用 0600 `.part` 文件、fsync 后发布，默认原子保护本地已存在目标；显式覆盖时使用最终改名。取消会停止后续请求并清理本地临时文件，远端暂存目录/文件可能保留；其共享和清理契约未确认，应用不会删除未知远端临时目录或假称回滚。上传、合并与 move 不自动重试，不支持断点续传、自动同步、目录传输或目录打包下载。

GUI 只接受远程路径，本地文件/保存位置由带父窗口的原生对话框选择；最多 2 个活动传输、20 个排队项、50 条完成历史。列表只发布文件名、状态和确认字节，不把 Cookie、本地绝对路径或 VNC 链接传给 renderer。切档案、认证/连接上下文变化及退出会取消旧操作。

文件传输按列表中的 POSIX mode 明确区分 `file/dir/link/other`，检查选中条目及祖先；符号链接、特殊文件和无法确认类型的元数据默认拒绝，不提供隐式跟随。检查与 HTTP 读写之间仍有竞态，不是服务端原子 no-follow 保证。门户 API 客户端默认只接受精确的官方 host；内网/测试替代 host 与端口必须由受信任 Node 调用方显式列入 `allowedHosts`，renderer 和 CLI 无此配置入口，TLS 校验不可关闭。

## 传统 SCP 兼容层

本地代理处理 SCP exec 协议，文件与元数据仍走官方 HTTPS file API，不启动远端 scp，也不改变普通 exec。**OpenSSH 9 起 `scp` 默认使用 SFTP，本功能必须加 `-O`**；PuTTY 使用 `pscp -scp`。不提供 SFTP；WinSCP 强制 SCP 仅作观察项，不保证其额外 shell 命令格式兼容。

```bash
scp -O ./local.bin usshtc107:/absolute/path/remote.bin
scp -O usshtc107:/absolute/path/remote.bin ./downloaded.bin
scp -O -r ./directory usshtc107:/absolute/parent/
scp -O 'usshtc107:results/*.log' ./results/
```

支持单文件、空文件、递归、中文/空格/安全字面特殊文件名，以及逐路径段的 `*`、`?`、字符组匹配；无匹配非零，不支持 `**`。相对路径通过官方 `getHome` 定位，不猜家目录、不展开 `~`/变量/命令替换。空格和特殊字符仍需按旧 SCP 客户端要求转义；不使用 `-T` 关闭 OpenSSH 文件名检查。直接 SCP 命令支持 `-f/-t/-r/-p/-d/-v/-q/--`；明确识别为 SCP 但参数非法时本地拒绝，其他 exec 保持原路径。没有双远端专用通道；服务端无法可靠识别客户端 `-3` 的两个独立连接是否属于同一次编排，不承诺双远端支持。
通配符默认不选择隐藏项；只有显式以 `.` 开头的模式或文件路径才会选择隐藏文件，避免意外复制秘密文件和遗留暂存文件。

**传统 SCP 默认覆盖已有普通文件**。档案级 `scpNoOverwrite`（CLI `--scp-no-overwrite true`）可拒绝已有目标；`scpMaxFileBytes`（`--scp-max-file-bytes`）默认/最高 1 GiB，可下调至 1 字节。Settings 保存后需重启代理生效，GUI Files 与 CLI get/put 的独立 64 MiB 上限不变。

上传先完整接收到私有本地临时文件，再按服务端协商大小分块、merge、SHA-256 回读校验。新目标用 move 发布；普通 SFTP rename 不能保证覆盖已有目标，因此 SCP 覆盖先校验暂存文件，再通过官方普通 upload 原地写入目标并再次回读校验，最后才发完成 ACK。**覆盖不是原子的，失败可能已截断或部分替换原目标，不保证保留原内容或回滚**。服务端拒绝时非零退出，不删除目标绕过限制；私有守护进程的覆盖能力仍需真实验收。GUI/CLI 原暂存 move 路径未改，其显式覆盖依赖服务端 rename 能力。

下载采用列表中的大小、mtime 和普通权限位，剥离 setuid/setgid/sticky。`-p` 下载发送 mtime；API 无 atime，协议 atime 明确取 mtime 作为派生值，不声称真实访问时间已保留。上传接受时间戳和权限帧，但 API 不支持设置，因此不保留上传的 mode/mtime/atime。选中路径及祖先必须有匹配的 POSIX 文件种类位；符号链接、特殊文件和无法确认种类的元数据均拒绝。检查与读写仍有竞态，不构成原子 no-follow 或符号链接沙箱。

协议带有界缓冲和背压；单会话最多 10,000 项、32 层、8 GiB 文件数据，最长一小时，空闲 30 秒取消。本地上传总预留上限 2 GiB，另保留 64 MiB 磁盘余量。POSIX 临时目录/文件为 0700/0600；完成、失败、断连、Cookie 变化及 stop 清理本地暂存。下次分配只清理能确认归属且原进程已结束的目录，不删除未知内容。远端暂存可能保留，失败不自动重试。SCP 复用 exec 会话统计、连接/会话上限和脱敏日志，不记录命令或文件内容。

本地验收使用真实 OpenSSH、PuTTY、SSH 与本地 TLS file API，覆盖超过 64 MiB 的分块往返、递归、通配符、覆盖和取消。PuTTY 用例需设置 `PSCP_BINARY`、`PUTTYGEN_BINARY`；Linux CI 安装客户端后执行。fixture 不替代真实学校门户、Windows/macOS 客户端或 WinSCP 验收。


## 桌面与应用入口

**Desktops & apps** 只列出当前账号/集群的已有桌面、应用会话和应用目录。刷新列表不会拉起桌面；必须点击打开或复制才调用 launch/connect。主进程验证固定 HTTPS 门户来源、host/port/proxy 路径及模板，再交给系统浏览器或剪贴板；完整 noVNC/应用链接与 VNC 密码不经过 IPC、不显示在页面、不进日志、设置或导出。链接含会话凭据，剪贴板和系统浏览器历史不受本应用控制，请勿外发。

支持已核对的 v1.9.11 嵌套桌面结构、VNC 应用及 `connect.method=GET` 的 web 应用；连接应用 API 本身仍为 POST JSON。模板替换采用门户的 `{{ HOST }}`/`{{ PORT }}`/`{{ PASSWORD }}` 与 customFormData 规则，query 后编码。会话已结束/未就绪分别显示错误，不自动重试；POST 表单、ShadowDesk、新建桌面和 WM 选择不在本轮范围。私有契约证据与剩余边界见 [SCOW API 契约记录](docs/scow-api-contracts.md)。

不提供 SFTP 子系统、本地/动态/反向端口转发，也不承诺 VS Code Remote-SSH；传统 SCP 的范围和限制见上节。

回滚边界：新档案字段保存后，未识别这些字段的旧版本（包括固定的 `v1.3.0`、`v1.3.1` 快照）会因严格 schema 保持只读。按依赖逆序撤销提交前先备份完整私有 userData，使用对应设置备份；不删除秘密字段、私钥或 known_hosts 绕过保护。缺省补齐仅发生在内存，不在只读加载时改写文件。传统 SCP 兼容层自 `v1.3.2` 提供，旧标签保持原提交；创建本地提交和标签不等同于推送或发布。

## 打包与发布

```bash
npm run dist:linux
npm run dist:mac
npm run dist:win
```

项目使用 npm 11.18.0 的依赖安装脚本白名单；发布和 CI 会固定该版本并在严格模式下安装。Windows 和 macOS 发布包不进行开发者证书签名或 Apple 公证，不需要配置签名、公证 Secrets；macOS 显式禁用签名身份，CI 禁用证书自动发现。

未签名安装包可能触发 Windows 的未知发布者/SmartScreen 警告，macOS 可能由 Gatekeeper 拦截。请仅从本仓库 GitHub Release 下载，并先核对 `SHA256SUMS.txt` 和构建来源证明；这些完整性证明不等同于操作系统认可的开发者签名。不要关闭系统全局安全检查。Windows/macOS 的应用内升级仍保留平台验签保护，不承诺未签名版本能够应用内安装；请从官方 Release 页面下载后手动升级。

发布标签必须严格等于 `v<package.json version>`，例如 `v1.3.3`，且标签提交必须属于默认分支历史。应在仓库设置中保护 `v*` 标签。

发布流水线检查各平台安装包及更新 metadata，生成产物 SHA-256 校验文件和 GitHub 构建来源证明，并为实际生产依赖生成 CycloneDX SBOM。普通手动构建可以选择单个平台；macOS/Windows 构建只能从默认分支或匹配版本的标签发起。创建 GitHub Release 时必须构建全部平台。TLS、SSH 公钥认证和下载完整性校验保持不变。

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
  diagnostics-service.js  有界连接检查、终端就绪和实际命令证明
  portal-api/             统一 HTTPS、token/setup、文件与桌面/应用 API
  portal-preflight.js     新监听与恢复的非破坏性认证/setup 门控
  token-validation-service.js 默认关闭、至少五分钟的定期 token 校验
  file-transfer/          流式哈希、官方分块、暂存发布及 GUI 队列
  remote-session/         scope 归属、主进程链接生成和显式打开/复制
  portal-services.js      主进程服务组装、取消与 trusted IPC 注册
  diagnostic-export-service.js 脱敏 JSON 和筛选日志导出
  wss-connection.js        统一平台 URL、TLS 和系统追加信任政策
  ssh-key-service.js      客户端与代理主机密钥
  ssh-config-service.js   受管 SSH Config 写入与备份
  preload.js              最小化 IPC API
src/
  components/             通用界面组件
  views/                  Dashboard、SSH Sessions、Logs、Diagnostics、Transfers、Remote Sessions、Settings 与临时 Setup
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

## 交互与门户限制

- 管道或 heredoc 到交互 shell 的 EOF：先排空已排队输入，再等待输出静默 250 毫秒；持续输出也不会把排空窗口延长到 5 秒之外，然后请求 disconnect，并受关闭超时约束。这是有界的交互排空，不证明远端命令已完成；较慢、多阶段脚本请用 `ssh alias 'command'` 的 exec 通道获取完整输出及退出码。
- 门户的远端 `exit` 可能只打印 `logout`，不发送 exit 帧也不主动关闭 WSS。本地终端需要自行关闭或使用 SSH 的本地退出方式；应用不按输出中的 `logout` 字符串猜测退出。
- 交互终端若由门户按字节块独立解码 UTF-8，可能已经产生不可逆的 `U+FFFD`；桥接不能还原丢失的字节。exec 的 ASCII/base64 线协议避免此类输出编码损失。
- 非回环监听会把代理暴露到网络，Settings 明确警告；公钥认证和 TLS 校验仍不可关闭。`useRoot` 需要平台额外授权，普通账号仅开启选项不会获得权限。
- 档案 `path` 默认为空，最多 1,024 字符，不接受控制字符，按字面保留空格并经 `URLSearchParams` 编码。已有 v2 设置在内存补齐缺省字段，不自动改写用户文件。
- 单独构造 `ProxyServer` 而未传入 host key 时，也复用持久化 OpenSSH Ed25519 身份，不再按进程生成临时 RSA key；可用 `hostKeyPath` 指定隔离路径。默认路径与标准平台 userData 目录一致，自定义 Electron userData 仍由主进程显式提供身份。损坏或异类 key 拒绝启动，不删除旧文件。

## 自动化验收范围

CI 和测试仅使用隔离的本地 TLS/WSS、SSH、PTY、文件 API fixture 与原生 Electron 程序，不接入真实学校账号，也不要求提供有效或过期 token。真实账号在线测试、相关运行入口和账号验收前置条件已移除；生产 CLI 的 `SCOW_TOKEN` 用法保持不变。

本地故障注入可用 `node --test tests/integration/remote-ready.test.js` 独立执行，始终要求显式 loopback WSS、测试 Cookie 与受信任测试 CA，没有真实服务回退。自动化结果不代表学校平台实时可用性、真实系统密钥环或 Windows/macOS 连续签名升级已验证。失败归因与 CI 诊断规则见 [1.3.3 修复记录](docs/ci-stability-1.3.3.md)。

## License

MIT
