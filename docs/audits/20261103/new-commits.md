# 修复轮后新提交（new-commits）审查 — 2026-11-03

- 审查基线：`0c82df5`（工作区仅有未跟踪的 `V1.txt`/`v1.txt` 与 `docs/audits/20261103/`）
- 审查范围：`e7472be..HEAD` 的 5 个提交 + `e7472be` 本身（它在修复轮 `6394809` 之后、不在 diff 区间内）+ 修复轮 `6394809` 的撤回/会话相关改动质量抽查
- 审查方式：fresh 上下文、独立只读；不采信提交信息自述，每个判断自己读码/复跑/打探针
- 对照：根 `AGENTS.md`「撤回（rewind）」章节四条约束与「客户端脉冲」章节、`docs/REWIND.md`（尤其「刷新：宿主 history 截断 + canary 自证」「完成提示」「只回文件」三节）、`docs/FULL-AUDIT-20261102.md` §4.1/§10.1、`docs/FIELD-NOTES.md` 78/79
- 宿主/协议对照：已装 `@getpaseo/cli` 内 `@getpaseo/server@0.14.0` 的 `agent-manager.js`、`agent-run-state.js`、`plugin-provider.js`、`timeline-projection.js`、`session.js`、`plugins/plugin-process.js`，以及仓库内 `@getpaseo/{client,plugin,protocol}@0.14.0` 的 d.ts 与实现（只读，未装包、未起 daemon/模型、未碰真实 `~/.dsh` profile）
- 禁项遵守：未改产品代码/文档/harness，无 git 写；唯一写入即本文件；编译产物只落 gitignored `paseo-plugin/.dbg-*` 与 `/tmp/nc-probe/`

## 1. 范围与方法（逐提交）

| 提交 | 声称 | 本轮判断（证据见 §3/§4） |
|---|---|---|
| `e7472be` fix(jobs-pill) 恢复 live-only | 走 CJ-01 路线 2：无 live 任务即隐藏、可读态图标恒为转环、删 `idleLabel`、隐藏态轮询回 4s | **成立**。`jobsPillPresentation`/`nextPollDelayMs`/`jobs-pill.tsx` 三处自洽；`CJ-02` 抖动+退避、`CJ-03` 分页、`CJ-04` 终态码均保留；finished 分组**不是**死代码（有 live 任务时仍可打开）；隐藏态 4s 与 DSH 原生「空闲显示数量」是**有意偏差**（用户既定语义），已在注释/README/FULL-AUDIT 写明。新检查 `jobs-poll-check` 100/100、`locale-check` 269/269、`jobs-popover-check` 插件半 148/148（宿主半因无 `HOST_APP` 跳过，见 §5） |
| `88adebb` feat(rewind) files scope | 桥接受 `files`；不动对话/不 append/不 flush/不截断/不 prune；同样停回合、取消并等待子代理、冻结写入；回执文案区分 | **成立**。`rewind-transaction-check` 17/17 实测覆盖（appends=0/flush=0/journal 保留/无 session store 可跑/子代理仍被中断并等待/闸门释放/回执不提 withdrawn）；`session-request-check` 52/52 覆盖 files 不发 canary 但发完成提示；协议侧 `session.revert.files ↔ supportsRewindFiles ↔ revertFiles(mode="files")` 与宿主 0.14 逐键对上。发现 NC-06（files 仍清 pending 权限且用「对话被撤回」文案）|
| `13951ad` feat(rewind) 完成提示 | 三类 scope 成功后给完成提示（时间线行 + 胶囊）；部分失败只留失败提示 | **方向成立、交付层当时不成立**（宿主 run lock 吞 notice，随即由 `aa72484`/`8091777` 重做）；本提交引入的双语 success 文案表未覆盖失败路径 → NC-04 |
| `aa72484` fix(rewind) 锁释放后再发 | 300ms 延迟绕过 run lock；canary 不动 | **判断正确、方案被证伪并回滚**：延迟是启发式（真机 1128ms 撤回仍丢），`8091777` 换通道后整模块删除；`revert-check` 断言 `REWIND_NOTICE_DELAY_MS|rewind-delivery` 已消失（120/120 绿）。**未动 canary 顺序**（与 AGENTS.md 第四条一致）|
| `8091777` fix(rewind) timeline.append + live 判定 | 报告改插件时间线行；conversation/both 等 `timeline.replacement` 再 append，超时 10s append 后复核补发一次；胶囊按 live 事件判定 | **主机制在真实宿主代码上成立**（`rewind-notice-delivery-check` 30/30：append 绕过 run lock、晚于 replacement、行不进 provider history、固定行 id 折叠；`host-contract-sim` 补丁宿主 7/7）。两处降级分支可静默丢行 → NC-01/NC-03；兜底 notice 被客户端 legacy 过滤器隐藏 → NC-02；报告构造期异常可反过来阻断撤回 → NC-05 |
| `0c82df5` test 判据修正 | before-hook 判据匹配真实调用而非注释文字 | **成立**。判据双向自测（注释不命中、真实 `.before("agent.session_open"`/单引号/带空格均命中），`rewind-notice-check` 63/63 |
| `6394809` 修复轮抽查 | 撤回事务/会话竞态等 | 抽查的撤回相关修复是**结构性**而非只堵反例：RW-01 清理清单补 `ticket.root` 且在 `beginFileMutation` 解析处重核身份（`server.js:2329-2332,3685-3689`）；RW-02/BF-04 改为 `restores` 条件化 `runMaintenance` 与闸门（`:2677,2686`）；RW-05 改用 `files.error` 通道；S01 双身份在首个 await 前占位等。**本轮未逐条复核其 fixed 清单**（fix-verify-* 三 lane 的职责）|

