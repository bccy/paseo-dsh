# bridge-misc：桥其余模块健康度审查（2026-11-02）

- 审查对象：`2f71225`（main，工作区干净）。上一轮基线：`9298c28`（`docs/FULL-AUDIT-20261031.md`）。
- 环境：DSH 0.2.1-rc.5、Paseo 0.14.0、Node 22.23.1。
- 范围（逐行全读）：`dsh-bridge/lib/index.js`(193)、`session-projections.js`(43)、`subagent-archive.js`(201)、`child-anchors.js`(132)、`delegated-cancel.js`(43)、`archived-lineage.js`(40)、`image-host-path.js`(406)。
- 证据口径：只读审查，未启动真实模型回合、未写真实 `~/.dsh` profile；复现脚本全部在 `/tmp/bridge-misc-repro/`，只写该目录与临时文件。本报告是唯一写入的仓库文件。
- 结论先行：**无 P0/P1 阻断性健康问题；有 2 个基线已有且当前仍未修复的 P2（BR-08、BR-03），其余为 P3 级契约/可维护性/测试覆盖问题。** 模块整体与 DSH 0.2.1-rc.5 的契约吻合度较高，本轮新引入的 `index.js` 文件闸门/描述钩子未发现正确性缺陷。

## 1. 发现清单

