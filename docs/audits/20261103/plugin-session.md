# 2026-11-03 全量审查 · lane plugin-session

> 独立只读审查（fresh 上下文）。不采信其他 lane 的结论；所有【实测】均给出本 lane 亲自执行的命令与退出码。
> 基线 HEAD `0c82df5`（main）。审查前后 `git status --porcelain` 一致（仅 `?? V1.txt`、`?? v1.txt`、
> `?? docs/audits/20261103/`），未改动任何 tracked 文件，未做 git 写操作，未跑真实模型/daemon，
> 未写真实 `~/.dsh` profile，未安装依赖。

## 1. 范围与方法

### 1.1 范围

| 文件 | 行数 | 处理方式 |
|---|---|---|
| `paseo-plugin/server/session.ts` | 3549 | **全文逐行通读**（不是抽样）。本文件最后一次改动是修复轮 `6394809`（`git log -1 -- session.ts`），本轮 HEAD 与修复轮产物一致 |
| `paseo-plugin/server/provider.ts` | 2111 | 只读与 session 契约相关的段落：`toDisplayCatalog` 的 modes 过滤、`#open` 构造 `DshSession` 时传 `display.defaults.modes`、post-open 的 configure 调用面、`#display` 缓存 |
| `paseo-plugin/server/dsh-process.ts` | 3093 | 只读 `setPlan`/`setConfig`/`prompt`/`history`/`subagents`/`jobs`/`usage`/`cancel`/`closeSession` 的返回形状与超时 |
| `dsh-bridge/lib/server.js` | 4026 | 只读 `planSet`/`planGet`/`configSet`、`session.child-opened` 与 `holdChildFrame`/`openChild` 的 label 时序 |
| 已装宿主 `@getpaseo/server@0.14.0` | — | 只读 `plugin-provider.js` 的 `session.prompt_result`/`session.turn`/`activeTurnIds`/`connectionClosed`（核对修复的宿主侧前提） |
| 已装 DSH `0.2.1-rc.5` `dsh-plan-mode` | — | 只读 `PlanModeController.get/set` 的 `active`/`pending`/`outcome` 语义（核对 `configure` 的 mode 回执计算） |

对照文档：`docs/FULL-AUDIT-20261102.md` §3.2 / §10.1 p4-plugin-session 行、`docs/FIELD-NOTES.md`
第 21/22/37/41/43 条与「usage」段、根 `AGENTS.md` 硬性约束（能力声明与数据源一致、失败要响亮、
取消是取消回合不是杀进程、不硬编码 provider/model）。

### 1.2 实测（本 lane 亲自执行，全离线/纯内存；编译产物在仓库内私有树 `.dbg-ps-audit`）

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `node -e "buildPlugin({dir:'.dbg-ps-audit',force:true})"`（`harness/plugin-build.cjs`，源码集合+构建戳校验） | **0** | 私有树构建成功（不用修复轮遗留的 `.dbg-session-state`，避免在旧字节上假绿） |
| `cd paseo-plugin && npx tsc --noEmit` | **0** | 无输出 |
| `node harness/session-state-check.cjs paseo-plugin/.dbg-ps-audit` | **0** | `25/25 passed` |
| `node harness/session-request-check.cjs`（按脚本头复制进私有树后运行） | **0** | `52/52 passed` |
| `node harness/context-usage-check.cjs paseo-plugin/.dbg-ps-audit` | **0** | 15 项全 PASS |
| `node harness/replay-turn-check.cjs paseo-plugin/.dbg-ps-audit` | **0** | 8 项全 PASS |
| `node harness/thinking-check.cjs`（复制进私有树） | **0** | `51 passed, 0 failed` |
| `node harness/child-crash-check.mjs paseo-plugin/.dbg-ps-audit` | **0** | `14/14 passed` |
| `node harness/process-crash-check.mjs paseo-plugin/.dbg-ps-audit` | **0** | `13/13 passed` |
| `node harness/multi-session-check.mjs paseo-plugin/.dbg-ps-audit` | **0** | `40/40 passed` |
| `node harness/open-degrade-check.mjs paseo-plugin/.dbg-ps-audit` | **0** | `8 passed, 0 failed` |
| `node harness/subagent-check.cjs`（复制进私有树） | **0** | `90/90 passed` |
| 本 lane 探针 #1 `/tmp/ps-probe.cjs`（真实编译 `DshSession` + 假 `DshProcess`，10 组 26 项） | **0** | `26/26 passed` |
| 本 lane 探针 #2 `/tmp/ps-probe2.cjs`（无 plan 服务 profile 的 build 配置路径，4 项） | **0** | `4/4 passed` |

