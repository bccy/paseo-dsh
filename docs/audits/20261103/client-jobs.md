# 客户端 jobs 功能审查（client-jobs，2026-11-03）

- 审查对象：`main` HEAD `0c82df5`（`git log --oneline -8` 已核；工作区只有未跟踪的 `V1.txt` / `v1.txt` 与审查目录 `docs/audits/20261103/`，未改动任何 tracked 文件）。
- 范围（逐行全文，非抽样）：`paseo-plugin/client/jobs-pill.tsx`(665)、`jobs-polling.ts`(450)、`jobs-popover-layout.ts`(429)、`jobs-spinner.tsx`(210)、`shared/jobs.ts`(189)、`poll-sequence.ts`(69)；另读 `client/locale.ts` 的 jobs 表、`index.client.tsx` 的接线、`server/session.ts|provider.ts|dsh-process.ts` 的 jobs 读取链、`dsh-bridge/lib/server.js` 的 `paseo/jobs` 投影。
- 相关 diff：`git show e7472be`（本轮重点）、`git show 6394809 -- paseo-plugin/client/jobs-pill.tsx paseo-plugin/client/jobs-polling.ts`。
- 宿主对照：本地 Paseo checkout `~/apps/paseo`（`88f8eb59d`，`packages/app|protocol` 版本 0.14.0，与 `paseo-plugin/node_modules/@getpaseo/*` 0.14.0 同源）；DSH 安装包 `@deepseek-ai/dsh` 0.2.1-rc.5 的 `dsh-client-ui-jobs/lib/client.js`。
- 文档对照：`docs/FULL-AUDIT-20261102.md` §4.1 CJ-01..04、§10.1 p6-jobs 行；根 `AGENTS.md:219-220` 的「客户端脉冲……断言要打在数据层」；`docs/FIELD-NOTES.md`（**无** jobs/pill/轮询专条，唯一提及 `:2772` 是 `jobs.list` 被用作 paseo 句柄捕获点，与本 lane 语义无冲突）。**任务书提到的 `docs/AGENTS.md` 在本仓库不存在**，约束以根 `AGENTS.md` 为准。
- 证据分级：**【实测】**＝本轮命令跑出并记 exit code；**【源码推断】**＝读产品/宿主源码；**【文档】**＝仅文档依据。未执行真实 daemon、真实 `~/.dsh` profile、真实模型、装包。

## 1. 范围与方法（本轮实跑清单）

离线全部可复跑，命令与结果（工作区只产生 gitignored 的 `.dbg*/` 编译产物）：

| # | 命令（工作目录） | 结果 |
|---|---|---|
| 1 | `paseo-plugin && ./node_modules/.bin/tsc --noEmit -p tsconfig.json` | **exit 0** |
| 2 | `paseo-plugin && ./node_modules/.bin/tsc -p ../harness/jobs-poll.tsconfig.json` → `.dbg-poll` 下 `node jobs-poll-check.cjs` | 编译 exit 0；**100/100 checks passed，exit 0** |
| 3 | `paseo-plugin && ./node_modules/.bin/tsc client/jobs-popover-layout.ts --outDir .dbg-jobs ...` → `HOST_APP=~/apps/paseo node jobs-popover-check.cjs` | 编译 exit 0；**218/218 checks passed，exit 0**（含宿主常量半场） |
| 4 | `paseo-plugin && ./node_modules/.bin/tsc client/locale.ts client/tool-call-data.ts --outDir .dbg ...` → `node locale-check.cjs` | **269 passed, 0 failed，exit 0** |
| 5 | 自建探针 `/tmp/cj-probe-20261103.cjs`（复用 `.dbg-poll` 编译产物，假时钟驱动真实 `createJobsPoller`） | **17 checks, 0 failures，exit 0** |
| 6 | 自建探针 `/tmp/cj-probe2-20261103.cjs`（竞态/分页/失败保留） | **13 checks, 0 failures，exit 0** |

探针 5 的关键量化（10 个 DSH agent 快照、答案恒为 `available:true, jobs:[]`、假时钟 60s）：

```
60s 内 RPC 次数（10 agent × 16 轮，含 t=60s 边界） = 160
每次 poll 都 publishState（无变化比较）          = 160
20 agent 首轮延迟全部落在 [0,1000)ms             = true
```