复跑清单（工作目录=仓库根，除注明外；exit code 均已核）：

| # | 命令 | exit | 结果 |
|---|---|---:|---|
| 1 | `node harness/rewind-notice-check.cjs` | 0 | 63/63 |
| 2 | `node harness/rewind-notice-delivery-check.mjs` | 0 | 30/30（含 5s 慢重建、300ms 超时降级子进程）|
| 3 | `node harness/rewind-transaction-check.mjs` | 0 | 17/17（files-only 全部新增断言）|
| 4 | `node harness/revert-check.mjs` | 0 | 120/120（canary 源码顺序、files 无 canary、300ms 路径已删）|
| 5 | `node harness/host-contract-sim.mjs "" paseo-plugin/.dbg-p17-delivery` | 0 | 7/7（已装宿主=补丁版：canary 回执前被截/回执后存活；stock 半未跑，见 §5）|
| 6 | `cd paseo-plugin/.dbg-p17-delivery && node session-request-check.cjs` | 0 | 52/52（provider 的 revert 分支、scope、计数、降级文案）|
| 7 | `npx tsc -p ../harness/jobs-poll.tsconfig.json` 后跑 `jobs-poll-check.cjs` | 0 | 100/100 |
| 8 | `cd paseo-plugin/.dbg-p17-delivery && node locale-check.cjs` | 0 | 269/269 |
| 9 | `node harness/bridge-assets-check.mjs` | 0 | 2/2（内嵌桥与 `dsh-bridge/` 同源，`files` 改动已重生成）|
| 10 | `cd paseo-plugin && npx tsc --noEmit` | 0 | 干净 |
| 11 | `node harness/jobs-popover-check.cjs`（无 `HOST_APP`）| 2 | 插件半 148/148，宿主半 SKIPPED（incomplete，见 §5）|
| 12 | 探针 `/tmp/nc-probe/{degrade-wipe,race-capture,fallback-hidden}.cjs` | 0/0/0 | 见 §3，复现 NC-01/NC-03/NC-02 |

