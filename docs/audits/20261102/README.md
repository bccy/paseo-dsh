# 2026-11-02 全量代码健康度审查证据索引

- 审查基线：`2f71225`（main，工作区干净）；上一轮 `9298c28`（[FULL-AUDIT-20261031](../../FULL-AUDIT-20261031.md)）
- 主报告：[全量代码健康度审查（2026-11-02）](../../FULL-AUDIT-20261102.md)
- 环境：DSH `0.2.1-rc.5`、Paseo `0.14.0`、Node v22.23.1
- 分工：21 个只读审查 lane，全部 fresh context、只读运行；未改产品代码、未 git 写、未跑真实模型/daemon

## 阅读顺序

1. 先读主报告的「结论」与「上一轮问题修复核查」。
2. 按区域读分区报告，每条发现都带 `file:line`、触发条件、证据等级与基线归属。
3. 测试体系结论以 `verify-runner.md`（实跑）与 `harness-*.md`（判据质量）为准，两者不要混读。
4. 「全绿」的含义见主报告 §5：56/56 通过，但不等于发布判据。

## Lane 索引与结论

| Lane | 范围 | 结论摘要 | 报告 |
|---|---|---|---|
| bridge-server-core | `dsh-bridge/lib/server.js` 请求分派/会话/权限/plan/MCP/usage | 4 P2 + 12 P3，无 P0/P1；P2 均为基线未修 | [bridge-server-core.md](bridge-server-core.md) |
| bridge-server-rewind | `server.js` 撤回/文件计划/子代理 | 核心修复成立；3 P2（2 条新引入），无阻断 | [bridge-server-rewind.md](bridge-server-rewind.md) |
| bridge-files | file-snapshots / file-mutation-gate / snapshot-owners / revert / surface | BR-01/02 修复成立；3 P2 边界（symlink、并发捕获、半成功回执） | [bridge-files.md](bridge-files.md) |
| bridge-mcp | mcp-gateway / mcp-http / mcp-stdio / transport / envelope / approval | 2.9/5；BR-06/BR-07 未修 + BM-03 结果未校验 | [bridge-mcp.md](bridge-mcp.md) |
| bridge-misc | index / projections / archive / anchors / cancel / lineage / image | 3.0/5；BR-03、BR-08 未修 | [bridge-misc.md](bridge-misc.md) |
| plugin-session | `paseo-plugin/server/session.ts` | 3.0/5；S02–S07 五项 P2 未修，live/replay 终态口径不一 | [plugin-session.md](plugin-session.md) |
| plugin-provider | provider.ts / bootstrap.ts | 3.6/5；de4ba8c 修复成立；S02/S08 与 bootstrap 非原子待修 | [plugin-provider.md](plugin-provider.md) |
| plugin-process | `paseo-plugin/server/dsh-process.ts` | 3.1/5；close/prompt 竞态与出站无背压两条 P2 | [plugin-process.md](plugin-process.md) |
| plugin-timeline | timeline / frame-reader / first-token / activity-timeline / canary / json-value / locale | **4.0/5，全仓最高**；7 条 P3，无 P2 | [plugin-timeline.md](plugin-timeline.md) |
| client-toolcall | tool-call-data / tool-call / tokens / agent-message | 3.3/5；C1 未修、终端 6000 截断两条 P2 | [client-toolcall.md](client-toolcall.md) |
| client-jobs | jobs-pill / popover-layout / spinner / shared/jobs / poll-sequence | 2.9/5；新功能 4 条 P2（完成分组不可达、轮询放大、分页、终态错误） | [client-jobs.md](client-jobs.md) |
| client-misc | locale / newest / thinking / stream-stats / sweep / shimmer / index.client | 3.4/5；C2 未修 + 一批 locale/清理 P3 | [client-misc.md](client-misc.md) |
| local-patches | apply-rewind-history-truncation / check / startup-hook | 2.7/5，全仓最低；L1 未修（stale 重建删 tail）+ checker 门禁不一致 | [local-patches.md](local-patches.md) |
| delivery | doctor / probe / bin / scripts / manifest / CI / 入口 | 3.0/5；D1/D2 未修（doctor/probe 假绿）；CI 冲突清单漏 4 门 | [delivery.md](delivery.md) |
| harness-bridge | 桥相关 harness 判据质量 | 3.4/5；H-01 入口钩子无双证、H-02 祖先 symlink 无覆盖 | [harness-bridge.md](harness-bridge.md) |
| harness-plugin | 插件/客户端/交付 harness 判据质量 | 3.4/5；T01–T04 假绿仍在；真实 profile 脚本无隔离 | [harness-plugin.md](harness-plugin.md) |
| fix-verify-server | 上轮 S01–S08 修复核查 | S01 已修复；S02–S08 全部未修复 | [fix-verify-server.md](fix-verify-server.md) |
| fix-verify-bridge-client | 上轮 BR/C/D/L/T 修复核查 | BR-01/02 已修复；其余产品与测试判据问题未修 | [fix-verify-bridge-client.md](fix-verify-bridge-client.md) |
| docs-consistency | 13 份文档 vs 实现 | 4 P2 + 11 P3；版本声明/进程模型/图片三处事实漂移 | [docs-consistency.md](docs-consistency.md) |
| verify-runner | 当前 HEAD 全量离线执行 | **56/56 通过、0 失败、0 环境缺失**；13 项按范围未执行 | [verify-runner.md](verify-runner.md) |
| health-crosscut | 全仓横切模式 | 3.4/5；HC-01 分帧双实现漂移、HC-02 失败只写 stderr 等 5 条 P2 | [health-crosscut.md](health-crosscut.md) |

## 跨 lane 校正

- `plugin-timeline` 复核指出 `health-crosscut.md` 的 HC-13「activity-timeline.ts 无 harness 引用」
  不成立：`harness/p003-timeline-check.cjs` 经真实 `TimelineBuilder` 间接覆盖 8 项并实跑通过。
  真实缺口是该脚本未登记 `AGENTS.md` harness 清单、未进 CI（归 harness/docs 收口）。
- `fix-verify-bridge-client` 指出归档复现脚本 `reproductions/bridge-extra-repro.mjs:40` +
  `run.py:152-160` 是 all-or-nothing：BR-01 修复后首个断言中断，BR-02–08 的反例不再执行
  （P3 测试基建，会误导后续核查）。

## 证据边界

27 个报告中的「实测」条目分别由编译产物、假桥、loopback、真实文件系统或合成状态探针复现；
修复核查要求在当前 HEAD 副本上复跑原始反例并记 exit code，不采信提交信息。
未执行：真实模型回合、真实 daemon 撤回、Paseo App 真机 UI、压力/峰值内存、iOS/Android、
真实 registry 归档往返。生成桥用字节一致性检查；第三方依赖未逐行审计。