即**单个客户端**、**全部 pill 都隐藏（0 live）**的常态下，仍有约 **2.7 RPC/s** 且每次 poll 都向宿主重发一次按钮状态。

## 2. 健康度评分：**3.2 / 5**（上轮 2.9）

| 维度 | 分 | 理由 |
|---|---|---|
| 正确性 | 4 | live-only 语义与 e7472be 一致（`jobsPillPresentation` 行为化断言通过）；排序/拆分与 DSH `ordered()` 一致；竞态、分页、终态码实测成立。扣分：live-only 下的死分支与注释自相矛盾；短于轮询间隔的任务永不显示（语义边界未文档化） |
| 健壮性 | 3 | in-flight 跳过、全局单调序号、entry 身份、AbortController、定时器 `unref`/清理齐全且实测无泄漏。扣分：首次 `agents.list` 失败后整 app 生命周期无 pill 且无重试；终态错误路径与 `remove()` 不对称（entry 残留） |
| 可维护性 | 3 | 分层干净（规则/布局/文案/渲染分离），注释信息量高。扣分：`allSettled` 分支与 `expanded` 的空闲默认值已不可达但保留，注释仍称其「transient 可达」；harness 正则反过来钉死该死行；未用 API 面（`latest`/`invalidateAll`）仍在 |
| 契约一致性 | 4 | `available`/`error.code` 三层一致（服务端 `provider.ts:2072` 总会填 `message`，client 侧 zod 输出校验不会因缺字段炸）；`AGENT_DIRECTORY_PAGE_SIZE=200` 与协议 `limit.max(200)` 完全一致；分页 `pageInfo` 已消费。扣分：状态标记偏离 DSH 原生且注释称「来自宿主状态语义」 |
| 性能 | 2 | 隐藏态 4s 全速（e7472be 显式恢复）、每轮无条件 `publish`+`registration.update`、每轮返回全部 settled job（label 为未截断原始命令）、多客户端相乘；仅 jitter/backoff 缓解。与上轮同分，修复轮的隐藏 15s 被回退 |
| 安全 | 4 | 只读 RPC；权限拒绝被识别为终态；无凭据/本机路径进入文案。扣分：错误 message 原样展示可能含内部诊断串（基线问题） |
| 测试覆盖 | 3 | 控制器从 JSX 抽出后有 100 条行为断言（假时钟/假 RPC/假目录页），popover 几何与宿主 parity 218 条；`locale` 269 条。扣分：`publishState`（store→registration.update）与 popover 折叠/订阅仍只有源码正则，CJ-02 的死分支正是被正则钉住的 |

**一句话**：语义定案（route 2）与控制器行为化是这轮真正的进步，分页/终态码也落地了；剩下的实质问题是**轮询放大只修了一半**（隐藏 4s 全速被显式恢复）和**live-only 遗留死分支/注释不一致**，无 P0/P1、不阻断发布。

## 3. 发现列表