探针不 spawn 进程、不连 daemon、不写 profile；断言全部读 `DshSession` 自己发出的 `ProviderEvent`
或 `configState()`，不读源码文本。上表 10 个 harness 里有 9 个在修复轮被新增/加强
（除 `subagent-check.cjs` 外：`session-state-check`、`session-request-check`、`context-usage-check`、
`replay-turn-check`、`thinking-check`、`child-crash-check`、`process-crash-check`、
`multi-session-check`、`open-degrade-check`），本轮全部亲手复跑并记了退出码。

### 1.3 修复轮 p4-plugin-session 核查结论

修复轮 `6394809` 声称修了 7 条（上一轮 lane 报告编号 → FULL-AUDIT 编号）：

| 上一轮 ID | 内容 | 核查结论 | 关键证据 |
|---|---|---|---|
| S-01 / S05 | 跨回合工具统计累加、取消回合改写上一回合统计行 | **已修，成立** | `session.ts:398,1660-1670,1961-1985,2001`：新增 `#turnStarted`，只在 `running` 状态真正开始回合时重置 `#toolStarts`/`#turnTool`/`#lastStats`。探针 T7（steer 不重置、下一回合重置）与 `session-state-check` 4 组全 PASS |
| S-02 | prompt RPC 在 `started` 已发出后失败 → 回合失去终态 | **已修，成立** | `session.ts:1494-1498,1549-1561`：只有 `issuedTurn && !#turnStarted` 才清 `#turnId`。探针 T10（失败后 running 迟到仍收尾一次终态）+ harness 2 组 PASS |
| S-03 | 配置先提交本地状态、后 await 后端 | **已修，成立** | `session.ts:1717-1744,1746-1772,1774-1795`：model/effort/mode 全部在 await 回执后提交，effort 取自回执。探针 T9 + harness 5 组 PASS（拒绝时 `configState()` 不变、上下文读数不清空） |
| S-04 / S04 | 切模型不清 `#thinkingOption` | **已修，成立** | `session.ts:1735`（model 分支按回执清/设 effort）、`1771`（effort 分支同）。探针 T9 验证同一 configure 内 model+effort 的顺序 |
| S-05 / S06 | 进程退出把已完成子会话改成 `runtime_failed` | **已修，成立** | `session.ts:3002-3018`：`#turnEnded && #turnId === null` 时早退。探针 T6 双向对照（已完成不失败、运行中仍失败）+ `child-crash-check` 14/14 |
| S-06 / S07 | flush 缺 label 条件，无标题子会话被无关 flush 提前打开 | **已修，成立** | `session.ts:2291-2295`：flush 增加 label 闸门；`#labelWaitExceeded` 兜底仍可达。探针 T4（39 帧不开、40 帧开、缓冲帧按序路由）+ harness 3 组 PASS |
| S-07 / S02 | catalog 隐藏 Plan 但 `session.config` 恒报 build+plan | **已修，成立** | 会话侧：`DshSessionOptions.modes`（`:185-195`）、构造期降级（`:541-560`）、`open()` 仅在 plan 可用时调和（`:662-695`）、`configState()` 原样回发（`:742-744`）、`configure` 对未声明的 plan 响亮拒绝（`:1780-1785`）。单源链路：`provider.ts:369-371` 过滤 → `provider.ts:1600` 传入同一 `display.defaults.modes`。探针 T8 + harness 6 组 PASS |

