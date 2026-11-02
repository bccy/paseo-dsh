# 2026-11-03 全量审查 · lane plugin-provider

> 独立只读审查（fresh 上下文）。不采信其他 lane 的结论；所有【实测】均给出本 lane 亲自执行的命令与退出码。
> 基线 HEAD `0c82df5ea91fffa06e5b807940443868500521c1`（main）。审查前后 `git status --porcelain` 一致
> （仅 `?? V1.txt`、`?? v1.txt`、`?? docs/audits/20261103/`），未改动任何 tracked 文件。

## 1. 范围与方法

### 1.1 范围

| 文件 | 行数 | 处理方式 |
|---|---|---|
| `paseo-plugin/server/provider.ts` | 2111 | 全文逐行通读（含 `git diff e7472be..HEAD` 的 120 行 diff，即 88adebb..HEAD 的撤回提示接入） |
| `paseo-plugin/server/bootstrap.ts` | 237 | 全文逐行通读 |
| `paseo-plugin/server/bridge-assets.ts` | 7533 | 生成物：不逐行审 base64，只核生成流程与新鲜度（§1.2 第 2 行） |
| `paseo-plugin/server/rewind-notice-append.ts` | 416 | 本 lane 的「撤回提示接入」新模块，全文通读（provider.ts 的新代码依赖它） |
| `paseo-plugin/shared/rewind-notice.ts` | 254 | 文案/计数/识别表，全文通读（provider.ts 用它生成文案） |
| `paseo-plugin/index.server.ts` | 106 | 新 diff（句柄捕获 + arm RPC）通读 |
| `paseo-plugin/server/locale.ts` | diff | `UI.rewind` 接入 |
| `paseo-plugin/server/rewind-canary.ts` | 65 | 通读（canary 文案与顺序） |

对照文档：`docs/FULL-AUDIT-20261102.md` §3.1/§3.2/§10.1/§10.2/§10.4、`docs/AGENTS.md` 硬性约束、
`docs/ADOPTION.md`（§「撤回」与「共享子进程」两处）、`docs/FIELD-NOTES.md` 第 70/72/73/76/78/79 条、
`docs/REWIND.md`（含新增「实测修正」「完成提示」两节）。
对照宿主真实代码：`@getpaseo/server@0.14.0` 的 `agent-manager.js`、`plugin-provider.js`、
`rewind/rewind.js`（只读）。

### 1.2 实测（本 lane 亲自执行，全离线/假桥，未碰真实 profile、daemon、模型）

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `cd paseo-plugin && npx tsc --noEmit` | **0** | 无输出（类型全绿） |
| `node harness/bridge-assets-check.mjs` | **0** | `2/2 passed`，`21 bridge files`，最长行 84 字符 |
| `node harness/rewind-notice-delivery-check.mjs` | **0** | `30/30 passed`（真实宿主 registry/AgentManager + 假 Paseo API；含 degraded 子进程 `4/4`） |
| `node harness/session-request-check.cjs`（按脚本头编译到 `.dbg-pp-session`） | **0** | `52/52 passed`（sessions 导入列表、撤回回执/canary 顺序/完成报告文案与计数） |
| `node harness/concurrent-open-check.mjs` | **0** | `15/15 passed` |
| `node harness/bootstrap-check.mjs` | **0** | `16 passed, 0 failed` |
| `node harness/catalog-cache-check.mjs` | **0** | `2 passed, 0 failed` |
| `node harness/plugin-build-check.mjs` | **0** | `86 passed, 0 failed` |

`session-request-check.cjs` 的 `tsc` 编译步骤 exit 2 属该脚本头部写明的预期（`--moduleResolution node`
下的类型告警），产物 JS 正常运行并 52/52 通过。所有脚本自带一次性 `DSH_HOME`，未写真实 profile。

### 1.3 方法

逐行读代码 + 与宿主 0.14.0 真实实现对照 + 跑项目自带离线判据；每条发现标
【实测】/【源码推断】/【文档】。无法在离线环境证明的（真实 daemon 撤回、真实模型回合、
真机 UI、跨进程 plugin API 握手）单列 §5，不冒充结论。