判据有效性抽查（不是照单全收）：`rewind-notice-delivery-check` 的「超时后复核补发」分支**从未执行**——degraded 子进程里宿主仍在正常时刻派发 replacement（只是不下发给假订阅），append 时重建早已完成，行不会被吃；运行日志里没有 `wiped by a rebuild` / `appending it again`。即 NC-01 的补发分支既无真会话覆盖、也无降级覆盖。`rewind-notice-check` 里「unwatched agent 记录不到」一条是空虚判据（假 Paseo 只把事件投给已订阅 agent），但同文件其余状态机断言有效。

## 2. 健康度评分

**4 / 5（可发布，维护批次清理）**。理由：主机制（`timeline.append` 绕过 run lock、conversation/both 等 replacement 后落行、固定行 id 折叠、capsule 按 live 判定）在**真实宿主 0.14.0 代码**上双向复现，不是自造协议形状；files scope 与既有撤回事务的边界被事务测试逐条钉住；本轮 6 个提交没有发现 P0/P1/P2。扣 1 分：两处降级分支（超时复核、飞行中句柄捕获）仍可能**静默丢报告**，且失败通知的兜底路径在客户端被自己的 legacy 过滤器吃掉；失败文案未本地化；这些正好落在本功能「确定性送达」的承诺上（全为窄触发，P3）。

## 3. 发现列表

本轮无 P0/P1/P2，共 6 条 P3。「归属」= 由哪个提交引入（相对 `e7472be..HEAD`）。