| ID | 级别 | file:line | 触发条件 | 证据等级 | 归属 | 摘要 |
|---|---|---|---|---|---|---|
| CJ-01 | **P2** | `jobs-polling.ts:52,176-180,339,371`；`jobs-pill.tsx:525-551`（`:528` publish、`:550` update） | 常驻：任何非 closed、`workspaceId` 非空的 DSH agent（**跨全部 workspace**），每客户端一份 | 【实测】+【源码推断】 | e7472be 恢复隐藏 4s（刻意取舍）+ 修复轮未做变更比较 | 轮询总量放大未收敛：隐藏态仍 4s 全速（10 agent/60s=160 RPC，实测）；每轮无条件 `publish`+`registration.update`（160/160，实测），宿主 `update()` 无条件 `replace`+`publish`（宿主 `buttons/model.ts:120-130`）；多客户端相乘（每个 app 客户端各自加载一份插件客户端 bundle，`registry.ts:115`）；每轮载荷含全部 settled job 且 label 为原始命令（桥 `server.js:3104-3127`）。`§10.1` 仍记上轮 CJ-02 为 fixed，口径过强 |
| CJ-02 | P3 | `jobs-pill.tsx:420-433`（allSettled 分支）、`:441`（`settledOpen ?? live.length === 0`）、`:354-360`（注释）；`harness/jobs-popover-check.cjs:455-456` | 任何 pill 可见且 popover 打开的时刻 | 【实测】+【源码推断】 | 修复轮 6394809 引入 route 1 → e7472be 改 route 2 后遗留 | live-only 下「后台任务都已结束。」分支与 `expanded` 的空闲默认值**不可达**：可读答案 visible⇒live>0⇒jobs 非空；不可读答案走错误分支；宿主对 `visible:false` 的 `update()` 强制关闭 popover（宿主 `model.ts:126`），且不可见按钮不渲染/不可打开（`model.ts:137-140,171-180`）。e7472be 只把注释改成「last job's answer 应用中的 transient」，但该窗口最多一帧且宿主同批关掉 popover。harness 的正则仍在钉死行，妨碍清理 |
| CJ-03 | P3 | `jobs-polling.ts:317-324`（终态分支）vs `:289-296`（`remove()`） | 收到 `bridge_too_old` / `registry_missing` 时 | 【实测】 | 修复轮 6394809 新引入 | 终态分支直接 `host.removeAgent(...)` 而非 `remove()`：entry 留在 `agents`、`sequence` 未 invalidate。实测后果：终态后 `drop()` 会二次调用 `removeAgent`（pill 层 `jobs-pill.tsx:585-592` 幂等，无用户可见影响）；`upsert` 不重建（harness 有意断言）；重连快照 `applySnapshot` 可恢复（实测：重新 added/read）。属一致性问题，非功能缺陷 |
| CJ-04 | P3 | `jobs-pill.tsx:630-659` | 插件客户端加载时 `paseo.agents.list({subscribe})` 首次失败（daemon 未就绪/重连窗口） | 【源码推断】 | 基线 87b5e6e（上轮 CJ-08 未修） | 只打一条 console，**整个 app 生命周期不再重试**，所有 agent 无 jobs pill。owned subscription 本身会在重连后重发快照，但 `.then` 未执行 → 从未 `subscribe(observer)` → 快照投递给空（`@getpaseo/client/dist/connection/owned.js` 的 `deliver/subscribe`）；且插件安装按 `clientBundle` 保留、重连不会重跑客户端入口（宿主 `registry.ts:52-97`）。恢复只能靠 app 重启/插件 reload |
| CJ-05 | P3 | `harness/jobs-popover-check.cjs:449-530`；`jobs-pill.tsx:385-493`（popover）、`:525-551`（publishState） | 回归/重构时 | 【实测】+【源码推断】 | 基线 + 修复轮部分改善 | 测试覆盖仍偏：控制器（可见性/间隔/分页/终态）已是行为断言（100 条），但 `publishState` 的 store→`registration.update` 接线、popover 订阅/清理/折叠仍只有源码正则；`expanded` 的死分支正是被 `:455-456` 正则钉住而通过。AGENTS.md「断言打在数据层」在本 lane 只覆盖到控制器层 |
| CJ-06 | P3 | `jobs-popover-layout.ts:288-333` | 查看 popover 行首标记时 | 【源码推断】 | 基线 87b5e6e（上轮 CJ-05 未修） | 状态标记偏离 DSH 原生：DSH `dotState` 为 `stopping/killed→warning`、`completed→done`（DSH 0.2.1-rc.5 `dsh-client-ui-jobs/lib/client.js:101-113`），插件是 `stopping→ring`、`killed/completed→border`。注释首句「from the host's own state semantics」过强；可读性上 status 文案仍能区分，属显示层取舍 |
| CJ-07 | P3 | `jobs-polling.ts:52,146-149`；`README.md:26`、`README.en.md:29` | 后台任务存活时间短于一次轮询（<4s）；或 registry 不可读 | 【实测】+【文档】 | e7472be 语义 + 基线 | 两个未文档化的语义边界：① live-only + 4s 粒度 ⇒ **短命任务永不显示 pill**（实测：t=0 空、t=1s 起跑、t=3s 完成、t=4s 才轮询 → 全程无可见状态）；② `available:false` 时即使 0 live 也保持可见（`jobs-polling.ts:146`，基线的「失败要响亮」），与 README「只在有运行中/停止中时显示」的绝对表述冲突，例外未写 |
| CJ-08 | P3 | `poll-sequence.ts:25-26,52-54`；`jobs-pill.tsx:394-405`；`jobs-polling.ts:376-380` | 静态阅读/未来改动 | 【源码推断】 | 基线 87b5e6e（上轮 CJ-07/CJ-09/CJ-13 遗留） | 遗留低风险项：`latest()`/`invalidateAll()` 仅 harness 调用（未用 API 面）；popover effect 若在 store 行缺失时挂载则永久不再订阅（主路径不可达：pill 首轮后才可见）；`register()` 对已有 entry 只更新 `agent`，`workspaceId` 变化不重建 pill（协议中 agent 不迁移 workspace，低可达） |