---

## 2. 健康度评分：**4 / 5**

| 维度 | 分 | 理由 |
|---|---|---|
| 正确性 | 4 | 上轮 S01/S02 双身份 claim 与「能力单源」修复经并发/会话检查实测成立；本轮新增的撤回报告交付在真实宿主代码上 30/30。扣分点：canary 的交付层在真实 daemon 上不成立（PP-02），队列补发路径漏掉时间线重建同步（PP-01） |
| 健壮性 | 4 | 失败路径普遍响亮（spawn 失败 kill+抛、claim 归还、teardown 幂等、catalog/replay/preset/permission 失败都进 timeline warning）；bootstrap 已改成「暂存→校验→rename」原子替换（16/16 实测）。扣分：既有 profile 的 `package.json` 仍不校验（PP-05）、MCP 校验晚于 holder 拆除（PP-04） |
| 契约一致性 | 4 | 能力声明与数据源逐条对得上：本轮新声明的 `session.revert.files` 在桥（`revertScope`/`restoresFiles`）、`dsh-process.revert`、宿主（`supportsRewindFiles`→`revertFiles`→`scope:"files"`）三处都真实存在；Plan 能力已单源（catalog→session.config 同一数组）。扣分：`persist` 契约字段仍未消费（PP-06） |
| 可维护性 | 3 | 2111 行单文件 + 大量注释（注释质量高，但体量大）；死参数（PP-07）、返回类型注解漂移（PP-08）、`close()` 与 `#openTransaction` 的 claim 清理不对称等小腐化仍在 |
| 安全 | 4 | env 差异只报 key 名不报值（`#warnEnvDiffers`）；共享子进程 env 的进程级可见性属上轮已定 blocked（S08/PP-02），本轮已在 timeline 上显式告知；未发现新增注入面 |

**为什么不是 5**：本 lane 的两条最重问题都不在「会不会崩」，而在「说了会到达但到不了」——
canary 的交付层（P2，已在文档自认但未进 §10.4 待用户决定）与队列补发的重建竞态（P3）。
**为什么不是 3**：与本 lane 相关的上轮 P1（S01 并发 open）经本轮独立实测成立（15/15），
本轮新增的约 1300 行撤回提示代码有 30/30 + 52/52 的判据兜底，且我未能在 provider 生命周期里
找到新的 P0/P1 级缺陷。（上轮另两条 P1 `BR-01`/`BR-02` 属 `dsh-bridge` lane，本报告未复核。）

---

## 3. 发现列表

### 3.1 本轮发现（新引入 / 基线已有）

