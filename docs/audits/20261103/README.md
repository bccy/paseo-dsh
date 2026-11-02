# 2026-11-03 全量代码健康度审查证据索引

- 审查基线：`0c82df5`（main）；上一轮 `2f71225`（[FULL-AUDIT-20261102](../../FULL-AUDIT-20261102.md)）
- 主报告：[全量代码健康度审查（2026-11-03）](../../FULL-AUDIT-20261103.md)
- 环境：DSH `0.2.1-rc.5`、Paseo `0.14.0`、Node v22.23.1
- 分工：24 个只读审查 lane，全部 fresh context、只读运行；未改产品代码、未 git 写、未跑真实模型/daemon

## 阅读顺序

1. 先读主报告的「结论」与「上一轮问题修复核查」。
2. 按区域读分区报告，每条发现都带 `file:line`、触发条件、证据等级与基线归属。
3. 测试体系结论以 `verify-runner.md`（实跑）与 `harness-*.md`（判据质量）为准，两者不要混读。
4. 修复核查以 `fix-verify-*.md` 的三条独立双证为准（基线副本红 → HEAD 绿）。
5. 「全绿」的含义见主报告 §5.3：66/66 离线通过，但不等于发布判据。

## Lane 索引与结论

| Lane | 范围 | 结论摘要 | 报告 |
|---|---|---|---|
| bridge-server-core | `server.js` 请求分派/会话/权限/plan/MCP/usage | 3.5/5；上轮 4 条 P2 真修；本轮无 P2，3 条 P3（含修复轮新引入的 500 并发句柄） | [bridge-server-core.md](bridge-server-core.md) |
| bridge-server-rewind | `server.js` 撤回链路 + `revert.js` | 3.9/5；p1a 五条修复全成立；**1 条 P2**：files-only 首条消息被拒（新引入） | [bridge-server-rewind.md](bridge-server-rewind.md) |
| bridge-files | file-snapshots / gate / owners / surface | 3.5/5；BR-01/02/04、BF-02/03 读前类成立；**3 条 P2**（读后失败静默、取消/关闭丢 pending、对象不校验内容） | [bridge-files.md](bridge-files.md) |
| bridge-mcp | mcp-gateway/http/stdio/envelope/approval | 3.6/5；BR-06/07/08、BM-02/03 全落地（独立 loopback/stdio 复现）；18 条 P3 | [bridge-mcp.md](bridge-mcp.md) |
| bridge-misc | transport/index/child-anchors/image/archive | 4/5；BR-03/BR-08 修复到接线级；15 条 P3（出站无背压、stdout EPIPE、跨进程归档失效） | [bridge-misc.md](bridge-misc.md) |
| plugin-session | `session.ts` 会话状态机 | 3.6/5；上轮 7 条修复全成立；**1 条 P2**：子代理 history 失败静默 | [plugin-session.md](plugin-session.md) |
| plugin-provider | provider.ts / bootstrap / bridge-assets | 4/5；上轮条目独立复核成立；**P2**：canary live 投递被 run lock 吞；新引入 1 条队列补发竞态 | [plugin-provider.md](plugin-provider.md) |
| plugin-process | `dsh-process.ts` 子进程与出站 | 4/5；PP-01/PP-02/HC-01 修复成立但不完整；18 条 P3（队列冻结、awaitClose 分支不可达）；如实披露一处探针事故 | [plugin-process.md](plugin-process.md) |
| plugin-timeline | timeline/frame-reader/first-token/locale | 4.0/5；五文件逐字节未变；10 条 P3（fallback 被 legacy 过滤器吃掉、缓存无预算） | [plugin-timeline.md](plugin-timeline.md) |
| plugin-rewind-notice | 撤回提示链（新功能 +3374 行） | 3.7/5；主机制在真实宿主代码上成立；9 条 P3（超时复核窗口、飞行中句柄捕获、canary 文档口径） | [plugin-rewind-notice.md](plugin-rewind-notice.md) |
| client-toolcall | tool-call-data / tool-call / tokens | 无 P0/P1；C1/CT-02 已修；**1 条 P2**：非终端正文仍硬截断无恢复 | [client-toolcall.md](client-toolcall.md) |
| client-jobs | jobs-pill / polling / popover / spinner | 3.2/5；CJ-01 路线 2 自洽、CJ-03/04 已修；**P2**：轮询放大只修一半（隐藏 4s 为有意权衡 + 无条件 publish） | [client-jobs.md](client-jobs.md) |
| client-misc | locale / thinking / stream-stats / 动画 | 4.0/5；C2 修复红→绿成立；15 条 P3 | [client-misc.md](client-misc.md) |
| local-patches | 宿主补丁与门禁（3316 行） | 3.3/5；L1 已修（红→绿）；**2 条 P2**（revert 参数名未 gate、LP-02 残余）；部署副本落后仓库 | [local-patches.md](local-patches.md) |
| delivery | doctor / probe / bin / CI / 发布 | 3.1/5；D1/D2/DLV-12 真修；**3 条 P2 新假绿**（凭据契约、补丁可应用、profile 就绪） | [delivery.md](delivery.md) |
| harness-bridge | 桥侧 harness 判据质量 | 3.7/5；T01–T04/HP-05/HP-08/H-01 修复有效；**1 条 P2**：降级重投分支零覆盖仍全绿 | [harness-bridge.md](harness-bridge.md) |
| harness-plugin | 插件/交付 harness 判据质量 | 3.7/5；T01–T04 等六组修复全部成立；**1 条 P2**：编译基建共享 `.dbg` 无新鲜度校验 | [harness-plugin.md](harness-plugin.md) |
| verify-runner | 全量离线实跑 | **66/66 通过、0 失败**；13 项未执行（真实环境）；24 个脚本未登记 HARNESS.md | [verify-runner.md](verify-runner.md) |
| fix-verify-bridge | 上轮桥侧 fixed 核查 | **22/22 fixed、0 regressed**；1 条 P2 残余（BF-03 读后失败） | [fix-verify-bridge.md](fix-verify-bridge.md) |
| fix-verify-plugin | 上轮插件/客户端 fixed 核查 | **21/22 fixed**；CJ-02 still-broken（§10.1 标注过宽） | [fix-verify-plugin.md](fix-verify-plugin.md) |
| fix-verify-delivery | 上轮交付/测试/文档 + blocked/暂缓 | p8/p9/p11 基本 fixed；HP-05 部分、D15 部分；S08/PP-02 仍 blocked；§10.4 无结论 | [fix-verify-delivery.md](fix-verify-delivery.md) |
| docs-consistency | 13 份文档 vs 实现 | 3/5；D01–D09/D11–D14 已修；**3 条 P2**（canary 三口径、版本发布线混用、OVERVIEW jobs 语义） | [docs-consistency.md](docs-consistency.md) |
| health-crosscut | 全仓横切缺陷模式 | 3.9/5；**1 条 P2**（快照 catch-all 不落 journal，与 bridge-files BF-01 同源）；HC-01 分帧已修 | [health-crosscut.md](health-crosscut.md) |
| new-commits | 修复轮后 5 个提交逐 diff | 4/5；主机制成立、无 P0–P2；6 条 P3（降级丢报告、兜底被过滤、构造期无兜底） | [new-commits.md](new-commits.md) |