**修复质量判断：7 条全部成立，未发现正常路径回归。** 唯一需要说明的边界：`open()` 里
「profile 不再声明 plan」的降级只进 stderr（`session.ts:553-557`），没有时间线 notice；这与同轮
「open 期降级要可见」的方向不完全一致，见 PS-07 的说明（定为 P3，不是修复失败）。

## 2. 健康度评分（1–5）

| 维度 | 评分 | 理由 |
|---|---|---|
| 正确性 | **4** | 上一轮 6 个 P2（统计、prompt 失败终态、配置提交顺序、effort 残留、子会话终态、plan 能力位）全部修复并经独立探针复验；剩余正确性缺口只有窄触发的 P3（live/replay 口径、无 plan 时 build 配置仍打后端） |
| 健壮性 | **3** | 失败路径大多响亮（root history 抛错、子代理目录失败、plan 调和失败都有 notice）；扣分在子代理历史 RPC 抛错仍只进 stderr（PS-01）、close/失败的 interrupt 不结算挂起权限卡（PS-04） |
| 可维护性 | **3** | 注释详尽且带因果；但单文件 3549 行仍同时承担翻译/状态机/统计/子会话四类职责，一个告警标志服务两个分支（PS-05），个别注释与桥的 `pending` 语义不符（见 §6） |
| 契约一致性 | **4** | modes 单源、配置回执驱动、能力位与数据源一致这三条上一轮的契约缺口已闭合；扣分在 live/replay/父/子对同一 `turn/end` 的终态口径仍未统一（PS-02） |
| 性能 | **4** | 无 O(n²) 热点；`#labelWaitExceeded` 的线性扫描受 `CHILD_BUFFER_LIMIT=2000` 约束，量级可忽略；75ms 用量合并、行按 id upsert 保持不变 |
| 安全 | **4** | 无路径/命令/凭据处理面；审批默认 deny；问题答案读取有 `isRecord` + 字符串校验 |
| 测试覆盖 | **4** | 修复轮新增/加强的 9 个回归本轮全部亲手复跑通过（10 个脚本共 316 项断言），修复前失败的边界都有对应用例；扣分在 `session-state-check` 的异步 check 未被 await（PS-09），且 S07 的 40 帧兜底与 steer 统计路径没有覆盖 |
| **总体** | **3.6** | 上一轮 3.0 的主要拖累（6 个未修 P2）已清；当前没有 P0/P1，剩下 1 条 P2（窄触发、同类路径不对称）+ 8 条 P3 |

## 3. 发现列表

> 证据等级：【实测】= 本 lane 探针/回归可复现；【源码】= 逐行读码并对照桥/宿主/DSH 源码；
> 【文档】= 文档明确记录。归属：**基线已有** = 不在 `2f71225..HEAD` 的 session.ts 改动内；
> **修复轮引入** = `6394809` 的改动引入。

