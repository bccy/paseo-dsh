# 2026-10-31 审查证据索引

主文档：[全量审查](../../FULL-AUDIT-20261031.md) · [架构与实施路线](../../ARCHITECTURE-ROADMAP-20261031.md)。基线是 `9298c28`。

## 阅读顺序

1. 先读主报告的三个 P1 与架构结论。
2. 用下面的分区报告查看准确位置、触发条件、正常对照和修法边界。
3. 实施前按路线图选择一个工作包，将对应反例转换为“修复前失败、修复后通过”的正式回归。

| 材料 | 内容 |
|---|---|
| [bridge.md](bridge.md) | 20 个桥文件；BR-01–08，文件恢复/派发因果/plan/MCP/图片缓存 |
| [server.md](server.md) | provider/process/session/timeline/bootstrap/shared；S01–08，其中 S08 为静态闭环 |
| [client-delivery.md](client-delivery.md) | 客户端、安装、自检、能力探测、可选补丁；C1/C2/D1/D2/L1 |
| [harness.md](harness.md) | 测试体系与 T01–04；哪些“通过”不能证明宣称的结论 |
| [coverage.csv](coverage.csv) | 基线 193 个 tracked 文件的范围、审查方式与材料归属 |
| [harness-inventory.csv](harness-inventory.csv) | 68 个 harness 文件的执行环境、依赖、副作用、清理、判据和残余风险 |
| [test-results.json](test-results.json) | 47 个现有检查与基础检查的实际执行结果、定向证据摘要；路径为归一化标签 |
| [reproduction-results.json](reproduction-results.json) | 本目录可移植复现材料在冻结副本上的执行记录；10 个批次均确认历史反例 |
| [sources.json](sources.json) | 实时查询的 npm / release / 官方源码 / PR 来源、提交与摘要 hash |
| [alpha-package-diffs.json](alpha-package-diffs.json) | 解包比较过的 alpha npm 包、版本/完整性标识与变化文件摘要；不是升级通过记录 |

分区报告是主代理逐项复核后的证据附件；没有把“源码有可能如此”写成“生产已经如此”。主文档负责优先级、跨分区去重和最终方案。外部项目的源码证据仅覆盖相关契约，未声称对 DSH/Paseo 全仓做了审计。

## 复跑本次反例

当前机器上的可移植 runner 已验证。它仅运行历史缺陷的无模型复现，默认冻结到 `9298c28`；不运行生产 `plugin-check`、`route-test` 或 `tools`。

```bash
python3 docs/audits/20261031/reproductions/run.py

# 也可只复跑一个批次
python3 docs/audits/20261031/reproductions/run.py --case bridge
python3 docs/audits/20261031/reproductions/run.py --case server-open
python3 docs/audits/20261031/reproductions/run.py --case harness
```

前提是已有本仓 `paseo-plugin/node_modules`（`@getpaseo/plugin` 0.14.0）及 DSH 0.2.1-rc.5 的已安装库。若 DSH 不在默认安装目录，通过 `DSH_INSTALL_DIR` 指定。runner 不下载或安装依赖，不改变用户 HOME。

它在临时目录用 `git archive` 建冻结副本、链接现有依赖、检查契约/资产/类型后编译；每批独立 Node 进程，使用私有 DSH_HOME、PASEO_HOME、TMPDIR，移除继承的测试控制变量和 NODE_OPTIONS。并发 open 的假桥从基线源文件加四行延迟构造，不另存一整份重复假桥。输出目录会打印出来，保留源码副本和日志供复核。

**这些是反例，exit 0 的含义是“确认旧缺陷仍可复现”，绝不是“产品已修复”。** 所有探针的正反观测均由脚本或 runner 断言。以后修复产品后，可显式用 `--ref` 选择新提交进行比较；反例不再成立而退出非零是预期的变化，正式回归应改为断言修复后的正确行为。

| `--case` | 对应问题 | 证明边界 |
|---|---|---|
| `bridge` | BR-01–08 | 真实 bridge/FileSnapshots/gateway，私有文件、loopback 与合成服务时序 |
| `server-open` | S01 | 真实 provider/stdio，commands 回包延迟与健康 sibling 对照 |
| `server-config` | S03/S04 | 真实 DshSession，状态化传输替身，成功对照 |
| `server-lifecycle` | S05/S06/S07 | 真实 DshSession，合成事件序列 |
| `doctor` | D1 | 真实 runDoctor、真实 YAML 结构、合成 CLI/version/凭据；不验证网络连通 |
| `probe-auth` | D2 | 真实 runProbe + mock fetch，401/402/403 与 429 对照 |
| `tool-errors` | C1 | 真实 TimelineBuilder→toolCallData，未真正编辑任何业务文件 |
| `thinking` | C2 | 真实组件 + 最小 hooks dispatcher，非设备 UI 验收 |
| `patch-tail` | L1 | 仅提取纯字符串变换；未导入/调用 apply/revert 文件写入口 |
| `harness` | T01–04 | 原判据 VM；T02 调真实 bridge 的无模型校验 |

S02 的 catalog/session modes 结果在主报告和原始复核记录中；S08 未用真实 CLI 创建/发送任何业务动作。二者不冒充本 runner 的动态验收项目。现有 47 个回归与这些反例是两种结果，不能相加后宣称“57 项产品测试通过”。

## 仍需后续验证

- 修复后的真实 DSH 回合、取消、父子文件写入、重启与撤回；
- 真实 daemon 的原版/补丁行为、重放 turnId 和 child 状态；
- iOS/Android 设备上的显示、触控、动态字体、前后台和弱网；
- alpha 的 Node/DSH/profile 全组合、实际请求路由和长期会话性能。

本目录不包含真实会话日志、API key、生产 profile 或下载的上游源码/二进制。所有产品修复、升级、部署与发布仍属于下一阶段。