| ID | 级别 | file:line | 触发条件 | 证据等级 | 归属 | 摘要 |
|---|---|---|---|---|---|---|
| NC-01 | P3 | `paseo-plugin/server/rewind-notice-append.ts:225-246`、`:367-395` | `agent.timeline.replacement` 未在超时（默认 10s）内到达，**且**宿主重建在 timeout+1.5s 复核之后才完成（超大会话的慢 hydrate / replacement 迟到 / 订阅 establishment 失败走了 timeout 分支）| **实测**（`/tmp/nc-probe/degrade-wipe.cjs`：真实 `AgentManager`+`PluginAgentClientRegistry`，3s 重建 vs 300ms 超时+1.5s 复核 → `appends: 1 | report rows left in the timeline store: 0`，日志无补发）+ 源码推断 | 新引入（8091777）| 超时路径 append 后只做**一次** 1.5s 复核；重建的 `timelineStore.delete` 发生在慢的历史读取**之后**，复核时行还在 → 判定「存活」→ 不再补发；重建随后把它抹掉，无第二次检查、无日志。注释/文档称「降级显式且有界」，实际是「有界的时间内仍可能静默丢失」。`harness/rewind-notice-delivery-check.mjs:639-667` 的降级场景没有覆盖「append 之后才完成的重建」，补发分支从未执行（§1 判据抽查），所以这条路径目前没有任何红绿证据 |
| NC-02 | P3 | `paseo-plugin/client/rewind-notice-data.ts:58-60`；`paseo-plugin/server/provider.ts:1336-1340`；`paseo-plugin/client/rewind-notice.tsx`/`index.client.tsx` 的 notification transformer | append 失败（`fail()` 走 `#reportFallback`）或无 `PASEO_AGENT_ID` 时的兜底 `session.notice` | **实测**（`/tmp/nc-probe/fallback-hidden.cjs`：`rewindSuccessText(UI.rewind,"conversation") === "已撤回到这条消息"`，`isLegacyRewindNotice(...) === true`；失败标题 `文件回退未完成` 同样 true）+ 源码推断 | 新引入（8091777 的 legacy 过滤器 × 13951ad 起的兜底文案）| 兜底 notice 的文案与旧路径完全相同，被客户端「删除 legacy 撤回行」的 transformer 识别并 `return {items: []}`。所以 append 失败时：run lock 内直接丢；若恰好锁外送达/后续重建重放，也会被客户端删掉。provider 注释「so an append failure is never silent」只剩 stderr 日志成立，UI 上不可见。修法方向：兜底用一条不进入 legacy 文案表的标题（如加「（降级）」前缀），或 legacy 过滤只对 `phase: "complete"` 的历史项生效 |
| NC-03 | P3 | `paseo-plugin/server/rewind-notice-append.ts:340-347`、`:367-395`；`paseo-plugin/server/provider.ts:1036-1055` | `beginRewindReport` 时 `paseo` 句柄尚未捕获，而句柄在 `deliver()` 之前被并发回调捕获（客户端 bundle 的 `rewind.notice.arm`、jobs pill 每 4s 的 `jobs.list`）| **实测**（`/tmp/nc-probe/race-capture.cjs`：`handle before begin: false` → `capturePaseo` → `deliver` → `appends: 1 | subscribes: 0`，即**没有** replacement 订阅、也不会走 `verifyAfterTimeout`）+ 源码推断 | 新引入（8091777）| `#watch` 只在构造时按「当时有没有句柄」一次性决定；`#deliver` 只看「现在有没有句柄」——两者组合出第三条路径：不排队（不写日志）、不等待、不建订阅、不复核，收到回执后立即 append。conversation/both 上该 append 可能早于宿主 rebuild 而被抹掉且无日志。与 NC-01 是同一个根：报告送达只在「构造时已有句柄」这条主路径上确定。窗口窄，但正是 `arm` RPC 想覆盖的「重启后首个回调之前」窗口的邻域 |
| NC-04 | P3 | `paseo-plugin/server/provider.ts:1164`（及 `:1140-1186` 的各条明细）；`paseo-plugin/shared/rewind-notice.ts:147,159,230-244` | 英文宿主（`DSH_PASEO_LANG=en`/`LANG=en`）上的部分失败撤回 | **实测**（`DSH_PASEO_LANG=en` 载入编译产物：success = `"Rewound to this message"`，`UI.rewind.failureTitle = "File rollback incomplete"`；源码 `provider.ts:1164` 仍硬编码 `文件回退未完成`）+ 源码推断 | 新引入（13951ad 的双语表只覆盖 success）| 成功文案按 `UI.rewind` 本地化，失败文案与明细（`恢复失败`/`未能恢复`/`未能快照`/`journal 与 rescue 目录`）是 provider 内硬编码中文；`REWIND_COPY.en.failureTitle` 永远发不出去，只在客户端 legacy 识别里用（而死代码）。结果：同一功能的成功提示英文、失败提示中文，混排。测试只钉了中文列（`session-request-check` 固定 `zh-CN`），英文列在失败路径无覆盖。注：失败文案本身基线已有，属 13951ad 新增双语表时未把失败路径纳入 |
| NC-05 | P3 | `paseo-plugin/server/provider.ts:1036-1045`；`paseo-plugin/server/rewind-notice-append.ts:260-317`（`replacementWatch` 的 `subscribe` 未包 try/catch）| `api.agents.ref(agentId).timeline.subscribe` 同步抛错（宿主/`PaseoApi` 版本早于 timeline 订阅接口、句柄形状不符）| 源码推断（`send()` 的 catch 会把异常翻成 `request.failed`：`provider.ts:565-577`）| 新引入（8091777）| 报告机制建在撤回请求路径的**最前面**且无本地兜底：构造期一抛，整个 `session.revert` 变成 `request.failed`，用户**撤不回去**。对比 append 失败有 notice 兜底、订阅失败有 `settle(false)` 兜底，构造期是唯一没有兜底的环节。`peerDependencies` 只写 `@getpaseo/plugin >=0.9.2`，旧版本有没有 `timeline.subscribe` 未验证（§5）；建议把 `beginRewindReport` 包一层 try/catch 降级为「直接走 notice 兜底」 |
| NC-06 | P3 | `paseo-plugin/server/session.ts:818-829`（`:827`）| `scope: "files"` 的撤回，且会话里仍挂着等待回答的提问卡 | 源码推断 | 新引入（88adebb 引入 files scope，未条件化基线 `83340c4` 的行为）| `DshSession.revert` 不区分 scope，一律 `#clearPendingPermissions("The conversation was rewound past this question…")`。files-only 明文「不动对话」，却被按「对话被撤回」处理：若提问卡真还在，用户看到的是错误原因；若宿主取消回合时已把卡清掉，则该调用是空操作。与 `REWIND.md` 的 files 语义不一致，建议按 `scope !== "files"` 条件化（或改成中性文案）。注：宿主在撤回前会先取消根回合，实际命中概率取决于 DSH 取消时是否已清卡，未做真机验证 |