| ID | 级别 | file:line | 触发条件 | 证据等级 | 归属 | 摘要 |
|---|---|---|---|---|---|---|
| PS-01 | **P2** | `session.ts:1350-1356`、`1358-1369`、`1418-1430` | 重开会话时某个子会话的 `paseo/history` RPC 抛错（60s 超时/传输失败/子进程已死） | 【实测】机制 +【源码】触发面 | 基线已有（上一轮未登记；修复轮把同类的 root history/子代理目录失败改为可见 notice，此分支遗漏） | 子代理历史读取有两种失败形状，只有 `available:false` 分支发「子代理历史读取失败」notice 并 `#dropBufferedChild`；RPC **抛错**分支只写 stderr，且回放窗口内已缓冲的帧不丢弃 → 子代理行缺失、无任何用户可见原因，缓冲帧滞留到 2000 上限 |
| PS-02 | P3 | `session.ts:2402-2407` vs `:1172-1174`、`:2929-2932`、`:3444-3449` | 旧日志/裁剪日志/其他 provider 的 `turn/end` 没有 `reason.kind`（DSH 0.2.1 的 live 事件恒有 kind） | 【实测】 | 基线已有（= 上一轮 S-08，未修） | 同一份无 reason 的 `turn/end`：live root → `completed`；replay root 与 live child → `failed`。同一会话重开前后终态可能翻转。探针 T1 三向复现 |
| PS-03 | P3 | `session.ts:2805-2806`、`:2816-2817` | 审批卡出现/超时 | 【实测】 | 基线已有（= 上一轮 S-09，未修） | 工具审批按钮 `Reject`/`Allow once` 与超时 notice 的标题/正文是硬编码英文，其余用户可见文案走 `locale.ts`；非英文环境混语言。探针 T2 |
| PS-04 | P3 | `session.ts:1901-1924`（close）、`:1871-1880`（interrupt） | 关闭/中断时仍挂着权限卡；或 `session/cancel` 抛错 | 【实测】机制 +【未验证】DSH 侧兜底 | 基线已有（= 上一轮 S-10，未修） | `close()` 不清理 `#pendingPermissions`；`interrupt()` 的清理在 `await cancel()` 之后且无 try/finally，取消失败时卡片 promise 不结算。探针 T3：close 后 `resolvePermission` 仍能结算（证明未被清理）；中断失败后卡片仍挂起。DSH 侧是否会兜底拒绝未验证 |
| PS-05 | P3 | `session.ts:2152-2157`、`:2254-2262` | 连接未协商 `session.subsession` 且随后子会话缓冲溢出 | 【源码】 | 基线已有（= 上一轮 S-11，未修） | `#childBufferWarned` 同时服务「未协商 subsession」与「子会话缓冲溢出」两个不相关分支：前者置位后，后者从「报一次」退化为永不报 |
| PS-06 | P3 | `session.ts:486-487`、`:445`、`:2544-2545` | 极长会话（每回合/每步各一个元素） | 【源码】 | 基线已有（= 上一轮 S-12，未修） | `#seenTurns`/`#seenSteps` 随回合/步数无界增长，`#childParents` 随曾出现过的子会话无界；量级小，属长期会话内存卫生 |
| PS-07 | P3 | `session.ts:662-695` vs `:1774-1795`；`dsh-bridge/lib/server.js:1289-1296` | 无 plan 服务（catalog 已隐藏 Plan）的 profile 上，客户端仍发 `configure({mode:"build"})`（例如用户点了唯一的 Build 项） | 【实测】+【源码】 | 基线已有（与修复轮 `open()` 的新跳过逻辑不一致） | `open()` 已按 catalog 跳过 `plan/set`，但 `configure` 的 mode 分支只对 `wanted===plan` 拒绝，`wanted===build` 仍调用 `paseo/plan/set`；桥在无 plan 服务时抛 `plan mode is not mounted in this profile` → 整个 configure 失败（会话本来就在 build，什么都没变）。组合 configure 时 model 半段已提交，mode 抛错使 RPC 报失败（部分应用）。探针 #2 4/4 |
| PS-08 | P3 | `session.ts:139`、`:935-963`、`:131-137` | 宿主注册链比最后一个补发延迟更慢 | 【源码】+ 现有回归 | 基线已有（= 上一轮 S-13，性质是**已声明的概率缓解边界**） | `publishUsageAfterOpen` 的 4 个延迟（0/250/1000/3000ms）仍不能覆盖慢注册；注释已明确「不是 fix」，`context-usage-check` 15 项覆盖了正向行为。复核后仍成立，不计新缺陷 |
| PS-09 | P3 | `harness/session-state-check.cjs:66-78`、`:296`；`:499-536` | 修复轮回归自身的判据 | 【源码】+【实测】重跑 | 修复轮引入（测试判据） | `check(label, fn)` 是同步函数，但 `:296` 传入 `async () => …`：断言失败只会变成 unhandledRejection 使进程崩溃，不会计入 `failed`/打印 FAIL；且该文件未覆盖 S07 的 40 帧兜底与 steer 统计路径（本 lane 探针 T4/T7 另测）。当前用例能过，判据强度低于同轮其它回归 |

### PS-01 细节（唯一的 P2）

`replaySubagents()` 对每个子会话读历史时有两种失败形状：

- `history.available === false`（日志存在但读不出）：`session.ts:1358-1369` 发
  `#noticeChildHistoryUnavailable`（用户可见「子代理历史读取失败」）并 `#dropBufferedChild`
  —— **响亮且清理**。
