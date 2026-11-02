# 客户端 jobs 功能审查（client-jobs）

- 审查对象：`main` HEAD `2f71225`（工作区干净，唯一未跟踪项是本轮审查目录 `docs/audits/20261102/`）
- 范围（逐行全量）：`paseo-plugin/client/jobs-pill.tsx`(793)、`jobs-popover-layout.ts`(429)、`jobs-spinner.tsx`(210)、`poll-sequence.ts`(69)、`paseo-plugin/shared/jobs.ts`(158)；为核对契约另读了服务侧 `index.server.ts` / `provider.ts` / `session.ts` / `dsh-process.ts` / `dsh-bridge/lib/server.js|index.js`、宿主 Paseo 0.14.0 源码与 DSH 0.2.1-rc.5 的 jobs 包。
- 方法：先读新功能四个提交（`87b5e6e`/`d523941`/`9c27917`/`72a1a35`）的 diff 与 [FULL-AUDIT-20261031 §4](../FULL-AUDIT-20261031.md) 的 jobs 关注点，再逐条追调用链到宿主与 DSH；`./node_modules/.bin/tsc --noEmit -p tsconfig.json` exit 0（只读）。**未运行 jobs 两个 harness**——它们会向 `paseo-plugin/.dbg-*` 写编译产物，超出本任务「只写报告」的边界；因此 harness 只做判据静态阅读（见 §5）。
- 证据分级：**实测** = 本机命令跑出；**静态** = 读源码/宿主/DSH 安装包；**未验证** = 明确未执行。
- 环境：DSH 0.2.1-rc.5、Paseo 0.14.0（本地 checkout `88f8eb59d` 的 `packages/app|plugin|client` 版本亦为 0.14.0）、Node 22.23.1。

## 1. 结论摘要

**无 P0/P1。** 五个文件的实现质量高于同期大多数改动：分层防护（in-flight 跳过、全局单调序号、entry 身份校验、AbortController）齐备，排序/折叠规则逐行抄自 DSH 而不是自创，宿主几何全部收进 `jobs-popover-layout.ts` 供离线断言，权限拒绝被当成终态处理。

但有 **4 条 P2**：最重要的是「pill 可见性只看 running/stopping 数」使后两组提交（完成分组 + disclosure 表头）在**最常见的单任务场景不可达**——最后一个 job 一结束 pill 就消失，用户看不到「已完成」分组；同时这与它抄来的 DSH 规则 `settledExpanded = settledOpen ?? liveRows.length === 0` 的后半句相矛盾。其次是审查文档已点名的轮询总量放大（未缓解，且没有任何退避）、快照分页边界被忽略、以及「终态错误（bridge 太旧）与瞬时读失败走同一条重试路径」的契约缺口。

## 2. 发现清单

