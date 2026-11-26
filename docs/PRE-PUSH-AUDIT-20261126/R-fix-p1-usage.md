# R P1-2 复审（用量 seeded 切点）

状态: pass

## 判定
修复成立、可放行。切点取「最后一个 `data.inherited === true` 的 `session/end-seed` 的 `seq`、只统计 `seq > 切点`」的语义与已安装 DSH v4 解码器/构造器一致；9 个真实 seeded 文件旧→新精确剔除 429 条 / 78,297,052 tokens，own 273 条 / 50,131,522 tokens 与独立复算逐文件一致；非 seeded 文件旧/新解析逐字段完全相同。

## 独立验证
- `cd paseo-plugin && node --test test/usage-stats.test.cjs` → tests 8 / pass 8 / fail 0；`npx tsc --noEmit` → exit 0。
- 语义依据（已安装 DSH 源码，非本仓库）：`@deepseek-ai/dsh-session-format-v1-to-v2/lib/index.js:251-252` 逐行以最后一个 inherited marker 覆盖 `inheritedEventCount`，`:256-258` seeded 缺 marker 即格式错误；`@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:996-999` 要求 inherited cut 等于最后一个 inherited marker；`@deepseek-ai/dsh-session/lib/types/fork.js:18-25` fork 复制前缀后追加 marker（seq = boundary+1），故 fork 再 fork 叠乘时必须取最后一个。
- 交叉验证：直接用已安装 DSH 的 `releasedV4SessionFormatCodec` 解码 9 个真实 seeded 文件，其 `inheritedEventCount` 与独立复算（最后一个 inherited marker 的 seq）9/9 相同：2301 / 224 / 106 / 211 / 98 / 277 / 154 / 154 / 154。
- A/B（`git show HEAD:` 导出旧版到 /tmp；真实会话只读，未写 `~/.dsh`）：9 个 seeded 文件 old = 702 条 / 128,428,574 → new = 273 条 / 50,131,522，剔除 429 条 / 78,297,052；逐文件 new 调用数与 token 总和均等于「切点后逐行独立统计」，old = 独立 own + 独立 inherited。
- 回归：40 个非 seeded 真实文件旧/新 `parseSessionJsonl` 输出逐字段完全相同；同一 seeded 内容以未压缩 `.jsonl` 放入隔离 DSH_HOME，引擎 totals 与 zstd 版一致。
- 旧缓存：隔离 DSH_HOME 里伪造 version=1、mtime/size 与真实文件吻合、含旧双计 321 条的缓存 → 引擎忽略并重算为 version=2，totals requests=26 / totalTokens=9,780,841（与 own-only 复算一致）；缓存为纯派生数据，不涉用户数据丢失。
- corrupt：seeded 缺 marker 抛错走既有 corrupt 路径（近 10s 修改不落缓存以便重试，否则缓存 `calls: []` + corrupt）；引擎级用例断言 refresh 报告 corrupt=1 且另 2 个文件正常计数，错误不外溢。
- 测试有效性（/tmp 副本变异，未改工作区）：基线 8/8；切点改「第一个 inherited marker」→ parse 用例红；删切点过滤 → 2 个新用例红；删「缺 marker 抛错」→ 2 个新用例红。夹具为真实 v4 形态（header isSeeded + inherited marker + 前缀含 usage + own 含 usage + 转义引号干扰行 + 普通 `{}` end-seed），断言打在真实引擎输出上。

## 问题
无 P0/P1/P2 缺陷。1 项 P3 观察（不阻塞）：`server/usage-stats.ts:331,401,525` 使 seeded 的 own 调用不再继承父前缀的 `request/context.contextWindow`——273/273 条 own 记录与旧版仅此字段不同（旧=1,000,000，新缺省）；该字段在本仓库只写缓存、无读取点，当前无可见影响。

## 未验证项
- 本机无「fork 再 fork」真实样本（9 个文件均只有 1 个 inherited marker）；叠乘语义由 parse 级夹具（seq 3 与 seq 5 两个 marker）覆盖、变异 M1 证明断言真实生效，但未做真机 fork-of-fork 端到端。
- 引擎级夹具 seq 非 dense（10/15/20/25/26/30/35），真实 v4 必 dense；切点语义不受影响，parse 级夹具为 dense 0..8。
- 未跑全量 `node harness/offline-checks.cjs`（按任务约定由 Lead 统一跑）；未重跑其它测试文件。
- 复审时工作区指纹：`usage-stats.ts` sha256 5456f52f…、`usage-stats.test.cjs` sha256 83b32c63…（其后若再改动需重跑验收）。