- `process.history()` 抛错（`dsh-process.ts:2293-2297` 的 60s 超时、传输层故障、子进程已死）：
  `session.ts:1350-1356` 只 `this.#options.log("subagent history failed for …")`，不 notice、
  不 `#dropBufferedChild`、不 `#replayPending` 之外的清理（`#replayPending` 在 finally 里被整体
  clear）。后果有两个：

1. 用户侧：重开会话时该子代理行缺失，时间线上没有任何提示——与 root history 抛错
   （`replayHistory` 现在会发 notice）和子代理目录抛错（现在会发 notice）是**同一个用户可见
   失败类**，只有这一条还是 stderr-only；
2. 内部：回放窗口内为该子会话缓冲的帧（`#pendingChildEvents`）永远等不到 view，之后每次
   flush 都被 `stillHeld` 保留，直到 2000 上限触发 trim 才按最旧丢弃；同一子会话后续的
   live 帧会被记为「unknown subagent session」丢掉。

探针 T5 复现：让 `history` 在 gate 上挂起 → 期间送一帧子会话事件 → 放行后抛错 → 断言
（a）`session.notice` 数量为 0、（b）只有 stderr 有 `subagent history failed`、（c）子会话从未
`session.opened`、后续同子会话事件被记为 unknown。修复方向与同文件其它两处一致：catch 里发
`#noticeChildHistoryUnavailable(sessionId, messageOf(error))` + `#dropBufferedChild`。

## 4. 阴性结论（已核查，避免重复怀疑）

1. **修复轮 7 条全部成立且无正常路径回归**（§1.3）：9 个修复轮回归本轮亲手复跑全绿，
   另有本 lane 两组探针（26+4 项）从事件层独立复核。
2. **modes 单源链路完整**：`toDisplayCatalog` 按桥的 `planMode` 过滤 → catalog `defaults.modes`
   → `DshSession` 原样回发；profile 不组合 plan-mode 时 `open()` 不调 `plan/set`、
   `configure({mode:"plan"})` 响亮拒绝、持久化的 plan 模式在构造期降级为 build。
3. **配置回执驱动**：model/thinkingOption/mode 三条路径都是「await 回执 → 用回执提交」；
   后端拒绝时本地状态不变、已显示的上下文占用不被清空（S-03 的核心症状已翻转）。
4. **回合统计与终态**：`running` 时重置 per-turn 计数；steer 不重置；取消的回合不再改写上一回合
   已显示的统计行；`started` 已发出后 prompt 失败仍会由 idle 收尾（一次终态、同一 id）；
   `started` 未发出时失败仍清 id（不留下幽灵回合 id）。
5. **子会话终态**：已结束（completed/canceled/replay 终态）的子会话不再被进程退出改写为
   `failed`；仍在跑的子会话仍会收到 `runtime_failed`（正向对照在探针 T6 与
   `child-crash-check` 里都有）。
6. **label 闸门**：无关 flush 不再提前打开无标题子会话；descriptor 到达后补标题再打开；
   `CHILD_LABEL_WAIT_EVENTS=40` 的兜底仍可达且打开后缓冲帧按序路由（探针 T4）。
7. **失败响亮面**：root history RPC 抛错、子代理目录抛错/`available:false` 带 error、
   plan 调和失败都有时间线 notice（`open-degrade-check` 8/8）；prompt 翻译失败走
   `request.failed` 而不是 `session.runtime_failed`。
8. **已知限制/有意取舍（复核后仍成立，不计缺陷）**：
   - 子会话的 question/permission 不转发到 Paseo（宿主 `owns()` 只覆盖根会话；
     `FIELD-NOTES` 第 21 条已记录），`DshSession.#onQuestion` 的子分支当前不可达，实现与之一致；
   - 子会话是只读投影（`configState`/`configure`/`interrupt`/`prompt` 抛错）；
   - 非流式 route 不出 stats 行（不编造时长）；
   - `#emitStreamStats` 对 tokensPerSecond 设 3000 上限剔除突发伪值。