| ID | 严重度 | file:line | 触发条件 | 证据等级 | 新引入 vs 基线已有 |
|---|---|---|---|---|---|
| BM-01 | P2 | `dsh-bridge/lib/image-host-path.js:85-88`、`:123`、`:130-131`、`:132`、`:141-142` | 多用户/共享 tmpdir：另一本地用户先创建或预置可预测的 `paseo-dsh-attachments-<uid>` 目录（或目录权限已被放宽），并在 `target`/`target.<pid>.tmp` 放符号链接；本模块不验证目录 owner/mode、不检查 target 是否真实文件，`copyFileSync(source, staging)` 跟随 staging 链接写穿到任意同权限文件，`statSync(target)` 跟随 target 链接按同尺寸复用假图片 | **实测**：私有 TMPDIR 预置 `digest.jpg.<pid>.tmp -> victim` 后，`hostImagePath()` 把 victim 的 `KEEP_ME` 改成 `ATTACHMENT_BYTES`；预置同尺寸 `digest.jpg -> victim.jpg` 后返回 target 且宿主将读到 `FAKE_IMAGE_BYTES`；既有目录 mode 保持 0777（`mkdirSync({recursive,mode:0700})` 不修复已存在目录） | **基线已有 BR-08，当前未修复**（该文件自 `9298c28` 未改） |
| BM-02 | P2 | `dsh-bridge/lib/child-anchors.js:10-17`、`:52-62`；`dsh-bridge/lib/server.js:1872-1884`（调用方） | root 消息 10 派出的 child 仍在后台运行；root 又收到无关消息 20；旧 child 此时派出 grandchild。grandchild 的 `turn/start` 到达时 `observeDelegatedTurn` 取根会话最新人类消息（20）作为锚，撤回消息 20 会取消本属消息 10 的 grandchild，并可能回退其文件 | **基线复现（`docs/audits/20261031/bridge.md:51-61`）+ 当前源码路径未变**（`git diff 9298c28..HEAD -- dsh-bridge/lib/server.js` 对这些函数零改动） | **基线已有 BR-03，当前未修复** |
| BM-03 | P3 | `dsh-bridge/lib/subagent-archive.js:160-173`、`:177-188` | child 当前 `Agent.status === 'idle'` 但 `agent.inbox.nextTurn`/`nextStep` 有排队消息（例如父代理刚 `send_message` 给 continuable child），或 child 运行在另一个 DSH 进程里（本进程 `agents.get` 看不到）；工具把它当“已完成”列入 targets，真实归档走 `stopActivity: true`，排队工作被归档门禁挡住、报告仍称 archived | **源码依据**：DSH `dsh-agent/lib/types/runtime-types.d.ts:41-45`（Inbox 暴露 pending 列表）、`:84-90`（idle/running 语义）、`dsh-subagent/lib/index.js` `runningDescendants` 只看 `status==='running'`；跨进程一项**未验证** | 基线已有（模块未改；基线未单列，属“列表到写入间状态变化”同族的残余竞态） |
| BM-04 | P3 | `dsh-bridge/lib/subagent-archive.js:117-199` | 该工具核心执行路径无行为回归：`harness/` 只有 `mcp-gateway-guard-check.mjs:221-227` 断言工具名被注册、`:367-371` 断言它不能被当作 MCP 目标；没有任何用例驱动 `scope`/`dryRun`/`running`/`failed`/`alreadyArchived` 分支。回归这次修复过的“运行中子代理被归档”问题会静默复发 | **实测**（`grep -rn registerSubagentArchiveTool harness/` 仅命中模块与 mcp-gateway；自写假服务驱动工具确认当前行为正确，但仓内无此测试） | 基线已有（模块未改；基线未单列） |
| BM-05 | P3 | `dsh-bridge/lib/child-anchors.js:111-121` 与 `dsh-bridge/lib/server.js:3163-3166`；`harness/rewind-merge-check.mjs:146-163` | `closeSession` 的注释声称 `delete(root)` 会同时清掉“未命名 root 的 unscoped 锚点”，实现只删除 `entry.rootSessionId === root` 的项；unscoped 锚点会留在表里。另有测试缺口：`ChildAnchors.record` 的第三参数（root scope）与 `withdrawnSince(seq, root)` 的跨 root 过滤在仓内**零覆盖**，现有用例全部用两参和未限定查询 | **实测**：`record('childA',10,'rootA'); record('childB',20,'rootB'); record('unscoped',15)` 后 `delete('rootA')` 返回 1，未限定 `withdrawnSince(1)` 仍返回 `['childB','unscoped']` | 基线已有（模块未改；基线称“没有跨 root 扫描回归”） |
| BM-06 | P3 | `dsh-bridge/lib/delegated-cancel.js:25-32` | JSDoc 把参数声明为 `ChildAnchors`，而 `ChildAnchors.withdrawnSince` 的文档明确要求生产调用必须传 root；按本模块文档直接传 `ChildAnchors` 会扫描进程内全部 root。实测在 rootA 的撤回区间（target=15）传入真实 `ChildAnchors` 会取消 rootB 的 childB。当前生产 `server.js:2274-2288` 用 `{withdrawnSince(seq)}` 闭包绑定 root，是安全的；风险在（未来）按文档调用者 | **实测**（`/tmp/bridge-misc-repro/delegated-cancel.mjs`：`interrupted:["childB"]`）+ 源码对照 | 基线已有（模块未改；server 绑定正确） |
| BM-07 | P3 | `dsh-bridge/lib/delegated-cancel.js:30-42` | `interrupt` 对非 resident/正在 closing 的 activation 是同步 no-op（DSH `dsh-subagent/lib/index.js:1258-1275`：`activation === undefined`/`activation.closing !== undefined` 直接 return），但函数仍把它 push 到 `signalled`，`server.js:2293-2297` 会打印“interrupted N delegated agent(s)”。日志把“没有可中断对象”说成“已中断”，会误导撤回后的现场判断 | **源码依据**（DSH interrupt 实现） | 基线已有（模块未改） |
| BM-08 | P3 | `dsh-bridge/lib/archived-lineage.js:27-39` vs `@deepseek-ai/dsh-api-session-controller/lib/index.js:2528-2541` | 头注释称“ported verbatim”，但两处不等价：DSH 遇第一个非 live 的祖先 Session 时直接返回 `archived.includes(parentSession)`（只查该祖先自己），桥则只要 `headers`（持久层）里有该祖先 header 就继续向上走完持久链。桥在 replay/list 场景是更强（更安全）的血统判定，当前调用点无可观察错误；但“逐字等价”的声明不成立，升级对账/`archived-lineage-check` 的“must stay exact”判据不能当作边界证据 | **源码对照**（两实现逐行比对） | 基线已有（模块未改） |
| BM-09 | P3 | `dsh-bridge/lib/index.js:132-158`；`dsh-bridge/lib/server.js:2896-2950` | 收到 `shutdown` 时，`server.handleRequest('shutdown')` 先 await `performShutdown()`；后者在任一 agent/适配器 dispose 失败时抛出聚合错误。此时 `transport.onRequest` 在 `if (method === 'shutdown')` 之前就 reject，`disposeAndExit` 不会调度，桥进程不退出（插件侧 5s 后走 SIGTERM 兜底，用户看到的是延迟关闭/不干净关闭）。无 teardown 失败时正常 | **源码依据**（未构造失败 teardown 实测） | 基线已有（该段自基线未变） |
| BM-10 | P3 | `dsh-bridge/lib/image-host-path.js:119-154`、`:395-406` | 图片热路径全部同步 FS（`statSync`/`copyFileSync`/`renameSync`），且两处调用点在**共享一个事件循环的所有会话**的 live `session.event` 与 `paseo/history` 重放路径上；大图复制/冷缓存会把全部会话卡住。副本缓存无清理/上限（每张看过的图永久留在 `/tmp/paseo-dsh-attachments-<uid>`，依赖 OS tmp 清理） | **源码依据，未测耗时**（与 FIELD-NOTES 里 13 MiB 帧阻塞 2.2 s 同一进程模型，但本次未做吞吐实测） | 基线已有（文件未改；性能项基线未单列） |
| BM-11 | P3 | `dsh-bridge/lib/subagent-archive.js:124-154` | `scope='all'` 的 `alreadyArchived` 只按 exact id 判断，不套 `underArchivedSession` 血统：已被归档根的子树会被列为 pending 并逐个写入独立归档位；之后用户单独 `unarchive` 根时，这些子会话仍因自己的归档位隐藏（与 DSH 血缘语义“恢复根即恢复整棵树”不一致）。dryRun 报告也会把它们说成“would archive”，而它们本已不可运行 | **源码推理**（未构造真实 registry 验证） | 基线已有（模块未改） |