| ID | 严重度 | file:line | 触发条件 | 证据等级 | 新引入 vs 基线已有 |
|---|---|---|---|---|---|
| CJ-01 | **P2** | `jobs-pill.tsx:562-568`（`count=liveCount` / `visible=count>0`）、`:447-455`（allSettled 分支）、`:463`（`settledOpen ?? live.length===0`）；旁证 `locale.ts:137` | 全部后台任务结束（含「只跑过一个后台命令」的日常场景）：pill 立即隐藏，完成分组/表头/`allSettled` 在正常路径不可达；DSH 自身列表此时仍显示数量并默认展开完成组 | 静态（客户端 + 宿主 `buttons/model.ts:126-130`、`:173-180`；DSH `dsh-client-ui-jobs/lib/client.js:338,408`） | 新引入：可见性规则来自 `87b5e6e`，与之冲突的完成分组来自 `9c27917`/`72a1a35` |
| CJ-02 | **P2** | `jobs-pill.tsx:64`（`POLL_MS=4000`）、`:718-725`（每 agent 一个 `setInterval`，无隐藏/空闲降频）、`:757-774`（快照注册全部 agent）、`:548-590`（每次 poll 都 `publish`+`registration.update`） | 常驻：每个非 closed 的 DSH agent 每 4s 一次 RPC；多个 app 客户端相乘；0 live 时 pill 已隐藏但仍全速轮询；定时器在同一 tick 批量创建 → 每 4s 齐发；每轮返回全部 settled job（registry 保留到 owner dispose）且 `label` 是**未截断的原始命令** | 静态 + 数量估算（未启 daemon 实测频率）；旁证 `docs/FULL-AUDIT-20261031.md:117` | `87b5e6e` 引入；基线审查已列为待测量项，本 HEAD 未做任何退避/聚合 |
| CJ-03 | **P2** | `jobs-pill.tsx:757-774`（`snapshot: ({entries}) => …` 直接遍历，未消费 `pageInfo`） | 同一 daemon 的非归档 agent 目录超过 200 个（协议默认 `limit=200`）时，第 201+ 个 agent 在收到自己的 `agent_update` 前没有 pill；重连后的新快照同样截断 | 静态（协议 `messages.ts:1277-1305`、服务端 `session.ts:5528-5591`、SDK `client/src/index.ts:125-131`） | `87b5e6e` 引入；基线审查文档已点名「首个 snapshot 还有分页边界」 |
| CJ-04 | **P2** | `jobs-pill.tsx:622-651`（仅 permission denied 走终态；其余一律 `available:false` 且继续 4s 重试）、`:565`（不可读即常驻可见）；旁证 `dsh-process.ts:1842-1857`、`shared/jobs.ts:153-157` | profile 里运行的 bridge 早于 `paseo/jobs`（升级窗口/旧进程）：每个 DSH agent 的 composer 常驻一条错误 pill，且**每 4s 重试一次**；错误语义要求「reload 插件」，重试永远无效。契约里 `error` 只有 `message`，没有机器可读的终态码 | 静态 | `87b5e6e` 引入（同一文件已对 permission denied 做「停止定时器 + 隐藏」的终态处理，两者不一致） |
| CJ-05 | P3 | `jobs-popover-layout.ts:288-333`（`STATUS_MARKS` 与「来自宿主状态语义」的注释） | `stopping` 画运行环、`killed` 与 `completed` 同为灰点：用户请求停止与正常完成在颜色语义上不可区分（行内 status 文案仍可读）。DSH 自身 `dotState` 是 `stopping/killed → warning`、`completed → done` | 静态（DSH `dsh-client-ui-jobs/lib/client.js:111-124`） | `87b5e6e` 引入（注释宣称与宿主一致，实际是偏离） |
| CJ-06 | P3 | `harness/jobs-popover-check.cjs:449-471`；`jobs-pill.tsx:548-752` 无对应行为测试 | 完成分组的「空闲时展开」只被**源码正则**断言（`.test(pillSource)`），从未验证可达性，因此 CJ-01 全绿通过；poll/apply/register/remove 状态机、可见性计算、`inFlight`、permission 终止路径、popover 订阅/清理均无行为测试 | 静态（读 harness） | `87b5e6e`→`72a1a35` 的测试集形态 |
| CJ-07 | P3 | `jobs-pill.tsx:412-432`（effect 捕获 `store.get(agentId)`；未取到即提前 return 且不重试）、`:110-121`（listeners 仅在 previous entry 存在时被继承）、`:639`（permission 分支 `store.delete`） | 若 popover 在 store 尚无该 agent 行时挂载，之后所有 poll 都不会让它更新（永久停在「已结束」或空态）；`store.delete` 后若 popover 未卸载则不再收到任何 publish | 静态（当前主路径下 pill 首轮后才可见，故可达性低；属结构性脆弱） | `87b5e6e` 引入 |
| CJ-08 | P3 | `jobs-pill.tsx:777-787` | 插件启动时 `paseo.agents.list` 首次请求失败（daemon 重连窗口）：只打一条 console，整个 app 生命周期不会再重试、也没有任何 UI 提示，所有 agent 都没有 jobs pill | 静态 | `87b5e6e` 引入 |
| CJ-09 | P3 | `jobs-pill.tsx:709-717`（`timer: undefined as unknown as …` + `spinning:true` 伪初始化）、`:652-656`（旧 entry 的 `inFlight` 永不复位，靠对象被丢弃兜底）；`poll-sequence.ts:25-26,52-54`（`latest()` 无生产调用，仅 harness） | 可维护性：类型断言掩盖真实初始化顺序；未用 API 扩大接口面 | 静态 | `87b5e6e` 引入 |
| CJ-10 | P3 | `dsh-bridge/lib/server.js:2023-2052`（description 按 command 文本存 Map，重复命令后写覆盖、超过 200 条按最近执行淘汰）、`:2758-2801`（按 job.label 查表） | 同一命令文本被多次执行且 description 不同 → 两条 job 共享最后一个描述；长回合中早期 live job 的 description 被后续命令挤出 → 标题回退成命令（客户端无法区分「本来没有」与「被淘汰」） | 静态（范围外文件，但直接决定本功能的标题契约） | `d523941` 引入 |
| CJ-11 | P3 | `dsh-bridge/lib/server.js:186-199`（注释称表「otherwise only emptied at `turn/end`」）、`:2752-2757`（注释称靠 timeline read 关联，实际是内存 Map） | 维护者按注释理解会得到错误生命周期模型：实际只在 `#forgetSessionState`（`:3338`）清、外加 200 条上限淘汰，没有 turn/end 清理 | 静态（范围外文件） | `d523941` 引入 |
| CJ-12 | P3 | `jobs-pill.tsx:437-444`、`:646-651`（把 `DaemonRpcError.message` 原样展示，含 `requestType=`/`code=` 内部字段） | 任一次非权限读失败：popover 里出现内部诊断串；且错误 pill 无关闭/重试入口，只能等下一次成功（或永远等不到，见 CJ-04） | 静态 | `87b5e6e` 引入 |
| CJ-13 | P3 | `jobs-pill.tsx:659-690`（`agent.provider !== undefined` 分支、空 `workspaceId` 直接返回、已有 entry 不重建） | 协议里 `AgentSnapshotPayload.provider` 是必填 string（`messages.ts:853-886`），该防御分支是死代码；agent 的 `workspaceId` 变空或换 workspace 时不会移除/重建旧 pill，会留在旧 workspace | 静态 | `87b5e6e` 引入 |