计数：**P0=0，P1=0，P2=0，P3=6**。若按「功能缺失」而非「显示/健壮性」口径，NC-01/NC-03（撤回报告静默丢失）可上调 P2；本报告按任务书口径（提示/显示层）记 P3。

## 4. 阴性结论（判过、不报）

1. **canary 顺序未被本轮改动破坏**（AGENTS.md 第四条）：`provider.ts:1095` 的 `rewindCanaryNotice` 在 `:1102` 的 `request.completed` 之前；`scope === "files"` 不发。`revert-check` 的源码位置门 + `host-contract-sim` 在真实宿主上双向断言（回执前发的被截、回执后发的存活，7/7）都通过。`aa72484`/`8091777` 只改完成报告，**没有**把 canary 挪到回执后。
2. **完成报告改走 timeline.append 的主机制成立**：`AgentManager.rewind` 全程持 foreground run lock，`enqueueSessionEvent` 在 `start.status === "pending"` 时把 provider 事件压进 `stagedEvents`，`settleForegroundRun → clearRun` 只 settle、不回放（宿主 0.14.0 `agent-run-state.js:190,205-211`）；`appendTimelineItem` 走 `recordTimeline + dispatchStream`（`agent-manager.js:1784-1800`）不经 staging。`rewind-notice-delivery-check` 在真实 `AgentManager` 上复现「回执同拍的 notice 被丢、plugin 行存活」，并断言 conversation/both 的 append 晚于宿主派发的 `timeline_replacement`（+0ms / 5s 慢重建 +0ms）、行不进 `session.history`、两次撤回后只有一行且是新 `noticeId`。
3. **胶囊按 live 事件判定在重放/重开/多客户端下正确**：重放/refetch 的行没有 live 记录 → `take()` 返回 false，不弹；同一 `noticeId` 重复投递/remount 只弹一次；目录 watch 有界（16）且关闭/移除会 release；`active` 单例是 per-bundle。`rewind-notice-check` 63/63 覆盖该状态机。多客户端各弹各的胶囊是预期（报告行是 daemon 侧广播）。
4. **固定行 id 的「折叠/替换」不是自造契约**：宿主 `timeline-projection.js:96-107` 的 `mergeIdentityEntries`（case `"plugin"` 保留 `existing.seqStart`、取新 data）+ `@getpaseo/protocol/timeline-identity.js` 的 `` `${pluginId}/${id}` `` + 客户端同一 key（web bundle `E(t)`/`P(t,n)`）三处一致，所以后一次报告替换而不是堆行。
5. **files scope 与 both 的边界成立**：`rewind-transaction-check` 17/17 实测（不 append 标记、flush 0 次、journal 保留、无 session store 也能跑、仍取消/等待被撤回子代理、闸门释放、`files` 回执不写 withdrawn、重复 files-only 幂等、之后 `both` 仍取目标消息自己的 pre-image）；桥 `successText(seq,'files')` = `Restored files to seq N`。
6. **files scope 不发 canary 但发完成提示**：`provider.ts:1090-1096` 条件 + `session-request-check` 的 scope 用例（52/52）。
7. **e7472be 与修复轮 CJ-01 路线 2 自洽**：无 live 任务即隐藏、可读态只用转环、`idleLabel` 已从 locale/类型/测试中删除；finished 分组不是死代码（pill 可见时必有 ≥1 live 任务，popover 里该分组仍可展开；`jobs-popover-check` 的 folded section 断言仍在）；CJ-02 的抖动仍由 `initialPollDelayMs`/`nextPollDelayMs` 保留，失败退避 8→16→30s、CJ-03 分页、CJ-04 终态码都在。**隐藏态 4s 轮询是有意偏差**（live-only 下隐藏是常态，需要 4s 感知新任务；CJ-02 的「隐藏全速」由此实质回归，代价已在注释与 FULL-AUDIT §10.3 记录：需桥侧 liveOnly/增量才能根治）。与 DSH 原生「空闲仍显示数量」的偏差来自用户既定语义，不是实现失误。
8. **0c82df5 的判据修正有效且有归因力**：`/\.before\(\s*["']agent\.session_open["']/` 对当前代码（注释里写的是 `agent.session.open`）不命中，对真实调用（双引号/单引号/带空格）均命中；62→63 条全绿。
9. **协议形状无自造**：逐项核对已装 0.14 的 d.ts/实现——`timeline.append(item: Omit<PluginTimelineItem,"pluginId">)`、`agent.timeline.append.request` schema `{type:"plugin",id,kind,version,data:JsonValue}`、订阅事件四型（`timeline`/`replacement`/`subscription_restored`/`error`）、`refetch` 页 `entries[].item`、`agents.list({scope:"active",page,sort,subscribe:{}})` 的 `FetchAgentsPayload`/`agent_update` `upsert|remove`、`defineRpc` 的 `^[a-z][a-z0-9._-]*$`（`rewind.notice.arm` 合法）、renderer 按 `kind + version` 注册（version 1→2 同步）。`session.revert.files` 与宿主 `supportsRewindFiles: supports("session.revert.files")`、`revertFiles → revert(messageId,"files")` 全链一致。
10. **6394809 抽查是结构性修复**（非只改测试判据）：RW-01 的票据清理带 `ticket.root` 并依赖 `beginFileMutation` 的身份重核（不会误放已退役的写）；RW-02/BF-04 用 `restores` 条件化内部 API 依赖与文件闸门；RW-05 换 `files.error` 通道；S01 双身份在首个 await 前同步占位。与 `88adebb` 的 files scope 改动叠加后仍未破坏撤回事务（17/17）。
11. **host-contract-sim 的补丁半与 provider 半文案一致**：宿主 `translateNotice` 的 title+description 拼接与 `rewind-canary.ts` 逐字一致（7/7），说明本轮 provider 结构重排没有碰 canary 文案。