## 2. 关键问题细节与复现

### BM-01（BR-08）图片缓存：目录归属与两种链接都未防住

`COPY_DIRECTORY` 只在名字里带 uid，不能阻止另一用户先占位；`mkdirSync({recursive:true, mode:0o700})` 对已存在目录不做 owner/mode 校验或纠正。`copyBeside` 的 staging 名是确定性的 `${target}.${process.pid}.tmp`，`copyFileSync(source, staging)` 会跟随 staging 路径上的符号链接（写穿）；复用分支的 `statSync(target)` 同样跟随 target 链接，只比大小。

本次两个最小复现（私有 `TMPDIR`，不碰真实环境）：

```text
# staging 链接
预置 /tmp/.../paseo-dsh-attachments-1000/digest.jpg.<pid>.tmp -> victim
hostImagePath(source,'image/jpeg')
-> victimAfter: "ATTACHMENT_BYTES"   # 被覆盖
-> cacheMode: "777"                 # 既有目录权限未被修复

# target 链接
预置 digest.jpg -> victim.jpg（与 source 同尺寸）
hostImagePath(source,'image/jpeg')
-> returned: .../digest.jpg
-> bytesServed: "FAKE_IMAGE_BYTES"  # 宿主拿到的是 victim 的字节
```

与基线 `docs/audits/20261031/bridge.md:106-115` 的描述一致，说明该问题自 `9298c28` 未处理；本轮新增的两条复现分别覆盖 staging 写穿与 target 同尺寸复用。

### BM-02（BR-03）child 锚定的因果归属仍是“根最新消息”