**未发现**：定时器/监听器泄漏（`remove`/`removeAll`/cleanup 三处对称，`unref` 处理 Node）、并发轮询叠加（in-flight 每 entry 一请求）、序号倒退（sequence 规则正确且被 harness 变异对照过）、spinner 动画重启动（icon 只在布尔翻转时 patch，与 `PluginButtonStore.update` 的 merge 语义吻合）、卸载后动画残留（web `cancel()`、native `loop.stop()`）、权限拒绝误判（`code`/文案两条路都与宿主实际产出对得上）。

## 3. 关键发现详述

### CJ-01（P2）可见性规则让「已完成分组」在单任务场景不可达

`apply()` 的可见性只数 live 状态：

```ts
const count = next.available ? liveCount(next.jobs) : 0;   // running + stopping
const visible = next.available ? count > 0 : true;          // jobs-pill.tsx:562-565
```

而 `makeJobsPopover` 的三个分支里，后两个都假设「pill 可见时可能没有 live job」：

- `:447-455`：`entry === undefined || entry.jobs.length === 0` → 渲染「后台任务都已结束。」。可见的前提是 `visible=true`，即 `count>0`（有 live job）或 `available=false`；**两个条件都与「jobs 为空」互斥**（唯一例外是错误恢复与成功读到空列表在同一 tick 内交错，属于一帧不到的瞬态）。
- `:463`：`expanded = settledOpen ?? live.length === 0`。这一行是 `9c27917` 从 DSH 抄来的 `settledExpanded = settledOpen ?? liveRows.length === 0`（DSH `client.js:338`），但 DSH 的列表在空闲时**仍然可见**（trigger 显示 `count.idle.*`，`client.js:408`），所以它的「空闲时展开」有实际作用；本插件的 pill 在 `live.length===0` 时已经 `visible:false`，宿主连按钮都不渲染（`packages/app/src/plugins/buttons/model.ts:173-180` 的 `buttonMatches` 要求 `button.visible`），更糟的是 **`update()` 一旦看到 `visible:false` 会强制关闭已打开的 popover**（同文件 `:126-130`）。

后果：用户跑一个后台命令 → pill「1 个后台」→ 命令结束 → pill 消失，完成分组、表头、计数、「已结束」文案都看不到；`9c27917` 的真机验收记录也只在「1 running + 2 finished」时看过折叠效果（提交信息原文）。只有「还有别的 job 在跑」的窗口里，已完成分组才有意义。

这是**产品语义决定**（`locale.ts:137` 注释写明「pill hides once nothing is working」）与后续两次提交（完成分组/历史）目标冲突的结果，不是纯 bug。两条处置路线都可接受，但必须选一条并让实现/注释/harness 自洽：

1. 让历史可见（更贴近 DSH）：`visible = next.available ? next.jobs.length > 0 : true`（或 live>0 时 label 显示 live 数、否则显示总数），让 `live.length===0` 的「默认展开」真正生效；
2. 明确「只做 live 指示器」：删掉 `entry.jobs.length===0` 分支与 `settledOpen ?? live.length===0` 的空闲分支、删掉对应 harness 正则，并改掉 `shared/jobs.ts`/`jobs-pill.tsx` 里「像 DSH 一样」的表述（现在它只抄到了前半条规则）。