## 5. 未验证项

1. **真实 daemon / 真实模型回合 / 真机 UI**：按任务书未起 daemon、未用真实 `~/.dsh`、未开 app。补丁宿主上「canary 被截」「报告行出现」「胶囊弹一次」的真实端到端表现未在真机取证；NC-06 的真实命中率（宿主取消回合时是否已清提问卡）也未验证。
2. **`host-contract-sim` 的 stock 半**：需要 `npm pack @getpaseo/server` 解包 + 包装目录（脚本头注释），本轮未装包，只跑了已装（补丁版）宿主 7/7。所以「未打补丁宿主上 canary 经 provider history 重放留在底部」只有源码推断 + 我复跑 delivery-check 时观察到的同类现象（fake token 使 truncate 失败后，`撤回已生效` 通知行确实被重建重放进 timeline store），未在 stock 宿主真实代码上断言。
3. **超长会话（hydrate > 11.5s）与飞行中句柄捕获的真实触发**：NC-01/NC-03 用压缩时间的探针建模（300ms 超时/3s 重建；无句柄→捕获→deliver），生产默认 10s+1.5s 下需要真实超大会话或订阅失败才会命中；真实发生率未测。
4. **旧版 Paseo（<0.14）兼容边界**：`@getpaseo/plugin` peer 写 `>=0.9.2`，但 `timeline.subscribe`/renderer version 2/`defineRpc` 在 0.9.x 是否存在未验证（仓内只装了 0.14 的包、全局只有 0.14 的 CLI）；NC-05 的触发面因此是「未验证」而非「已确认可达」。
5. **jobs-popover 宿主半**：无 `HOST_APP`（Paseo checkout），`jobs-popover-check.cjs` 已知 exit 2 incomplete；e7472be 改的 popover 几何/状态标记只核到插件半 148/148，未与真实 Paseo app 常量对照。
6. **镜像/多客户端**：未在 app 里同时开两个客户端验证胶囊与目录订阅；多客户端行为只有源码推断。
7. **`DSH_PASEO_REWIND_REPLACEMENT_TIMEOUT_MS` 的生产语义**：为 harness 而设的 env 覆盖在生产被外部设置会改变行为，未验证部署面是否可能设置。
8. **修复轮 `6394809` 的 fixed 清单**：只做了撤回/会话相关抽查，未逐条复核（fix-verify-* 三 lane 职责）；`6394809` 引入的 jobs pill 路线 1 语义已在 `e7472be` 回滚，回滚本身验证见 §4.7。

