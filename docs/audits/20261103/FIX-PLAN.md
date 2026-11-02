# 修复轮计划（基于 FULL-AUDIT-20261103）

- 基线：`0c82df5`（main）。每个包一个独立 worktree/分支，写入边界互不重叠。
- 执行：DeepSeek 执行代理；验证：未参与实现的 DeepSeek 验证代理；Lead 只读 diff、日志并裁决。
- 不做：push、npm publish、打 tag、重启 daemon、改真实 `~/.dsh` profile。

## 包与范围

| 包 | 发现 | 写入边界 | 必跑检查 |
|---|---|---|---|
| A bridge | BF-01、BF-02、BF-03、BSR-01 | `dsh-bridge/lib/`、`paseo-plugin/server/bridge-assets.ts`（只经生成脚本）、`harness/file-snapshot-check.mjs`、`harness/revert-check.mjs`、新增 harness | file-snapshot、snapshot-lifecycle、revert、rewind-transaction、file-mutation-gate、surface、bridge-assets、dsh-api-contract |
| B notice | NC-01、NC-03、NC-02、HB-01 | `paseo-plugin/server/rewind-notice-append.ts`、`provider.ts` 撤回段、`client/rewind-notice-data.ts`、`harness/rewind-notice-*-check.*` | rewind-notice、rewind-notice-delivery、revert-check、host-contract-sim、tsc |
| C session/process | PS-01、PPR-01、`resolveBinary` 静默回退（P3） | `paseo-plugin/server/session.ts`、`dsh-process.ts`、对应 harness | session/process 相关假桥检查、plugin-check --self-test、tsc |
| D client | CT-01、CJ-01（只改「每轮无条件 publish/update」，**隐藏态 4s 与 pill 外观不变**） | `paseo-plugin/client/tool-call*`、`client/jobs-polling.ts`、对应 harness | tool-call、jobs-poll、tsc |
| E doctor | DLV-01、DLV-02、DLV-03 及 README/doctor 修复建议 | `paseo-plugin/lib/doctor.mjs`、doctor harness、README 对应段 | doctor-check、doctor 实跑（一次性 DSH_HOME） |
| F patches | LP-01、LP-02 残余 | `local-patches/`、`harness/local-patches-check.mjs` | local-patches-check、host-contract-sim |
| G docs（A–F 合并后） | DC-01、DC-03、D15、HARNESS 登记缺口、新增检查登记 | `docs/`、`AGENTS.md`、`paseo-plugin/OVERVIEW.md` | 文档对照 |

## 暂缓 / 待用户决定

- DC-02 版本与发布线、S08/PP-02、jobs 隐藏态轮询根治：需用户决策，本轮不动。
- HP-06 编译基建统一、CI 增加 push/PR 门：改动面大且影响全部 harness，单独排期。
- `rewind-native-check`（需真实 daemon，跑在当前会话所在 daemon 上）与真机 UI：交用户本机验收。
- canary 去留：本轮不改 canary 行为；只按 §6 修正文档口径。

## 验收

每包：执行代理落盘证据 → Lead 审 diff → 独立验证代理重跑必跑检查并对一处新增检查做变异确认变红 →
Lead 合入 main（本地 commit，不 push）→ 合并后在 main 上由验证代理跑全量离线门（verify-runner 同集合）
与 `plugin-check.cjs` 全量（一次性 DSH_HOME，耗 token）。