### CJ-02（P2）轮询总量放大：无退避、无聚合、齐发、返回体随历史增长

已知关注点（[FULL-AUDIT-20261031:117](../FULL-AUDIT-20261031.md)）在 HEAD 上未缓解：

- **基数**：`register()` 对整个 `agents.list` 快照里每个 provider 匹配、`workspaceId` 非空、非 `closed` 的 agent 各起一个 `setInterval(…, 4000)`（`:718-725`）；0 live（pill 已隐藏）与 `available:false` 都继续全速。
- **乘数**：每个 Paseo app 客户端实例各跑一份插件客户端 bundle（桌面/移动/Web 各一份；快速验证方式：同一事件循环里每个实例各自 `contributeJobsPill`），所以总量 ≈ `agent 数 × 客户端数 × 0.25 /s`。10 agent × 2 客户端 = 5 RPC/s，全部串两跳 IPC（client→daemon→plugin process→DSH child stdio）。
- **齐发**：快照里的注册在一个同步循环里完成，所有 `setInterval` 在同一 tick 建立 → 每 4s 一批同时到；桥侧 `paseo/jobs` 的 `jobs.list(caller)` 是 `[...store.values()].filter(...).map(view)`（DSH `dsh-jobs-local/lib/index.js:503-506`），O(进程内全部 job) 且每个 job 新建 view 对象。
- **返回体**：registry 会保留 settled job 直到 owner dispose，所以一次轮询返回「live + 全部历史」，`label` 是**原始命令**（`JobView.label`，桥不做截断）——含 heredoc 的 bash 命令可到几十 KB；客户端只做 `numberOfLines={1}` 的视觉截断，拦不住线上字节。一个跑了几十条命令的会话，只要还有一个 job 在跑，每 4s 就搬一次全部历史。
- **每次轮询都必然 `publish` + `registration.update`**（`:548-590`），宿主 `PluginButtonStore.update` 无条件 `replace`→`publish`（`buttons/model.ts:121-130`），即每个 agent 每 4s 触发一次所有按钮视图的 store 通知；内容实际上几乎总是没变，没有变更比较。

建议（按性价比）：① `count===0` 时退避到 15–30s，出现 live 时恢复 4s；② 注册定时器加随机 jitter；③ `apply` 前比较 `visible/label/icon`，无变化不调 `update()`；④ 与桥/契约一起把 settled 历史从常规轮询里剔掉（`jobs.list` 加 `liveOnly`，或返回 `revision`+增量），这是唯一能压住「长会话历史 × 客户端数」的办法。

### CJ-03（P2）首个快照的分页边界

`client.paseo.agents.list({subscribe:{}})` 不带 `page`，服务端默认 `limit = request.page?.limit ?? 200`，响应带 `pageInfo:{nextCursor,hasMore}`（`packages/server/src/server/session.ts:5528-5591`）；`OwnedSubscription` 的快照就是这**一页**，重连后 `restore()` 再发一次（`packages/client/src/connection/owned.ts`）。插件只遍历 `entries`（`jobs-pill.tsx:761-764`），没有消费 `nextCursor`。超过 200 个非归档 agent 时，后面的 agent 只有恰好收到 `agent_update` 才会出现 pill；重连也不会补全。

正确做法要么分页拉全（先多页 `list()` 再订阅），要么用 `scope:"active"`/filter 收窄到真正需要 pill 的集合，至少要在快照处记录并处理 `pageInfo.hasMore`。

### CJ-04（P2）终态错误被当瞬时错误无限重试

`poll` 的 catch 只把 `isPermissionDeniedError` 当终态（`clearInterval`+隐藏+`store.delete`，`:633-645`），其余全部落到 `apply({available:false, error})` 并继续 4s 轮询（`:646-651`）。其中 `BRIDGE_TOO_OLD_MESSAGE`（`dsh-process.ts:400-408`，语义是「reload 插件以重写内嵌桥」，`jobs()` 里对 unknown method 只 log 一次）是**不可通过重试修复**的终态，却会让每个 DSH agent 的 composer 常驻一条错误 pill、每 4s 打一次注定失败的 RPC。

根因是契约表达力不足：`jobsList` 的 `error` 只有 `message`（`shared/jobs.ts:153-157`），客户端无法区分「终态、需要用户动作」与「瞬态、等下一轮」。建议在 output 里加机器可读的 `error.code`（如 `bridge_too_old` / `registry_missing` / `rpc_failed`），客户端对终态码复用 permission-denied 的停止逻辑，并把提示改成一次性的可见说明而不是常驻错误 pill。