9. 未发现新的 P0/P1，也没有发现修复轮把某个正常路径弄坏。

## 5. 未验证项

1. **PS-04 的 DSH 侧兜底**：`session/close` 时桥是否拒绝/结算该会话挂起的 question、DSH 侧
   是否因 agent dispose 而自动结算——需真实 daemon/桥联调，本轮只验证了插件侧 map 未清理。
2. **S-02 修复的宿主端到端**：late failure 后 Paseo 的 `activeTurnIds` 是否确实在 idle 终态被删除、
   `connectionClosed()` 不再误报 `runtime_failed`——本轮只验证插件发出的事件形状，并读了宿主
   `plugin-provider.js:600/622/653` 的源码路径；未起真实 daemon。
3. **真实 profile 组合**：`#planAdvertised` 依赖 provider 缓存的 catalog（TTL + 单槽 `#display`）。
   本轮未启动真实 `dsh --profile` 验证 `+web-app`（plan 被 disable）组合下
   catalog→session.config 的完整链路；上一轮同样未验证。
4. **40 帧兜底的真实触发**：真实桥有 `CHILD_BUFFER_CAP=500` 的 label 闸门，本轮用假进程构造
   了 label-less notice + 40 帧；未在真实桥上确认 label-less `child-opened` 的实际来源与顺序。
5. **label 闸门的一个构造边界**：一个「桥无标题打开、自身 <40 帧、又没有 descriptor」的子会话
   会一直 held（行不可见）。按桥/DSH 的现行为这条路径没有构造出来（descriptor 是 label 的
   来源，正常会先到），本轮未验证其可达性。
6. 未跑真实模型回合、未重启/重载 daemon、未写真实 `~/.dsh`、未安装包、未做压力/内存测量。
7. 探针只驱动编译后的 `DshSession` + 假 `DshProcess`；`provider.ts`/桥的真实组合不在本 lane
   的实测范围内（见 §6 提示）。

## 6. 跨 lane 提示

1. **plugin-provider（catalog 单源的另一半）**：`provider.ts:1437` 的 `#open` 用
   `this.#display ?? await loadCatalog(config.cwd)`——`#display` 是**单槽**，会被最近一次
   `paseo/catalog`（可能是另一个 cwd）覆盖，open 时不再校验 cwd。当前 catalog 是 profile 级
   （modes/models 不随 cwd 变），所以无害；但若将来 catalog 增加按 workspace 的字段，这里会串。
   建议 provider lane 记录或补 cwd 校验。
2. **plugin-provider（S02 的 catalog 侧）**：`advertisedModes` 的过滤依赖桥的 `planMode`
   （`dsh-bridge/lib/server.js:3137/3217`）。若 profile 在 catalog 缓存 TTL 内变化，session 会在
   open 时降级为 build 并发「Plan 模式未能同步」notice——这是设计内的降级，不是缺陷；
   catalog TTL 决定该窗口长度。
3. **bridge（`paseo/plan/set` 的 pending 语义）**：桥返回的 `pending` 是
   `state.pending === true` 的**折叠布尔**（只有「待切换目标是 plan」才为 true），而
   `session.ts:1788-1792` 的注释把它描述成「pending carries the accepted selection」。当前
   `accepted` 计算对 plan/build 两向都正确（探针 T8 覆盖了 queued plan 与 committed build），
   但注释与桥语义不符；若桥将来改为直接透传 `state.pending`（boolean|undefined），
   session 侧需要同步复核。
4. **harness**：`session-state-check.cjs:296` 的 async check 未被 await（PS-09）；同轮其它回归
   （child-crash / open-degrade / thinking）判据正常。建议该文件补 S07 的 40 帧兜底与 steer
   统计用例，并把 `check` 改成 await 异步函数。
5. **plugin-process / 桥（PS-01 的触发面）**：子代理 `paseo/history` 抛错来自传输层（60s 超时、
   子进程死亡、旧桥不实现该方法）。若桥侧能给「子会话日志不可读」统一成
   `available:false + error`，插件侧两个分支就合一了；当前桥只对「日志存在但读不出」这么答。