`child-anchors.js` 的文档本身就是当前缺陷的说明：锚是“根会话最新 human-message seq at the moment the child's own turn starts”。`server.js:1872-1884` 的 `observeDelegatedTurn` 每次 child `turn/start` 都调用 `latestHumanAnchor(root)`。基线 `docs/FULL-AUDIT-20261031.md:85` 与 `docs/audits/20261031/bridge.md:51-61` 已给出“root 消息 10 派 child、root 收 20、child 派 grandchild 被记成 20”的复现；`git diff 9298c28..HEAD -- dsh-bridge/lib/server.js` 显示这些函数零改动，故结论仍成立。修法方向仍是：优先取直接父 activation 的持久派发来源/已知 anchor；只有直接父恰为 root 且能证明本次派发归属时才读根消息；来源无法证明时 fail open。

### BM-03/BM-04 `archive_subagents`：运行中跳过只覆盖 `status==='running'`，且无行为回归

- 工具用 `ctx.get('agents')?.get(id)?.status === 'running'` 跳过运行中 child（`subagent-archive.js:167-173`）。DSH 的 `AgentStatus` 只有 `idle|running`；`idle` 期间仍可能有 `inbox.nextTurn/nextStep` 排队消息（`dsh-agent/lib/types/runtime-types.d.ts:41-45,84-90`）。归档后 DSH 的 `workspace/session-stop` 只 cancel `status==='running'` 的 descendants（`dsh-subagent/lib/index.js:2535` `runningDescendants`），排队消息最终被归档门禁 blocked；工具报告只有 `archived`，没有“排队工作被丢弃”的字段。
- 仓内没有 `registerSubagentArchiveTool` 的行为测试（自写假服务驱动显示当前 `dryRun`/`running`/`failed` 分支行为与文档一致；这是**外部验证**，不能替代仓内回归）。

### BM-05/BM-06/BM-07 锚点与取消的契约缺口

- `ChildAnchors.delete(root)` 只删 root 匹配项，但 `server.js:3163-3166` 注释把它描述为也会清理 unscoped 项；实测删除后 unscoped 仍参与未限定查询。生产 `observeDelegatedTurn` 总传 root，所以当前只造成内存残留而非误取消；但注释与实现的承诺不一致。
- `delegated-cancel.js` 的 JSDoc 参数类型是 `ChildAnchors`，而 `child-anchors.js:74-84` 明确说省略 root 的查询“production paths must pass it”。两类文档互相矛盾；按前者调用在实测中会取消另一个 root 的 child。生产 `server.js:2274-2288` 通过 `{withdrawnSince(seq)}` 闭包绕开，正确但脆弱。
- `interrupt` 是同步 void，遇到不存在的 activation/正在关闭的 activation 直接 no-op；`cancelWithdrawnDelegations` 一律计入 `signalled`，server 打印“interrupted N”，是失败/无事发生的假成功回执（只影响日志与运维判断，不影响功能）。

### BM-09 `shutdown` 失败路径不退出

`index.js` 只在 `server.handleRequest('shutdown')` resolve 之后用 `setImmediate(disposeAndExit(0))`。`performShutdown()` 在 `records.map(rec.handle.dispose())` 或适配器 fiber dispose 有任一失败时 `throw`（`server.js:2938-2939`），于是 `handleRequest` reject，`disposeAndExit` 永远不会执行；插件侧 `dsh-process.ts:2251-2254` 的 5s 超时是唯一兜底。当前无失败 teardown 实测，属于边缘但可修。

### BM-10/BM-11 性能与归档语义残余

- `image-host-path.js` 在 live 事件与重放两条路径上同步做 `statSync/copyFileSync/renameSync`；同一桥进程服务所有会话，单张大图会阻塞全部会话。副本永不清理。**未测实际耗时**，按代码结构判为 P3 风险。
- `archive_subagents scope='all'` 的 `alreadyArchived` 只查 exact id（`:124`、`:153`），不调用 `underArchivedSession`；对已归档根的子树会写独立归档 id，和“unarchive 根恢复整棵树”的心智模型不一致（**未构造真实 registry 验证**）。

## 3. 无发现 / 正向核对

