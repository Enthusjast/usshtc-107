# 1.3.3 修复归因与验收记录

## 基线与分类

基线提交为 `c993e05`（`v1.3.2`）。已读取 [CI 40116326001](https://github.com/Enthusjast/usshtc-107/actions/runs/40116326001) 的作业状态及 Windows/macOS 原始失败日志；Ubuntu 作业同样在 Node/renderer/transport 步骤失败，但该作业日志未能从接口取得。用户提供的失败事实不通过重跑旧失败来重新确认。

| 条目 | 平台差异 | 时序 / 测试建模 | 真实缺陷及处理 |
|---|---|---|---|
| OBS-1 | Windows 更新组受影响 | 旧代码丢弃原始异常，无法回溯具体检查点 | 校验与服务映射保留非枚举 `cause`；校验保留固定 `verificationStep`，公开错误码不变 |
| CI-1 | macOS `/var` 与 `/private/var` | 临时基准未规范化 | 规范夹具路径；不删除生产 realpath 防护 |
| CI-2 | Windows 路径与文件替换锁定语义 | 原日志合法文件在打开前失败，descriptor-close 计数为零，不能归咎于替换锁 | 夹具采用 native canonical path；保留真实替换，并在真实 Windows EACCES/EPERM 时只接受对应权限错误；另用流/metadata 边界独立验证篡改 |
| CI-3 | reset/关闭表现不同 | 断言绑定错误文案 | 验证拒绝、未 ready、无上游会话和 socket 残留；超时不能冒充拒绝 |
| CI-4 | TLS 取消可产生 ECONNRESET | `events.once(socket, 'close')` 会因 error 提前拒绝 | 生产 `probe.own` 已在 terminate/destroy 前保留 error guard；修正夹具的关闭观察，允许预期 reset，但验证真实关闭、无命令、无凭据失效且不隐藏其他错误 |
| CI-5 | 慢 runner 放大毫秒竞态 | 真实 25/45ms 计时 | 注入可控 clock，并等待请求/响应事件屏障；保留派发前取消不出网 |
| CI-6 | Windows 本地路径分隔符/盘符 | `/native/...` 硬编码 | 使用平台临时路径，保留 Windows/POSIX 日志与 DTO 隐私断言 |
| 本地 tmux | 继承宿主 SHELL/HOME/TMUX | 直接诊断观察到 zsh/oh-my-zsh 更新提示消费输入；历史失败是否为同一提示属推断 | 隔离夹具 shell 与 HOME/XDG，等待实际 tmux pane 提示后发命令；不改生产 tmux 行为 |
| SEC-1 | 无 | 非测试建模问题 | 默认仅允许精确门户 host；替代 host/port 需受信任 Node 调用方显式 allowedHosts，拒绝子域伪装/通配/隐式信任，拒绝前不分配 agent 或出网 |
| SEC-2 | 无 | getFileType 跟随链接，不能作为 no-follow 证明 | 元数据明确 kind；统一检查选中条目及祖先，默认拒绝链接、特殊文件与无法确认类型的条目；SCP 复用同一分类规则 |
| BEH-1 / BEH-2 | 门户行为 | logout 无 exit 帧；EOF 已有有界静默排空 | 保留现有行为，文档不再把 EOF 写成“立即 disconnect”，也不声称慢命令一定完整 |
| BEH-3 | 尚未归因 | 用户报告偶发 124 | 不自动重试或推测限流；保留 2/4/8、每档三轮的授权只读观察入口 |

Windows 历史失败的确切原始异常已被旧代码丢弃。Node 的同步 JS realpath 与 native/promises realpath 对 Windows 别名的处理差异有源码依据，但将该次失败具体归因为短名或大小写仍是 **[INFERENCE]**；修复后的真实 Windows CI 结果和新检查点才是验收证据。

## CI 诊断规则

- CI 的 Node runner 输出平台、Node 版本、失败文件及脱敏后的异常/cause/检查点；不枚举 assertion actual/expected 或响应 payload，不输出环境变量。
- `test-results/node-ci-*/initial.jsonl` 保留第一次失败。仅将枚举过的失败测试文件重跑一次，写入 `diagnostic-rerun.jsonl`；即使第二次通过，第一次失败仍使 job 失败。
- 诊断重跑不测局部覆盖率，原始覆盖率运行的阈值和失败状态不变。
- 三个平台每个 job 连续运行完整 Node 回归三次；任意一次失败立即阻断。renderer、覆盖率、构建、原生 Electron、生产依赖审计与 Linux 打包仍是独立门禁。

## 安全与回滚边界

`allowedHosts` 仅由受信任主进程/Node 依赖提供，不进入 renderer 或 CLI 配置。替代服务依然必须通过 TLS 校验；不会自动信任子域或从 baseUrl 生成授权名单。

远端 metadata 检查与实际读写不是原子操作，门户没有 no-follow/条件发布契约，不能把检查包装成符号链接沙箱。无可确认的普通文件/目录种类位时失败关闭，不引入默认跟随链接或未经要求的兼容开关。

本次不更改配置和密钥格式。按提交逆序 revert 可撤销修复；不要删除私钥、known_hosts 或凭据以绕过保护。旧版本会恢复旧安全边界，回滚不等于风险消失。

## 验收状态与发布门槛

真实门户 token、文件往返、桌面/应用打开及失效 token 验收尚未取得。安全前提检查只输出布尔值：没有 SCOW_TOKEN/SCOW_EXPIRED_TOKEN，LIVE_SMOKE/LIVE_CONCURRENCY 未启用。没有搜索磁盘凭据，也没有用本地 fixture 冒充有效学校账号。

P5 必须由获授权的账号完成，并发观察还需平台许可。只读并发入口为 `tests/live/concurrency.live.cjs`，每档 2/4/8、三轮，共 42 次，不重放失败命令；统计不预设 100% 成功。原始输出和账号信息不进入报告。

### 本地已取得的证据

| 检查 | 结果 |
|---|---|
| 递归语法检查、生产构建 | 通过 |
| CI 模式完整 Node 覆盖率 | 971 通过、0 跳过；行 97.49%、分支 88.70%、函数 91.26% |
| renderer 覆盖率 | 412 通过；行 93.42%，原门槛不变 |
| 原生 Electron source | 6 场景通过，含实际 TLS 链接拒绝、无目标读取/本地文件、固定 UI 错误 |
| Linux unpacked / AppImage / 提取 deb | 各自启动真实程序并通过原生验收 |
| Linux 更新 metadata | 3 个产物 size/hash 等校验通过 |
| 生产依赖及完整 npm audit | 均 0 vulnerabilities |
| 无凭据 live 默认执行 | 18 项明确跳过，计为未验收而不是成功 |

以上仅是本地 Linux 与模拟平台适配器证据；不替代真实 Windows/macOS CI、学校平台、系统密钥环或连续签名升级。

本地和三平台 CI 证据另行追加；在真实 P5 完成之前，不合并发布变更、不创建发布标签、不发布 1.3.3。