## 跨 lane 校正与裁决

- **canary 可见性**：`plugin-provider` 判「live 投递不成立」，`plugin-rewind-notice` RN-08 与
  `new-commits` 判「stock 宿主经 history 重放可见、补丁宿主被截才正确」，`docs-consistency` 复跑
  delivery-check 观察到同一现象。主报告 §6 裁决：按后者修正文档，复验前不动 canary。
- **CJ-02**：`fix-verify-plugin` 判 still-broken，`client-jobs`/`new-commits` 判部分修复 + 有意权衡。
  主报告 §6 裁决：§10.1 fixed 标注过宽，拆成「隐藏 4s（有意，不改回）」与「无条件 publish（欠账）」。
- **BF-03 残余**：`bridge-files` BF-01、`fix-verify-bridge` N2、`health-crosscut` HC-01 三 lane 独立
  复现同一问题，主报告 §4.1 合并为一条 P2。
- **上轮 §10.1 口径**：`fix-verify-delivery` 指出 HP-05「真实脚本默认一次性 DSH_HOME」过度声明
  （`probe.mjs`/`catalog.mjs` 未隔离）；`fix-verify-plugin` 指出 CJ-02 fixed 过宽；两条均已进主报告。

## 证据边界

24 份报告中的「实测」条目分别由编译产物、假桥、loopback、真实文件系统、真实宿主模块
（`@getpaseo/server@0.14.0`）或合成状态探针复现；修复核查用 `git archive 2f71225` 基线副本取
「修前红」，不采信提交信息。未执行：真实模型回合、真实 daemon 撤回、Paseo App 真机 UI、
压力/峰值内存、iOS/Android、真实 registry 归档往返、Paseo <0.14 兼容性、macOS 签名 bundle。
生成桥用字节一致性检查；第三方依赖未逐行审计。
`plugin-process` lane 一处探针事故（`DSH_BINARY` 指向不存在路径时静默回退到 `dsh`，短暂启动
真实 `dsh --profile paseo`）已在主报告 §9 与分区报告 §5.1 如实记录，无残留。