## 6. 跨 lane 提示

1. **与 `plugin-rewind-notice` lane 重叠 / 互证**：该 lane 的 RN-02（超时复核之后无界）与本报告 NC-01 同源，RN-01（飞行中句柄捕获）与 NC-03 同源；本报告用 `/tmp/nc-probe/degrade-wipe.cjs`、`race-capture.cjs` 把它们从「源码推断 + 测试缺口」升级为**实测**（静默丢行已复现：append 1 次、时间线 0 行），裁决时可采信两 lane 的共同结论并采用本报告的证据等级。RN-03（补发 → 二次胶囊）我复核逻辑成立（`verifyAfterTimeout` 重 append 生成新 `noticeId` → live monitor 记录 → 行组件 data 变化 effect 重跑 → 二次 `take()`），与本报告 NC-01 同一触发面，可合并。RN-04/05/06 属该 lane 领域，本报告不重复。
2. **与 `plugin-rewind-notice` 的 RN-08 相关**：该 lane 指出文档对 canary 交付层「任何宿主都看不到」的表述过强——我复核了宿主路径：`translateNotice` 把 notice 作为 `timeline/notification` 事件 `history.push`，stock 宿主 `forceHydrateTimelineFromProvider` 会重放整个 history，所以 stock 宿主上 canary **能**经重建出现在时间线（我复跑的 delivery-check 里 fake token 撤回后确实出现多条 `撤回已生效` 行）。建议 docs lane 按该结论修 REWIND.md/FIELD-NOTES 78 的「都观察不到」；这与本报告 §4.2 的机制不冲突（live 投递确实被锁吞，重放才让它出现）。
3. **与 client-jobs / delivery lane**：`e7472be` 的「隐藏态 4s 轮询」是有意权衡，不要当回归再改回 15s；若要根治需桥侧 liveOnly/增量（FULL-AUDIT §10.3 已暂缓）。NC-02 也涉及 delivery 语义（兜底不可见），若 delivery lane 有「失败要响亮」的检查清单，应把「兜底文案被客户端过滤器吃掉」纳入。
4. **给 docs lane**：`docs/REWIND.md` 的「完成提示」节称超时降级「显式且有界、必要时补发一次」，建议改为「有界但存在一次未覆盖的静默丢失窗口（重建晚于复核）」；`docs/FIELD-NOTES.md` 78 的 canary 结论按第 2 条修正。AGENTS.md 撤回必跑清单未列入 `rewind-notice-check.cjs`/`rewind-notice-delivery-check.mjs`（只在 HARNESS.md 登记），改报告/追加检查时不要漏跑。