| ID | 级别 | file:line | 归属 | 证据 | 摘要 |
|---|---|---|---|---|---|
| PP-01 | P3 | `paseo-plugin/server/rewind-notice-append.ts:140-154`；`paseo-plugin/server/provider.ts:1040-1050` | 新引入（88adebb..HEAD） | 源码推断 | 队列补发（`flushPending`）不等待时间线重建，conversation/both 撤回的报告可能被重建抹掉且无复核 |
| PP-02 | P2 | `paseo-plugin/server/provider.ts:1093-1101`（canary 发出点）；`paseo-plugin/server/rewind-canary.ts` | 基线已有（本轮文档自认，待用户决定） | 文档 + 源码推断 | canary 在真实 daemon 上永远进不了时间线（run lock 的 staged 事件被 clearRun 丢弃）；自证机制当前不生效 |
| PP-03 | P3 | `AGENTS.md:261-269` vs `docs/FIELD-NOTES.md:2727-2752`、`docs/REWIND.md:196-204` | 基线已有 | 文档 | 仓库 AGENTS.md（整份注入每个会话的规则文件）仍把 canary 描述为时间线上可见，与同仓 FIELD-NOTES 78 / REWIND 实测修正直接矛盾 |
| PP-04 | P3 | `paseo-plugin/server/provider.ts:1470-1503`（holder 拆除）→ `:1515`（MCP 校验） | 基线已有（上轮 PP-09） | 源码推断 | 一次注定失败的 open（如宿主下发 SSE MCP server）会先关掉已持有该 DSH 会话的 provider 会话，再因 MCP 校验抛错失败；同步纯函数可提前 |
| PP-05 | P3 | `paseo-plugin/server/bootstrap.ts:98-102`、`:218-220`；`paseo-plugin/lib/doctor.mjs`（无 bundles 校验） | 基线已有（上轮 PP-04） | 源码推断 | 既有 `$DSH_HOME/profiles/<p>` 的 `package.json` 从不校验 `dsh.profile.bundles` 是否含桥；插件照报 "profile ready"，所有会话初始化失败，doctor 也查不出 |
| PP-06 | P3 | `paseo-plugin/server/provider.ts:561-573`、`:1426-1430`（open 入参） | 基线已有（上轮 PP-06） | 源码推断 | `ProviderSessionConfig.persist` 从未读取；宿主的 4 个 `persistSession:false` 入口（worktree 分支名、git 元数据、模型发现、internal agent）仍会在 DSH 侧持久化会话并返回 persistence handle |
| PP-07 | P3 | `paseo-plugin/server/provider.ts:1602`；`paseo-plugin/server/session.ts:199`、`:736-762` | 基线已有（上轮 PP-08） | 源码推断 | 死参数：provider 把 `display.thinkingOptions`（全模型交集）传进 `DshSession`，session.ts 全文不读它；实际档位按当前模型取 |
| PP-08 | P3 | `paseo-plugin/server/provider.ts:286-301` | 基线已有 | 源码推断 | `listDshSessions()` 返回类型注解漂移：写 `createdAt?: number`，实际字段是 `preview`/`updatedAt`；调用方另声明一份正确类型，靠结构兼容过编译 |
| PP-09 | P3 | `paseo-plugin/server/provider.ts:1232-1248`、`:327-401` | 基线已有 | 源码推断 | 空模型目录被当成功返回：探针拿到 `{providers:[],models:[]}`（无 key / 桥无 `llm` 服务）时仍回 `request.completed` + `models:[]`，用户只见空选择器、无任何解释（与 FIELD-NOTES 58 同形） |
| PP-10 | P3 | `paseo-plugin/server/session.ts:818-829` | 新引入（本轮 `session.revert.files` 能力放开） | 源码推断 | `DshSession.revert()` 无条件清 pending 权限卡并声称「对话被撤回」；files-only 撤回不动对话，该文案不实（正常路径宿主会先 cancel run，故触发窗口窄） |

**计数：P0 = 0，P1 = 0，P2 = 1，P3 = 9。**

### 3.2 逐条展开

#### PP-01（P3）队列补发不等时间线重建，报告可能被重建抹掉

- **触发条件**：插件进程尚未捕获 `paseo` 句柄（daemon 重启后、首个 hook/RPC 之前）→ 用户发起
  conversation/both 撤回 → 报告进 `pending`（`rewind-notice-append.ts:374`）→ 首次捕获时
  `flushPending()`（`:140-154`）直接 `appendReport()`，**既不订阅也不等待** `agent.timeline.replacement`。
- **为什么会被抹掉**：宿主 conversation/both 撤回在回执后立刻
  `hydrateTimelineFromProvider({force:true})` → `forceHydrateTimelineFromLegacyProviderHistory`
  先 `timelineStore.delete(agent.id)` 再按 provider history 重录（宿主
  `agent-manager.js:3055-3070`，本 lane 只读核对）。落在 delete 之前的 append 会被清掉。
  `flushPending` 也没有 `verifyAfterTimeout()` 那道复核（只有 `#deliver` 的超时分支有）。
- **窗口**：从 provider 回执被 daemon 处理，到重建执行 `timelineStore.delete` 之间（含
  `streamHistory()` 的一次跨进程往返 + durable store delete）。窄，但真实存在；且这一条正是
  「确定性送达」这一设计目标的缺口——append 本身成功，所以没有任何错误日志。