### CJ-06（P3）测试只覆盖纯函数与源码形状，状态机裸奔

`jobs-poll-check.cjs` 覆盖 `poll-sequence`（含旧算法必须失败的对照）与 `orderJobs`/`splitJobs`；`jobs-popover-check.cjs` 覆盖几何常量、状态标记、宿主 parity（`HOST_APP` 下读宿主真实常量）与 JSX 接线，但后者用正则对 `pillSource` 做断言，例如 `:455`：

```js
assert("the finished section starts folded while anything runs",
  /const\s+expanded\s*=\s*settledOpen\s*\?\?\s*live\.length\s*===\s*0/.test(pillSource));
```

它证明「这行代码在源码里」，不证明「这行代码可达」。CJ-01 正是这样全绿通过的。`poll()`/`apply()`/`register()`/`remove()`（`jobs-pill.tsx:548-752`，约 200 行、五个竞态防护）没有任何行为级测试；`makeJobsPopover` 的订阅/清理也没有。要抓住本报告前 4 条里的任何一条，都需要把状态机从 JSX/host 运行时里拆出来（与 `poll-sequence` 同样的做法），或加一层可注入的 fake `PluginClientContext` 驱动。

## 4. 与宿主 DSH jobs 列表的一致性核对

| 语义 | 本插件 | DSH `dsh-client-ui-jobs` | 判断 |
|---|---|---|---|
| 排序 | `shared/jobs.ts:68-79` | `client.js:172-181` `ordered()` | **逐字一致** ✅（live 按 startedAt，settled 按 finishedAt 降序，同毫秒回落到 startedAt） |
| 折叠规则 | `jobs-pill.tsx:463` | `client.js:338` `settledExpanded = settledOpen ?? liveRows.length===0` | 公式一致，但 `===0` 分支在本插件不可达（CJ-01） |
| 状态标记 | `jobs-popover-layout.ts:317-323` | `client.js:111-124` `dotState` | **偏离**：`stopping`(warning→ring)、`killed`(warning→灰)（CJ-05，注释称「来自宿主语义」过强） |
| 行标题 | `description ?? label` | 列表行用 `label`（命令）；DSH 的时间线工具行才用 description | 有意的改进型偏离，但「像 DSH 列表」的说法只对排序/折叠成立 |
| 行内容 | 标题 + `状态 · 命令 · progress/detail` | dot + kind + label + status/detail + 时长 | 缺 `kind` 与时长（信息量取舍；未在注释声明为偏离） |
| 「不可读」表达 | `available:false` + 可见 error pill | 无等价层（数据源直接可用） | 符合本仓库「失败要响亮」✅ |
| 权限拒绝 | 停止轮询、隐藏 pill、console 一次 | 无等价层 | ✅ |
| 空闲态 | pill 隐藏 | pill 显示 `count.idle.*`、可展开历史 | **语义分歧**（CJ-01 的根） |

## 5. 健康度评分

| 维度 | 分数 | 依据 |
|---|---|---|
| 正确性 | 3/5 | 主链路正确、排序/折叠公式与宿主一致；可见性/可达性矛盾（CJ-01）、快照截断（CJ-03）、终态重试（CJ-04） |
| 健壮性 | 3/5 | 竞态防护（in-flight / sequence / entry identity / abort）设计到位且注释解释了每条 guard；但 `agents.list` 失败无重试（CJ-08）、popover 订阅有结构性脆弱（CJ-07） |
| 可维护性 | 3/5 | 分层干净（布局/序列/文案/渲染各司其职）、注释详尽；但注释有过度声明与陈旧描述（CJ-05/CJ-11）、伪初始化与死分支（CJ-09/CJ-13） |
| 契约一致性 | 3/5 | `available`/`error` 契约在 client/server/bridge 三层一致，排序与折叠抄自宿主；但 `error` 无终态码（CJ-04）、agent 快照分页未消费（CJ-03）、状态标记语义偏离（CJ-05） |
| 性能 | 2/5 | 每 agent 4s 常驻轮询、无退避/聚合/jitter、齐发、O(全部 job) 投影、全量历史+原始 command 载荷、每次轮询无条件 publish（CJ-02） |
| 安全 | 4/5 | 只读 RPC；权限拒绝被识别并停轮询；console 与错误文案不含凭据；唯一瑕疵是把内部诊断串原样给用户看（CJ-12，非安全问题） |
| 测试覆盖 | 2/5 | 纯函数/布局/宿主 parity 覆盖优秀（含变异验证与宿主常量对照）；但 200 行轮询与 popover 状态机零行为测试，关键断言打在源码正则上，CJ-01 因此漏过 |