级别口径：P0=数据丢失/安全灾难；P1=会话可用性/恢复正确性；P2=功能/数据/契约（本表唯一 P2 为性能项，沿用上轮口径）；P3=显示/可维护性。

## 4. 阴性结论（实测/源码确认「不是问题」的点）

1. **定时器与清理**：`clearTimer`/`remove`/`removeAll`/`dispose` 四路对称；探针实测 `dispose()` 后无残留定时器；cleanup 由 `index.client.tsx:236,243,257-260` 组合调用（注释明确「两者都保留」）。
2. **竞态守卫**：实测「drop 后在飞答案不发布」「重连快照后旧快照在飞答案不写新 entry」；in-flight 跳过使慢 daemon 不会叠请求；序号全局单调且 `invalidate` 不会重发旧号。
3. **上轮 CJ-03（分页，P2）已修**：首页 `pageInfo` 被消费、`nextCursor` 逐页传递、`MAX_AGENT_DIRECTORY_PAGES=50` 截断、分页失败/`hasMore` 无 cursor 均记录一次 `onError`（探针实测 R3/R4/R5）；`AGENT_DIRECTORY_PAGE_SIZE=200` 与协议 `packages/protocol/src/messages.ts:1297` 的 `limit.max(200)` 一致。
4. **上轮 CJ-04（终态错误码，P2）已修**：`bridge_too_old`/`registry_missing` 停轮询、移除 pill、120s 内不再请求（探针实测）；瞬时 `rpc_failed` 保留退避 8→16→30s 并回到 4s（探针实测）；错误码经 `shared/jobs.ts` 单源，服务端 `dsh-process.ts` 归一化。
5. **权限拒绝**：`access_denied` 两种形状（code / message 前缀）都识别；停止并移除，后续 upsert 可重建（harness 断言）。
6. **契约形状**：`provider.ts:2072` 总会把 `error.message` 填上，`jobsList` 输出 schema 的 `message: z.string()` 不会被服务端缺字段击穿；`client.rpc` 的输出解析在客户端（宿主 `actions.ts:36` → `callPluginRpc`），因此这条填充是必要的——已验证存在。
7. **排序/拆分**：`orderJobs` 与 DSH `ordered()` 逐条一致（live 按 startedAt，settled 按 finishedAt 降序、同毫秒回落 startedAt），不 mutate 输入；`splitJobs` 与 `isLiveStatus` 共用 `LIVE_JOB_STATUSES`，无第二份字面量。
8. **宿主订阅语义**：`agents.list({subscribe})` 的初始快照在 `subscribe()` 时投递（`owned.js` 的 `deliver`），重连 `restore()` 会重发快照；pill 不依赖 `.list()` 的返回值，故「初始快照没处理」不成立。
9. **动画/图标**：web 用 WAAPI（`startTime=0` 同一时间线）、native 用 `Animated.loop` 且卸载 `stop()`+归零；`icon` 只在 mark 变化时 patch，e7472be 后「可读答案恒为转环」使 patch 只在 `available:false` 翻转时发生，不会每轮重启动画。
10. **live-only 是否自洽（本 lane 核心问题）**：`jobsPillPresentation` 的行为断言通过（无 live 隐藏、live 计数、不可读可见+静态 mark、可读答案不选静态 mark）；「已完成」分组/表头在**多任务**场景可达（live>0 + settled>0），不是死代码；真正不可达的只有 `allSettled` 与 `expanded` 的空闲默认值（CJ-02）。与 DSH 原生行为（history-visible、idle 显示总数并默认展开 settled）是**用户既定语义下的有意分歧**，不是实现错误。
11. **文档口径**：`README.md:26`、`README.en.md:29`、`paseo-plugin/README.md`、`docs/HARNESS.md:82-88` 已与 live-only 对齐，全仓 grep 无「空闲时显示已完成总数 / total when idle」残留；`docs/FULL-AUDIT-20261102.md §10.1` 已改为路线 2。唯一过强的是同一行仍把上轮 CJ-02 记为 fixed（见 CJ-01）。
12. **e7472be 与修复轮不互相覆盖**：`idleLabel`/`HIDDEN_POLL_MS`/`lastVisible` 删除后无残留引用（grep 仅剩 harness 的「必须不存在」断言）；`PillIcon` 与 `presentation.icon` 的类型化替换完整；两轮差异集中在隐藏轮询间隔，且注释与 harness 均显式记录，不是静默覆盖。