- **证据等级**：源码推断（宿主源码 + 本仓源码）。**未用探针复现**：现成的
  `harness/rewind-notice-delivery-check.mjs` 队列场景（scenario 0）用的是 **files** scope、
  且在 `await manager.rewind()` **完成之后**才触发 hook（`harness/...:456-486`），结构上覆盖不到
  这个窗口；我没有改 harness（只读边界）。
- **修法建议（不代改）**：`pending` 条目带上 scope，conversation/both 的补发复用
  `RewindReportDelivery`（订阅 replacement 后再 append + 超时复核）；或补发后统一走一次
  `verifyAfterTimeout` 复核。

#### PP-02（P2）canary 的交付层在真实 daemon 上不成立（待用户决定）

- **机制**：`session.revert` 分支在 `request.completed` 之前用 `#notice()` 发「撤回已生效」
  （`provider.ts:1093-1101`）。但宿主 `AgentManager.rewind` 全程持有 foreground run lock
  （`createPendingRun` … `finally settleForegroundRun`，宿主 `agent-manager.js:2387-2435`），
  `enqueueSessionEvent` 把期间到达的 provider 事件压进 `pendingRun.stagedEvents`，rewind 走
  `clearRun` 直接丢弃 → 时间线永远看不到这条通知。
- **影响**：docs/AGENTS.md 与 ADOPTION 把这条通知当作「时间线刷没刷新」的自证机制；实际上
  **打过补丁的宿主上「随被撤行一起消失」和原版宿主上「留下来提示 Reload agent」两种表现都观察不到**。
  未打补丁的宿主上，被撤消息仍留在屏幕上且没有任何提示（新的 completion 行只说撤了什么，
  不说界面是旧的）。
- **现状**：本轮只把**完成报告**改成 `timeline.append`（绕过 run lock），canary 未改；
  `docs/REWIND.md:196-204` 的「实测修正」与 `docs/FIELD-NOTES.md` 第 78 条已自认，理由是
  「改它要先问用户」。**但它没有登记进 `docs/FULL-AUDIT-20261102.md` §10.4 待用户决定**，
  只在 FIELD-NOTES/REWIND 里，容易被下一轮漏掉。
- **证据等级**：文档 + 源码推断（宿主 staging 语义；本 lane 未跑真实 daemon 撤回）。

#### PP-03（P3）AGENTS.md 的 canary 硬约束与同仓实测结论矛盾

- `AGENTS.md:261-269`（整份注入每个 DSH 会话的规则文件）仍写「打过截断补丁的宿主会在回执里把
  history 截到撤回点，那条通知随被撤行一起消失；原版宿主会留下它」，并把
  `harness/host-contract-sim.mjs` 称为「这条规则的唯一直接证据」。
- 而 `docs/FIELD-NOTES.md:2727-2752` 与 `docs/REWIND.md:196-204` 的实测结论是：该通知在
  **daemon 时间线**上根本不存在，`host-contract-sim.mjs` 断言的是宿主 `PluginAgentSession.history`
  （provider 缓冲区），**不是** daemon 时间线。
- 后果：后续 agent 会把「顺序对了」当成可观测机制，继续在错误的前提上做修改。
  建议 docs lane 在 AGENTS.md 该段加一句指向 FIELD-NOTES 78 / REWIND「实测修正」的限定。

#### PP-04（P3）MCP 校验晚于 holder 拆除（上轮 PP-09，未修）

- `#open` 先 `await holder.close({park:true})`（`provider.ts:1470-1503`，会拆掉当前持有同一 DSH
  会话的可用 provider 会话），之后才 `validateMcpServers(config.mcpServers)`（`:1515`）。
  `validateMcpServers` 是同步纯函数（`dsh-process.ts:790-795` → `mcpEntries`，SSE/未知传输抛错），
  完全可以提前到 holder 拆除之前。触发面：宿主把用户配置的 SSE MCP server 下发给 open。
- 证据：源码时序。上轮已记录，本轮仍在。

#### PP-05（P3）既有 profile 的 `package.json` 不校验（上轮 PP-04，未修）