- `session-projections.js`：与 DSH 0.2.1 controller 的 `projections()`/`liveProjections()`（`dsh-api-session-controller/lib/index.js:3281-3332`）逐段对照：live→stat→live 双检、migration-required、`observeSession` 结果 `[Symbol.dispose]`、`SESSION_QUERY_SESSION_NOT_FOUND → live() ?? null` 均一致；`harness/p003-bridge-check.mjs` 10 项通过。未发现新问题。
- `archived-lineage.js`：除 BM-08 的“verbatim”表述外，规则本身正确（自身/`origin:'subagent'` 祖先在集合即真、fork 不继承、环路终止）；`harness/archived-lineage-check.mjs` 12/12 通过。
- `image-host-path.js` 的图片投影正向路径：42/42 离线检查通过（含“官方带扩展名零复制”“mediaType 压过 name”“源消失/未知类型原样回退”“historyEvents 不改写日志”“whitelist 恰好 17 类”）。`REPLAYED_EVENT_TYPES` 与三个消费者逐项核对：`TimelineBuilder.consume`（`paseo-plugin/server/timeline.ts:816-846`）、`ActivityTimeline.consume`（`activity-timeline.ts:34-63`）、`DshSession.replayHistory/replaySubagents`（`session.ts:952-1100`、`:1175+` 的 `turn/start`/`subagent/descriptor`）无遗漏、无多余（多余项 `goal/change`/`tool-workflow/*` 由 ActivityTimeline 消费）。
- `index.js` 入口装配：`transport.onRequest` 每个请求前 `loader.await()`（`index.js:150`）是归档 registry 早期挂载问题的正确修复；question/approval waterfall 的 owner 过滤（`:167-184`）与基线一致；未发现新增阻断。新加的文件闸门/描述钩子（`:79-129`）失败路径均有 `dropFileTool`/`finishFileMutation`/`try` 释放，未发现 ticket 泄漏。
- `subagent-archive.js` 的 registry/失败回执：`registry.archiveSession(id,{stopActivity:true})` 逐 id try/catch，失败进 `failed` 不冒充成功；`scope='session'` 用 `subagents.listDescendants`，`scope='all'` 用 `listStoredHeaders`，与 DSH `dsh-workspace/lib/index.js:526-551`、`dsh-subagent/lib/index.js:2366+` 契约一致（假服务驱动验证 `dryRun` 默认 true、真实归档失败为 `failed`）。

## 4. 已执行的检查（本 lane）

| 检查 | 结果 |
|---|---|
| `node --check` 7 个目标文件 | 全部 OK |
| `node harness/archived-lineage-check.mjs` | 12/12，exit 0 |
| `node harness/image-host-path-check.mjs` | 42/42，exit 0 |
| `node harness/rewind-merge-check.mjs` | 49/49，exit 0 |
| `node harness/p003-bridge-check.mjs`（只读，依赖本机 DSH） | 10 项通过，exit 0 |
| `node harness/bridge-assets-check.mjs` | 2/2，exit 0（确认 `2f71225` 的内嵌桥与源码一致） |
| 自写复现 `/tmp/bridge-misc-repro/image-br08.mjs` | 证实 staging symlink 写穿 + 目录权限未修复（BM-01） |
| 自写复现 `/tmp/bridge-misc-repro/image-target-reuse.mjs` | 证实 target 同尺寸 symlink 复用（BM-01） |
| 自写复现 `/tmp/bridge-misc-repro/anchors.mjs`、`delegated-cancel.mjs`、`archive-tool.mjs` | 分别证实 BM-05/BM-06 与 BM-03/BM-04 的现状 |

未执行：真实 DSH profile 的 archive 往返、真实模型回合、Paseo 移动端/宿主实际文件系统验收（涉及真实 profile/daemon，按本 lane 约束不做）。

## 5. 健康度评分（本 lane，1–5）