## 5. 未验证项

1. **真实 daemon / 真机 UI**：未启动 daemon，未验证 pill 在真机的显示/隐藏时机、popover 被 `visible:false` 强制关闭的观感、动画与 compact sheet 表现（沿用上轮证据边界）。
2. **多客户端相乘**：结论为「单客户端实测 + 宿主架构源码推断」（每个 app 客户端各自 `runPluginClientBundle`），未用两个客户端同时连同一 daemon 实测 RPC 倍数。
3. **wire 字节**：未实测每轮 `jobs.list` 载荷（settled 历史 × 原始 command 长度），只做了「桥返回全部 settled、label 未截断」的源码确认与算术估计。
4. **>200 agent 的真实分页**：未构造 201+ agent 的实例；结论来自假 RPC 驱动的 controller 实测 + 协议/服务端源码。
5. **`registry_missing` 是否真不可恢复**：读桥 `ctx.get('jobs')` 与 profile 组合推断为「静态缺失、需重启」，未在真机复现 jobs service 延迟挂载的场景。
6. **宿主 checkout 与运行时一致性**：宿主行为结论读的是 checkout `88f8eb59d` 的 `packages/app` 源码（版本 0.14.0，与已装 SDK 同版本号），未逐字节比对运行时 dist。

## 6. 跨 lane 提示（不在本 lane 写域，未裁决）

1. **server lane**：`paseo-plugin/server/dsh-process.ts:421` 注释仍引用 `` `POLL_MS` in `client/jobs-pill.tsx` `` ——该常量已改名 `LIVE_POLL_MS` 并移到 `client/jobs-polling.ts`，且 e7472be 改了隐藏间隔语义；注释应同步（`JOBS_READ_TIMEOUT_MS` 15s 与 4s 轮询的关系仍成立）。
2. **bridge lane**：`dsh-bridge/lib/server.js:3104-3127` 每次 `paseo/jobs` 都返回该 session 全部 job（含 settled 历史）且 `label` 是未截断原始命令，没有 `liveOnly`/`revision` 之类收窄手段——CJ-01 的载荷放大有一半根因在桥侧；客户端只能整包收。
3. **docs lane**：`docs/FULL-AUDIT-20261102.md §10.1 p6-jobs` 把 CJ-02 记为 fixed，与 e7472be 显式恢复的「隐藏 4s 全速」不符，建议改为「部分修复：退避/抖动保留，隐藏降频按用户语义回退」。
4. **locale lane**：route 2 下 `locale.ts:399/611` 的 `allSettled`（「后台任务都已结束。」/“All background tasks have finished.”）与 CJ-02 死分支绑定，清理死分支时应一并处理文案。
5. **宿主升级复查**：CJ-02 的死代码判定依赖宿主 `buttons/model.ts:126`（`visible:false` 的 `update()` 强制关 popover）与 `:171-180`（不可见按钮不渲染）。若 Paseo 改变该行为，`allSettled`/空闲展开会重新可达，需在跟版时复查。
6. **产品/后续**：若将来想回归 DSH 原生的 history-visible（trigger 显示 idle 总数、默认展开 settled），改动点是 `jobsPillPresentation` + CJ-02 死分支 + `locale.ts` 的 idleLabel + harness 的 CJ-01 断言组；本轮不擅自改语义。