- `writeIfAbsent`（`bootstrap.ts:98-102`）只建缺失文件；`ensurePaseoProfile`（`:218-220`）对已存在的
  `package.json` 不做任何校验。若用户手工建过同名 `paseo` profile 且 `dsh.profile.bundles` 不含
  `dsh-paseo-bridge`，插件仍打印 `profile "paseo" ready`、桥目录也写进去了，但 DSH 不会把它当
  bundle 加载 → 所有会话初始化失败。`paseo-plugin/lib/doctor.mjs` 里没有 bundles 校验
  （grep `bundles` 无命中），所以 doctor 也报健康。
- 证据：源码推断（未构造同名 profile 场景）。

#### PP-06（P3）`persist` 契约字段未消费（上轮 PP-06，未修）

- SDK `ProviderSessionConfig.persist: boolean`（`@getpaseo/plugin/dist/server/provider.d.ts:95`）；
  宿主 `plugin-provider.js:760` 用 `persist: options?.persistSession !== false` 传入，而宿主有 4 处
  `persistSession: false`（`worktree-branch-name-generator.js:69`、`git-metadata-generator.js:122`、
  `model-discovery.js:38`、`create-agent/create.js:107`）。`provider.ts` 全文没有读取 `config.persist`，
  这些本应临时存在的会话仍被持久化并返回 persistence handle，进入 DSH 会话库与「导入会话」列表。
- 证据：源码推断（未真机验证这些内部 agent 的会话确实出现在导入列表）。

#### PP-07（P3）死参数 `thinkingOptions`（上轮 PP-08，未修）

- `provider.ts:1602` 把 `display.thinkingOptions`（全模型交集）传给 `DshSession`；
  `session.ts:199` 声明了 `DshSessionOptions.thinkingOptions`，但全文没有任何读取点
  （`#thinking()` 在 `:759-762` 按当前模型从 `#options.models` 取）。构造参数永远不生效，
  会误导维护者以为 provider 级交集控制着会话档位。

#### PP-08（P3）`listDshSessions` 返回类型注解漂移

- `provider.ts:286-289` 声明 `Promise<Array<{sessionId; cwd?; title?; createdAt?: number}>>`，
  实际 `DshProcess.sessions()` 返回 `{sessionId; cwd?; title?; preview?; updatedAt?}`
  （`dsh-process.ts:2249-2251`）。调用方 `#listSessions`（`provider.ts:1253`）自己又声明了一份
  带 `preview`/`updatedAt` 的类型，靠 TS 结构兼容通过——`tsc --noEmit` 绿并不能发现。

#### PP-09（P3）空模型目录静默成功

- `#catalog`（`provider.ts:1232-1248`）把 `toDisplayCatalog()` 的结果原样回 `request.completed`。
  当探针返回 `{providers:[],models:[]}`（profile 没配 key，或桥侧 `llm` 服务缺失时桥直接回空，
  `dsh-bridge/lib/server.js:3137`）时，输出就是 `models: []`、无 `defaultModel`、无任何 warning。
  用户看到的是空模型选择器，与 FIELD-NOTES 58（0.2.8「能装、模型列表却是空」）同形。
- 未验证：Paseo UI 是否会把空目录显示成错误；本 lane 未跑真实 profile/模型。

#### PP-10（P3）files-only 撤回无条件清 pending 权限卡（跨 lane 文件）

- 本轮 provider 新声明 `session.revert.files`（`provider.ts:104`），宿主因此可以发起 files-only
  撤回（宿主 `plugin-provider.js:1051-1053` → `scope:"files"`）。`DshSession.revert()`
  （`session.ts:818-829`）无条件 `#clearPendingPermissions("The conversation was rewound past this
  question, …")`：files 撤回不动对话，若此时仍有 pending 权限卡（宿主撤回前会
  `cancelAgentRunBefore`，通常已清空，故窗口窄），卡片会被撤掉，且文案声称对话被撤回（不实）。
- 归属：文件属 plugin-session lane；由本 lane 新开放的能力触发，故在此登记并列入 §6。

### 3.3 上轮条目复核（`docs/FULL-AUDIT-20261102.md` §3.1/§3.2/§10.1/§10.2）