**总评（一句）**：这是一份「细节纪律很好、但产品语义没对齐」的实现——排序/折叠/几何/失败表达都在向宿主看齐，最后却被自家「只数 running 的可见性」规则削掉了完成分组的意义，同时轮询策略仍是审查文档点名待做的那一项。

**Top 问题（≤5）**：
1. CJ-01 可见性 vs 完成分组（P2，用户可直接感知：任务一结束 pill 就消失，「已完成」看不到）
2. CJ-02 轮询总量放大（P2，已知关注点，未做任何策略）
3. CJ-04 终态错误无限重试 + 每 agent 常驻错误 pill（P2，契约缺终态码）
4. CJ-03 首个快照忽略分页（P2，>200 agent 边界）
5. CJ-06 状态机无行为测试，关键断言是源码正则（P3，CJ-01 的漏网原因）

**建议优先级**：
- **先决策再改**：CJ-01 需要产品选择（历史可见 vs 纯 live 指示器），两条路线都要同步改注释、`locale.ts` 文案与 harness 正则；不建议在未定的情况改代码。
- **P2 可立即排期**：CJ-04（契约加 `error.code` + 客户端终态处理，改动小收益大）→ CJ-02（先测量再上退避/聚合，别直接调小间隔）→ CJ-03（分页或 filter）。
- **P3 顺手清**：CJ-05/CJ-12 文案与颜色、CJ-07/CJ-08/CJ-13 防御与重试、CJ-09 类型、CJ-10/CJ-11 描述缓存契约与注释（桥侧，和 `dsh-bridge` lane 协调）。
- **测试**：CJ-06 建议把 `poll/apply/register/remove` 抽成不依赖 React/host 的控制器（`poll-sequence.ts` 已示范这个模式），对可见性计算、终态码、快照重连各补一条会红的用例。

**是否有阻断性健康问题**：**无**（无 P0/P1；CJ-01 是产品语义待定项，不影响安装/启动/会话，不构成发布阻断）。

## 6. 未验证项

1. **未运行 `harness/jobs-poll-check.cjs` / `jobs-popover-check.cjs`**：两者会向 `paseo-plugin/.dbg-*` 写编译产物，超出本任务「只允许写报告」的边界；已静态阅读其判据。`tsc --noEmit` 已实测 exit 0。
2. **未启动 daemon/真机**：CJ-02 的频率与载荷是算术推导（未实测 RPC 计数），CJ-01 的真机表现未复验（提交 `9c27917` 的真机记录是「1 running + 2 finished」，与本报告结论不冲突）。
3. **移动端/后台节流未验证**：RN 后台时 `setInterval` 行为、App 切后台后的轮询量未测。
4. **快照分页未构造 >200 agent 的实例**：结论来自协议/服务端源码（静态），未实测。
5. **宿主 0.14.0 checkout 与 daemon 运行时的一致性**：本地 checkout `version=0.14.0` 与环境声明一致，但未逐字节比对已安装 dist；分页/按钮可见性结论读的是本地 `packages/` 源码（与 SDK 同源），非 dist。

## 7. 范围外但相关的观察（仅记录，不裁决，交对应 lane）

- `dsh-bridge/lib/server.js:2023-2052`、`:2758-2801`、`:3338`：description 缓存按 command 文本键 + 200 上限淘汰，生命周期只在 session close 清（注释声称 turn/end 清，见 CJ-11）。
- `dsh-bridge/lib/server.js:2752-2757`：注释说靠 timeline read 关联 description，实际是 `toolDescriptionFor` 内存查表。
- `paseo-plugin/server/dsh-process.ts:1828-1871` 与 `provider.ts:1775-1814`：`readAgentJobs` 的「无连接 = 空列表」把「未打开会话」归为 `available:true`，与 `shared/jobs.ts` 的契约注释一致，判断正确；但 closed session 的 `available:false`（`session.ts:928-939`）与「registry 读不到」同形，客户端无法区分（与 CJ-04 同一类契约问题）。
- 审查方法学：本轮没有跑 jobs harness 是任务约束所致；若下一轮要拿 harness 绿作为证据，应先把编译输出指到 gitignored 目录并在报告里记录 exit code（本报告已明确不把静态判据当实测）。