| 维度 | 分数 | 理由 |
|---|---:|---|
| 正确性 | 3 | BR-03 误取消、BR-08 图片路径仍开放；其余模块（投影、血统、历史投影）与 DSH rc.5 契约吻合 |
| 健壮性 | 3 | 失败回退与 fail-open 大体有说明；归档工具对 idle-with-inbox/跨进程无防护，shutdown 失败不退出 |
| 可维护性 | 3 | 纯模块小、注释丰富；但存在多处“注释比实现强”（BR-08、delete/unscoped、delegated-cancel 类型、archived-lineage verbatim） |
| 契约一致性 | 3 | `session-projections` 是三处里最贴近 DSH 的；`delegated-cancel` JSDoc 与 `child-anchors` API 互相矛盾，`archived-lineage` 的逐字声明不精确 |
| 性能 | 4 | history 投影的 payload 优化有效；图片复制同步 FS、临时副本无清理，属未量化风险 |
| 安全 | 2 | BM-01（BR-08）是当前 lane 唯一明确的安全边界问题：可预测 tmp 目录 + 跟随链接，可误写/错误复用同权限文件 |
| 测试覆盖 | 3 | image 42 条、archived-lineage 12 条、锚定/取消有基础用例；`archive_subagents` 零行为测试，ChildAnchors root scope 零覆盖 |
| **总体** | **3.0/5** | 中等：无 P0/P1，但两个基线 P2 未关闭，P3 集中在契约/测试/错误回执 |

**一句总评：这些模块的主体设计与 DSH 契约一致、失败普遍响亮，但 BR-08 的本地文件安全边界和 BR-03 的子代理因果归属仍是两处未收口的真实风险；归档工具与锚点 root-scope 的回归覆盖不足，是下一次修复最容易复发的地方。**

## 6. Top 问题（≤5）

1. **BM-01 / BR-08（P2，安全）**：图片临时缓存目录不验证归属，staging/target 符号链接可导致误写或错误图片。
2. **BM-02 / BR-03（P2，正确性）**：child/grandchild 的锚仍取“根最新人类消息”，撤回会取消/回退不属于该消息的委派工作。
3. **BM-03+BM-04（P3，数据/覆盖）**：`archive_subagents` 把 idle 但仍有排队 inbox 的子代理当已完成归档；核心分支没有回归测试。
4. **BM-05（P3，可维护性/覆盖）**：`ChildAnchors.delete` 不清理 unscoped 锚与 server 注释不符，root 作用域过滤零测试。
5. **BM-06（P3，契约）**：`delegated-cancel` 的 JSDoc 指向会跨 root 取消的调用方式，生产靠 server 侧闭包兜底。

## 7. 建议优先级

1. **先修 BR-08（独立、局部）**：私有 cache root（不可预测或带 owner 校验）+ 任何复用前 `lstat`/owner/mode 检查 + staging 随机排他创建（`O_EXCL`/不跟随链接）+ target 必须为真实普通文件；保留确定性最终路径以免 replay 多出图片行。补目录链接/target 链接/staging 链接/同尺寸替换负向用例。
2. **再修 BR-03（跨模块契约）**：按直接父 activation 的持久派发来源取锚；只在直接父为 root 且已证实本次派发归属时读根消息；无法证明 fail open 并留诊断。补“旧 child 运行中根收新消息再派孙”等门禁。
3. **P3 批量**：`archive_subagents` 增加 idle-with-inbox 跳过与行为测试；`ChildAnchors.delete` 清理 unscoped 或修掉 server 注释并补 root-scope 测试；`delegated-cancel` 类型改 `{withdrawnSince(seq)}` 视图、`signalled` 区分“已调用”与“实际有 activation”；index.js shutdown 失败也调度退出；修正 archived-lineage 的“verbatim”表述。
4. 性能项（BM-10）先测量再决定是否异步化/加缓存清理，避免把同步复制改出图片竞态。

## 8. 是否有阻断性健康问题

**无 P0/P1 阻断性问题。** 两个 P2 均为基线已有、本轮未修复：BR-08 属本地同用户/多用户文件边界（非远程可利用，未声称当前已被利用），BR-03 属撤回误取消（有明确复现条件）。在基线报告的修复清单里应继续按 P2 跟踪，不因本轮“无新 P1”而视为已关闭。