| 上轮条目 | 上轮结论 | 本轮独立核实 | 结论 |
|---|---|---|---|
| S01（并发 open 毁会话） | 已修 | 双身份 claim 在第一个 await 前同步占位（`provider.ts:1367-1394`）；close 使在飞 open 失效（`:1195-1215`）；发布前后复核（`:1820-1847`）。`concurrent-open-check` **15/15** | **成立，仍修好** |
| S02 / 上轮 PP-01（Plan 双源） | 已修 | `toDisplayCatalog` 按桥 `planMode` 过滤（`:369-371`）；catalog 的 `modes` 传进 `DshSession`（`:1600`）；`configState()` 原样返回 `#modes`（`session.ts:743-745`）；构造时持久化的 plan 也降级为 build（`session.ts:548-558`） | **成立，仍修好** |
| S08 / 上轮 PP-02（共享子进程 env） | blocked | 代码仍按进程级 env 处理；本轮新增的是**显式告知**：`#warnEnvDiffers` 只报 key 名（`:789-803`），open 时进 timeline warning（`:1625-1644`）。`PASEO_AGENT_ID`/`PASEO_AGENT_CWD` 仍被显式跳过，跨会话 CLI 身份串用未解决 | **仍 blocked（与 §10.2/§10.4 一致）** |
| 上轮 PP-03（bootstrap 非原子替换） | 已修 | 暂存目录逐文件写 + 长度/sha256 校验 + `rename` 发布 + 失败回滚（`bootstrap.ts:128-195`）；失败日志改说 "NOT ready"（`index.server.ts:60-74`）。`bootstrap-check` **16/16** | **成立，仍修好** |
| 上轮 PP-05（sessions 丢 cwd 过滤） | 已修 | `listDshSessions` 转发 `cwd`（`provider.ts:293-297`），`#listSessions` 两半都传（`:1255-1263`）。`session-request-check` 52/52 含该帧断言 | **成立，仍修好** |
| 上轮 PP-07（preset 失败无提示） | 已修 | `loadPresets()` 回读真实值并与请求比对，不一致进 `openWarnings`（`provider.ts:1702-1715`） | **成立，仍修好** |
| HC-02（用户可见路径失败只进 stderr） | 已修 | history replay 失败进 timeline warning（`:1767-1782`）；preset/permission 被拒都有 warning（`:1707-1714`、`:1756-1761`）；catalog 失败回 `request.failed`（`:1237-1247`） | **成立，仍修好** |
| HC-03（catalog 缓存单槽） | 已修 | 按 cwd 的 LRU(4) + TTL（`:183-224`）；`catalog-cache-check` **2/2**（A→B→A 恰好 2 个 probe） | **成立，仍修好** |
| HC-01（分帧上限漂移） | 已修 | 不属本 lane 文件（`dsh-process.ts`/`frame-reader.ts`），未复核 | 不评（跨 lane） |
| 上轮 PP-04/06/08/09 | 未修 P3 | 见 PP-05/06/07/04 | **仍在（已登记）** |

---

## 4. 阴性结论（查过、未发现问题）

1. **`session.revert.files` 能力声明与数据源一致**【实测+源码】：桥 `revertScope()` 接受
   `files`、`restoresFiles()` 为真、`successText()` 对 files 不说"withdrawn"（`dsh-bridge/lib/revert.js:128-158`）；
   `dsh-process.revert()` 透传 scope（`:2141-2153`）；宿主
   `supportsRewindFiles: supports("session.revert.files")`（`plugin-provider.js:1405`）→
   `revertFiles()` → `revert(messageId,"files")`（`:1051-1053`）→ `AgentManager.rewind` 对
   `mode==="files"` 跳过重建（`agent-manager.js:2405`）。三处闭环，不是过度声明。
2. **撤回分支的 canary 顺序仍正确**：`#notice` 在 `request.completed` 之前（`provider.ts:1093-1102`），
   files scope 不发；`session-request-check` 的「恰好一条 canary 且在回执前」52/52 通过。
3. **完成报告恰一条、不重复**：部分失败只发 warning 行并 `return`（`provider.ts:1163-1170`），
   成功行不会再发；`session-request-check` 的「emits no success notice beside the failure」全部通过。
4. **报告机制不会把撤回本身搞坏**：`beginRewindReport` 走客户端 SDK 的 `observe()`
   （`@getpaseo/client/dist/connection/owned.js:11` 只建 promise，不同步抛），`deliver()` 是
   fire-and-forget + `catch` → `fail()`；`session.revert` 抛错时 `delivery?.cancel()` 释放订阅
   （`provider.ts:1059-1067`）。唯一同步风险 `api.agents.ref()` 是纯工厂（`index.js:311`），无校验抛错。
5. **报告行不会被下一次重建"复活"**：append 的行不进 provider history；宿主重建只重录
   `streamHistory()` 里的 timeline 事件（`agent-manager.js:3063-3108`），plugin 行不在其中。
   行 id 固定（`REWIND_NOTICE_ITEM_ID`），Paseo 按 `pluginId/id` 折叠，后一次替换前一次。
6. **`rewindSuccessText` 不编数字**【源码】：计数只取回执 `files.restored`/`files.deleted` 数组长度；
   读不出数组时退到无数字句子（`shared/rewind-notice.ts:170-204`）。
7. **共享子进程引用计数**：claim 按子进程实例计数、按实例归还、旧子进程 claim 不会被 `#pooled !== p`
   吞掉；teardown 与 grace timer 的 shutdown 串行化，`#pooled` 在同步段清除，acquire 走
   `#awaitPoolShutdown()` 等待（`provider.ts:648-737`、`:824-947`）；`concurrent-open-check` 15/15
   亦覆盖 pool 计数配对。**未发现**「第二个 open 杀第一个会话」或 claim 泄漏的新路径。
8. **`#open` 失败清理**：session 构造后任何 await 抛错都会删 map 条目（按身份守卫）并
   `close({park:false})`，然后原样抛出（`provider.ts:1790-1818`）；`openWarnings` 在
   `session.ready` 之后才发，且每条都检查 `#sessions` 身份（`:1847-1850`），不会给已关闭会话发通知。
9. **bootstrap 原子性**：`renameSync` 发布前后不存在"半份桥"；插件加载期 `ensurePaseoProfile()` 同步
   执行于 `registerProvider` 之前，故不存在「并发 spawn 读到不存在的 bridge 目录」窗口（`index.server.ts:60-83`）。
10. **内嵌桥新鲜度**【实测】：`bridge-assets-check` exit 0，按源码重算 base64 逐字节比对通过（21 个文件）；
    生成器只收 `*.js`/`package.json`/`cordis.patch.yml`，与 `dsh-bridge/` 实际文件全集一致（无遗漏运行期文件）；
    `prepack` 已接线（`paseo-plugin/package.json:41`）。
11. **`timeline.plugin` 能力位**：宿主 0.14.0 全文无 `timeline.plugin` 引用（只在 SDK 的
    `PROVIDER_CAPABILITIES` 常量里），`appendTimelineItem`（`agent-manager.js:1784-1799`）无能力门禁，
    故未声明它不影响 `timeline.append`（属"当前版本无影响"，见 §5）。
12. **`UI.rewind` 接入**：`UiCopy.rewind` 为必填，两个 locale 都从 `REWIND_COPY` 取
    （`locale.ts` diff），`tsc --noEmit` 0 退出；服务端文案与客户端识别表同源，不会漂移。

---

## 5. 未验证项

| 项 | 为什么没验 | 影响 |
|---|---|---|
| 真实 daemon 撤回全链路 | 需真实 `~/.dsh` profile + 运行中 daemon；任务边界禁止 | `delivery.ready` 等的是**跨进程**的 `agent.timeline.set_subscription` 确认；harness 的假 API 把它做成 `Promise.resolve()`。若真实 daemon 在 provider RPC 在飞时不回订阅确认，每次撤回会多等最多 1000 ms（有上限，不阻塞正确性） |
| PP-01 的竞态窗口 | 未改 harness、未写探针（复制 harness 到 /tmp 会破坏其 `plugin-build.cjs` 的相对路径） | 该条只有源码推断，未实测；窗口窄 |
| PP-02 canary 在真实 daemon 的可见性 | 同上（真实 daemon） | 结论来自本仓文档的自认 + 宿主源码，未由本 lane 亲测 |
| 真机 UI：空模型目录（PP-09）、报告行渲染/胶囊、files 撤回的权限卡（PP-10） | 需 Paseo App 真机 | UI 层影响未验证 |
| `harness/rewind-notice-check.cjs`（客户端半） | 属 client lane 范围，未跑 | 本 lane 只覆盖服务端/共享文案 |
| HC-01（分帧上限） | 属 `dsh-process`/`frame-reader` lane | 未复核 |
| 真实模型回合（catalog 非空、thinking 档位） | 耗 token 且需真实 profile | PP-07/PP-09 的实际用户可见性未验证 |
| `persist` 的实际影响（PP-06） | 需真实 daemon + 触发 worktree/git 元数据生成 | 只做了源码闭环 |

---

## 6. 跨 lane 提示

1. **plugin-session lane**：`session.ts:818-829` 的 `revert()` 对所有 scope 无条件清 pending 权限卡
   并声称"对话被撤回"——本轮 files-only 能力放开后该文案对 files 不实（本报告 PP-10）。建议改为
   `scope !== "files"` 时才清/才用该文案。
2. **plugin-session lane**：`session.ts:199` 的 `DshSessionOptions.thinkingOptions` 是死参数
   （本报告 PP-07）；删掉它需要同时改 `provider.ts:1602`，两处同属一个改动。
3. **docs-consistency lane**：`AGENTS.md:261-269` 的 canary 硬约束与 `FIELD-NOTES` 78 /
   `REWIND.md:196-204` 的实测修正矛盾（本报告 PP-03）；另建议把 PP-02 补进
   `FULL-AUDIT-20261102.md` §10.4 待用户决定清单（当前只在 FIELD-NOTES/REWIND）。
4. **verify-runner / harness lane**：`harness/rewind-notice-delivery-check.mjs` 的队列场景
   （scenario 0）用 **files** scope 且 `await manager.rewind()` 之后才触发 hook，结构上无法覆盖
   「conversation 撤回在飞时捕获句柄」这一路径（本报告 PP-01）；补一条 conversation/both + 在飞
   捕获的断言即可把该条从「源码推断」升到「实测」。
5. **plugin-process lane**（`dsh-process.ts`）：`session.revert` 的 120 s 超时（`dsh-process.ts:2148-2153`）
   与 `rewind-notice-append.ts` 的 10 s replacement 超时是两套独立上限，若将来要统一撤回超时预算，
   注意报告侧的上限更短（撤回还没回来时 replacement 计时已在跑）。
6. **client lane**：`REWIND_NOTICE_VERSION = 2` 与固定行 id `rewind-notice` 的折叠语义
   （后一次替换前一次）需与客户端渲染/胶囊的 `noticeId` 消费对齐；服务端已按 `pluginId/id` 折叠
   的假设写入注释（`shared/rewind-notice.ts:40-48`）。

---

## 附：本报告引用的宿主代码位置（只读核对）

- `@getpaseo/server@0.14.0` `dist/server/server/agent/agent-manager.js`
  - `rewind()`：`:2387-2435`（run lock → provider 调用 → conversation/both 重建 → `timeline_replacement` → settle）
  - `forceHydrateTimelineFromLegacyProviderHistory()`：`:3063-3108`（`timelineStore.delete` 后重录）
  - `appendTimelineItem()`：`:1784-1799`（直接 record+dispatch，无能力门禁）
- `dist/server/server/agent/plugin-provider.js`
  - `persist`：`:760`；rewind 映射：`:1048-1057`；能力位映射：`:1404-1406`
- `dist/server/server/agent/rewind/rewind.js`：`invokeRewindCapability()` 三种 mode
- `@getpaseo/client` `dist/connection/owned.js:11`、`dist/timeline-subscription/index.js`、
  `dist/index.js:311-345`（订阅 ready 与事件形状 `{agentId, event:{type:"replacement"}}`）
