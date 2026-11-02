# plugin-timeline lane 全量审查（2026-11-03）

- 审查对象（逐行通读，非抽样）：`paseo-plugin/server/timeline.ts`（1400）、`frame-reader.ts`（289）、
  `first-token.ts`（102）、`activity-timeline.ts`（122）、`locale.ts`（311）、`json-value.ts`（16），共 2240 行。
- 审查基线：HEAD `0c82df5`（main）；工作区只有未跟踪的 `V1.txt` / `v1.txt` 与并行 lane 的
  `docs/audits/20261103/*.md`，本 lane 未改任何产品/文档/harness 文件。
- 环境：DSH `0.2.1-rc.5`（`~/.npm-global/lib/node_modules/@deepseek-ai/dsh`）、
  Paseo `@getpaseo/server` `0.14.0`（`@getpaseo/cli` 内嵌）、Node `v22.23.1`。
- 只读边界：未启动真实 daemon、未跑真实模型回合、未写真实 `~/.dsh` profile、未装包、未 git 写。
  临时探针只落 `/tmp/tl-audit` 与 gitignored 的 `paseo-plugin/.dbg-tl-*`。

## 1. 范围与方法

| 文件 | 行数 | 通读 | 调用点/对照 |
|---|---|---|---|
| `server/timeline.ts` | 1400 | 全文 | `session.ts`（replay/live/首 token 接线）、`dsh-process.ts`（分帧入口）、宿主 `plugin-provider.js`/`timeline-projection.js`/`agent-timeline-store.js` |
| `server/frame-reader.ts` | 289 | 全文 | `dsh-process.ts:2670-2681`（`#consume`/`#dispatch`） |
| `server/first-token.ts` | 102 | 全文 | 已装 DSH `dsh-llm/lib/types/assistant-stream.js:185-300`、`dsh-session-stats/lib/{index.js,types/projection.js}` |
| `server/activity-timeline.ts` | 122 | 全文 | 已装 DSH `dsh-tool-workflow`/`dsh-goal` 事件词表（沿用上轮结论，本轮抽查 `stopReason`/`outcome` 允许集）、`client/tool-call-data.ts` |
| `server/locale.ts` | 311 | 全文 | 新增 `shared/rewind-notice.ts` 接缝、`client/locale.ts`、`client/rewind-notice-data.ts` |
| `server/json-value.ts` | 16 | 全文 | 全仓 import 面（`dsh-process.ts` 再导出、`session.ts` 引用） |

**本轮新增接缝（`88adebb..HEAD`）**：`git diff --stat 88adebb..HEAD` 共 17 文件 +2952/−34，其中
timeline lane 六文件只有 `locale.ts` +14 行（`UI.rewind` 表接入）；`timeline.ts`/`frame-reader.ts`/
`first-token.ts`/`activity-timeline.ts`/`json-value.ts` 与上一轮基线 `2f71225` **逐字节相同**
（`git diff --stat 2f71225..HEAD -- <六文件>` 只有 locale.ts +14）。因此本轮重点是：
① 复审基线已有项在当前 HEAD 是否仍成立；② 核查新 rewind 提示链（`shared/rewind-notice.ts`、
`server/rewind-notice-append.ts`、`index.client.tsx`、`client/rewind-notice-*`）对 timeline 的接缝；
③ 复核撤回缝折叠（`dsh-bridge/lib/surface.js`）与 compaction 保留约束。

**对上轮审查的对照**：`docs/FULL-AUDIT-20261102.md` §4.2.1 的 7 条 P3 本轮逐条复核——
FT-01→TL-03、FT-02→TL-04、FT-03→TL-09、FT-04→TL-05、FT-05→TL-06、FT-06→TL-07、FT-07→TL-10，
全部在当前 HEAD 仍成立（源码依据 + 本轮探针复现），无一条被新提交顺手修掉。§10.1 的
p4-plugin-session / p1b-snapshots 修复包不在本 lane 文件范围内，唯一与 timeline 相邻的是
p1b 的 `files.error` 回执接入——本轮它落在新的 rewind 提示链上，由 TL-01/TL-02 与
`rewind-notice-delivery-check`（30/30）/`session-request-check`（52/52）覆盖。

**亲跑检查（全部 exit 0）**：

| 检查 | 结果 |
|---|---|
| `node harness/frame-reader-check.mjs` | 32 passed, 0 failed |
| `node harness/timeline-check.cjs`（按头注释编译到私有 `.dbg-tl-audit`；tsc 预期 exit 2，产物运行） | 208 passed, 0 failed |
| `node harness/p003-timeline-check.cjs` | 8 P003 timeline checks passed |
| `node harness/locale-check.cjs` | 269 passed, 0 failed |
| `node harness/rewind-notice-check.cjs` | 63/63 passed |
| `node harness/rewind-notice-delivery-check.mjs`（真实宿主 `PluginAgentClientRegistry`/`AgentManager`） | 30/30 passed（含 degraded 4/4） |
| `node harness/assistant-stream-check.cjs` | 7/7 passed |
| `node harness/surface-check.mjs` | 18 passed, 0 failed |
| `node harness/image-check.cjs` | 8/8 passed |
| `node harness/revert-check.mjs` | 120 passed, 0 failed |
| `node harness/session-request-check.cjs` | 52/52 passed |
| `node harness/host-contract-sim.mjs` | 7/7 passed |
| `cd paseo-plugin && npx tsc --noEmit` | exit 0 |

**自写探针（全部 exit 0）**：首 token 差分（vs 已装 DSH 0.2.1-rc.5）、分帧边界/`parseFrame`
类型探针、timeline 复验探针（subagent_fork / bash workdir / 失败 identity / 未知 content block）、
可观测私有字段的缓存计数探针、workflow 失败行的客户端渲染探针、rewind 文案识别探针。

## 2. 健康度评分

| 维度 | 分数 | 理由 |
|---|---|---|
| 正确性 | 4 | 工具行状态机、compaction 双态不变量、attempt 后缀、撤回缝折叠、图片行本轮回归全绿；新接缝未见会坏主流程的错误 |
| 健壮性 | 4 | 分帧线性化 + 未终止帧上限；activity 异常转可见 error 行；扣分：每会话缓存无生命周期/字节预算，分帧上限有一处口径漏洞 |
| 可维护性 | 4 | 注释质量与不变量写清；扣分：`parseFrame` 的“非对象帧只是路由不到”与实现不符、`subagent_fork`/`workdir` 死字段、`activity` 的 `error` 形状与 timeline 不一致 |
| 契约一致性 | 4 | 产出过真实 `ProviderEventSchema`；新接缝的 plugin 行 identity/`pluginId` 由宿主注入（已核）；扣分：failed 行 `error` 形状分叉、fallback 通知被自己的 legacy 清理隐藏 |
| 性能 | 4 | 分帧 808× 提升且逐字节保真；单帧有界；扣分：会话级缓存/输入长期驻留无预算 |
| 安全 | 4 | 分帧内存有界、图片 markdown 按宿主规则转义、JSON 值边界不伪造；未发现注入/越权面 |
| 测试覆盖 | 4 | 本组模块回归密度全仓最高（208+32+8+269+63+30+7+18+8）；扣分：首 token 无差分门、fallback 通知可见性无断言、failureTitle 表未接入无断言 |

**总体 4.0/5**（与上轮 4.0 持平）。**无 P0/P1/P2，无阻断性健康问题**：本轮新发现 2 条接缝 P3
（fallback 通知被隐藏、部分失败文案未接入共享 locale 表），其余 8 条为上轮已登记 P3 在当前 HEAD
的复现/细化；`timeline.ts` 本体在本轮新提交中零改动，没有引入新回归。

## 3. 发现列表

格式：`ID | 级别 | file:line | 触发条件 | 证据等级 | 归属 | 摘要`

| ID | 级别 | 位置 | 触发条件 | 证据等级 | 归属 | 摘要 |
|---|---|---|---|---|---|---|
| TL-01 | P3 | `paseo-plugin/index.client.tsx:214-218`（transformer）、`paseo-plugin/server/provider.ts:1336-1343`（`#reportFallback`）、`paseo-plugin/client/rewind-notice-data.ts:58-60`、`paseo-plugin/shared/rewind-notice.ts:230-244` | 撤回报告的主通道 `timeline.append` 失败，或会话没有 `PASEO_AGENT_ID`（`provider.ts:1027-1050`）→ 走 fallback 发 `session.notice`。该通知的 `message` 就是共享文案表里的成功/失败句子（`title\ndescription`），而客户端对**所有** `itemType: "notification"` 行做“legacy 撤回通知清理”，命中即 `{items: []}` 删除 → 用户看不到任何报告，只有插件 stderr 的 `fail()` 日志 | 实测（编译产物：4 种 fallback 文案全部被 `isLegacyRewindNotice` 判为 legacy）+ 源码（宿主 `plugin-provider.js:1223-1240` 把 notice 拼成 `title\ndescription`；`session.js:6012-6021` 的 append 才注入 `pluginId`） | **新引入**（`8091777`/`0c82df5` 同时引入 fallback 与 legacy 清理，两条路径用同一张文案表识别） | 主通道失败时报告“双保险”实际都不可见：无 agentId 的 fallback 通知在 rewind run lock 内发出、会被宿主 staging 丢弃（FIELD-NOTES 78）；append 抛错的 fallback 即使落地也被上面的 transformer 删除。与 `rewind-notice-append.ts:42-46` 自称的“Failure is loud, never silent”不符（仅 stderr 响） |
| TL-02 | P3 | `paseo-plugin/server/provider.ts:1163-1166` vs `paseo-plugin/shared/rewind-notice.ts:122,147,159`、`paseo-plugin/server/locale.ts:83-92,126,154` | `DSH_PASEO_LANG=en`（或非中文 LANG）下发生**部分文件回退失败**：成功报告用 `UI.rewind` 英文表，失败行标题却硬编码 `文件回退未完成`（详情 parts/tail 也全中文），共享表里已有的 `failureTitle` 服务端从未使用 | 实测（`DSH_PASEO_LANG=en` 加载编译产物：`UI.rewind.failureTitle="File rollback incomplete"`、成功句英文；源码 grep 无 `UI.rewind.failureTitle`，`provider.ts` 含硬编码中文）+ 源码 | **新引入接缝**（`13951ad` 建表、`8091777` 迁到 append 时未接 failureTitle；中文硬编码本身是基线） | 撤回提示链的 locale 只覆盖成功文案；失败行在英文环境下中英混排，而客户端识别仍能命中（`rewindNoticeTone` 同时接受两 locale），所以不会报错、只会“看起来没翻译” |
| TL-03 | P3 | `paseo-plugin/server/timeline.ts:726-728`（`#items`/`#toolNames`/`#toolInputs`，写入 `:958`/`:1063`，读取 `:1108`，刻意保留见 `:1335-1341`）、`:738`（`#attempts`，写入 `:1021-1028`）、`:790`+`:1293`（`#compactionCommands`，全文件无 delete）、`:767`（`#summarizedCompactions`）；`paseo-plugin/server/activity-timeline.ts:31`（`#runs` 成员 Map 不清除） | 长会话持续增长、无字节/条数上限；`turn/end` 只清 `#toolNames`（`timeline.ts:1342`）。实测 100 回合（每回合一次 10 KB `write` + 一次 `/compact` 括号）：`items=300`、`toolInputs=100` 且**仍保留 1,024,000 字符参数**、`compactionCommands=100`（只增不删） | 实测（可观测私有字段探针）+ 源码 | 基线已有（文件与上轮基线逐字节相同） | 一个 24h 会话每次大 write/edit 的参数都留在插件（daemon 子进程）内存里直到会话销毁；建议按“会话级预算 + 完成即可弃”统一收口，而不是只修一个 map |
| TL-04 | P3 | `paseo-plugin/server/timeline.ts:669-676`（只 `"subagent"`）、对照已装 DSH `dsh-web-app/presets/standard.patch.yml:99-103`、`client/tool-call-data.ts`（`sub_agent` 渲染已就绪） | 模型调用 `subagent_fork`（standard 预设同时注册 `subagent` 与 `subagent_fork`，参数 schema 相同）→ 落到 `default` 分支的 `unknown` detail，行内显示原始 JSON（含完整 `prompt`）而不是「描述 + 日志」卡 | 实测（builder 探针：`detail.type="unknown"`）+ DSH 配置源码 | 基线已有 | 一行 `case "subagent": case "subagent_fork":` 即可，零风险；属“能力声明与数据源一致”同类 |
| TL-05 | P3 | `paseo-plugin/server/frame-reader.ts:186-199` vs `:202-213`（上限只在未终止尾段检查）；`:206-212`（`dropped` 不计 discarding 段）；`:238-247`（`parseFrame` 注释称非对象帧“只是路由不到”）；消费点 `paseo-plugin/server/dsh-process.ts:2697`（`frame.method`） | ① 终止符与越过上限的字节落在同一 chunk：先按换行完成该行并返回，`maxPendingBytes` 检查不跑（实测 limit=6：`push("aaaa")` + `push("bbbbbb\n")` → 交付 10 字符行、`onOverflow` 0 次）；② `dropped` 只报触发前累计（实测 limit=4：报 `dropped:5`，实际丢弃 8 字节）；③ `JSON.parse("null")` 返回 `null` 却按 `Frame` 交给下游，`#dispatch` 读 `frame.method` 抛 `TypeError`，被 `#consume` 的 async catch 记成“dispatching a bridge frame failed” | 实测（自写分帧探针）+ 源码 | 基线已有（①②为上轮 FT-04 复现；③本轮新定位） | 生产 chunk 受流缓冲限制（16–64 KB），内存上界只多一个 chunk，不构成 OOM；②是日志口径、③是注释与实现不符 + 日志措辞误导，均不改变可用性 |
| TL-06 | P3 | `paseo-plugin/server/first-token.ts:9-21`（自称 verbatim port）、`:55-63`（`dt[index-1] ?? 0` 与 DSH 的 `dt[index-1]` 不同）、`:71-73`（`isRecord` 排除数组，与 `timeline.ts:35` 同名函数语义不同）；调用点 `paseo-plugin/server/session.ts:2494-2501,2642-2656`；桥侧 `dsh-bridge/lib/server.js:769,867`；DSH 对照 `dsh-session-stats/lib/types/projection.js:86-89`、`dsh-client-ui-chat/lib/client.js:5794`；客户端标签 `paseo-plugin/client/stream-stats.tsx:86-87` | ① 仓库没有任何断言钉住移植与 DSH 一致（只有 `plugin-check` 断言出现一行合理数值），DSH 改 `isTokenDelta`/`runFirstTokenTime`/compact record 形状时静默漂移；② 差分实测 5000 条随机合法 stream 与已装 0.2.1-rc.5 全等（0 mismatch、1318 无 token），但畸形输入行为不同（插件返回 `undefined`、DSH 抛 `TypeError`），"verbatim" 措辞偏强；③ 口径：`firstTokenMs = durable 首 token − 桥侧 attempt start`（`startedAt: Date.now()`），而 DSH 自己的 TTFT 起点是 durable `step/start` 的 `event.time`，插件数值系统性偏小（差值未实测）；客户端把它标成「首字」，但分子是首个 token（可能是 reasoning/tool-call），纯 tool-call 步则完全没有 `firstTokenMs`（`#observeStreamSnapshot` 要求 `firstTextAt`） | ①源码；②实测（差分 5000/5000）；③源码推断（两侧起点不同已核，量级未实测） | 基线已有（`first-token.ts` 未改；③本轮新定位） | 建议加纯离线差分脚本（require 已装 DSH 的 `assistantStreamFirstTokenTime` 逐值比较）并把 `?? 0`/`isRecord` 差异注释成“有意增强”；③要么改起点/改标签，要么在注释里写明“首 token（任意类型）相对 attempt start” |
| TL-07 | P3 | `paseo-plugin/server/timeline.ts:594`（bash 读 `input.cwd`）、`:1070-1143`（失败只取 `message.content`/兜底 `"tool failed"`）、`:50-56`+`:136-151`（`textOf`/`imageRows` 之外的 content block 静默丢弃） | ① DSH bash 的模型参数是 `workdir`（已装 `dsh-tool-bash/lib/index.js:510`；`cwd` 是 DSH 自己 `presentBashCall` 算的），插件读 `cwd` 永不命中 → Paseo `shell.cwd` 永远为空（当前客户端不读该字段，属死字段）；② `tool/result` 的 `data.error`（`{name,code,reason}`）未使用，失败文本为空时行只剩 `"tool failed"`（实测：带 `data.error` 且 content 空 → `error:{message:"tool failed"}`）；③ assistant/tool 结果里 text/image 以外的 content block 静默丢弃，不建行也不告警（实测：未知块 → 0 item、0 warning），与同文件把 activity 异常转 error 行的取向不一致 | 实测（builder 探针 + DSH d.ts/源码） | 基线已有 | ①③今日无可见影响（①客户端不读、③DSH 现无此类块），②影响面取决于 agent-loop 是否总填渲染文本（推断：通常填）；三条都建议至少留注释/告警 |
| TL-08 | P3 | `paseo-plugin/server/activity-timeline.ts:83`（failed 行 `error: "Workflow ended with error"`）vs `paseo-plugin/server/timeline.ts:1138`（`error:{message}`）；消费点 `paseo-plugin/client/tool-call-data.ts:1041-1054` | workflow `run-end` 的 `stopReason === "error"` → 行 `status:"failed"`、`error` 是**裸字符串**（协议 `ProviderToolCallItem` 的 `error` 是 `JsonValue`，合法），但客户端 `errorTextOf` 只读 `{message}` → 渲染数据 `error=""`（实测 `toolCallData.error=""`），失败原因被丢弃（`summary` 仍显示「失败」）；该字符串还恒为英文 | 实测（builder + 客户端 `toolCallData` 探针；`ProviderEventSchema.parse` 两种形状都接受）+ 源码 | 基线已有（`error` 形状分叉本轮新定位；英文文案上轮 FT-03 已记） | 建议改成 `error:{message:...}` 并走 locale 表；一行改动，让客户端与协议参考适配器同形 |
| TL-09 | P3 | `paseo-plugin/server/rewind-canary.ts:57-63`（title/description 全中文硬编码，无 locale 入参）；`paseo-plugin/server/session.ts:1033-1034`（历史读取失败通知中文）；`paseo-plugin/server/timeline.ts:1138`（`"tool failed"`）、`:1351`（`"The turn failed."`）；`paseo-plugin/server/activity-timeline.ts:83`（英文） | `DSH_PASEO_LANG=en` 或非中文 LANG：`locale.ts` 的 modes/settings/planCard/toolLabels/commands/skills 走英文，但撤回 canary、历史读取失败通知仍是中文；反向（zh 环境）workflow 失败行/回合失败行是英文。本轮之后 canary 是**唯一**留在宿主时间线上的撤回说明（成功报告改走 plugin 行），英文用户只能看到中文警告 | 实测（`DSH_PASEO_LANG=en` 加载 `UI`/`REWIND_COPY`；源码逐条）+ 源码 | 基线已有（上轮 FT-03；本轮强调 canary 权重上升） | 要么给 canary/通知加 locale，要么在注释里明确“只有 UI 表承诺本地化”，别让 `DSH_PASEO_LANG` 看起来覆盖全链 |
| TL-10 | P3 | `paseo-plugin/server/timeline.ts:1123-1127`（每次 `todo_write` 的 `tool/result` 都发 `todo` 行）；宿主 `plugin-provider.js` 的 `mapTimelineItem` 对非消息项剥 id + `timeline-projection.js` 只按 `tool_call`/`plugin` identity 折叠 | 同一个 `todo_write` 的 `tool/result` 若被投递两次，会追加两条 TODO 行且插件无法撤回；可达性取决于 DSH tool-result pruner 是否会把小体积 todo 结果替换重发（已装 `dsh-compaction-tool-result-pruner` 有字符阈值，todo 结果通常远低于阈值） | 源码 + **可达性未验证** | 基线已有（上轮 FT-07） | 同形状的 `error` 行（`timeline.ts:1353`）也是追加语义，但桥不重复投递 `turn/end`，未发现可达路径 |

### 3.1 重点说明

- **TL-01 是本轮最值得修的新接缝**：它不是“显示文案”问题，而是主通道失败时**用户可见层为零**。
  修法有两类：① legacy 清理只作用于“来自历史重放”的通知（宿主 `notification` 行没有来源字段，
  需要插件侧在 fallback 文案上加一个可识别的标记/不同措辞，或让 transformer 只处理
  `initialTimeline` 那一批）；② fallback 改用另一种文案并让客户端识别两种（不改 legacy 清理语义）。
  无论哪种，都要加一条断言：append 失败 → fallback 通知在客户端**不被删除**。
- **TL-02 与 TL-09 不重复**：TL-02 是新共享表 `failureTitle` 已存在但服务端未接（一行接上即可），
  TL-09 是 canary/错误行本来就未本地化（设计取舍或补表）。
- **TL-03 不升级的理由**：上轮已按“先采样 heap 再裁剪”列为方向；本轮只做确定性计数（不测 RSS）。
  最有实际风险的是 `#toolInputs` 保留 write/edit 正文（单次可达 MB 级），`#compactionCommands`/
  `#attempts` 只是少量字符串。建议统一收口。
- **TL-05/TL-06 都是“注释强于实现”的同类**：`parseFrame` 的“非对象帧只是路由不到”与
  `first-token` 的“verbatim port”都属可维护性口径，建议改注释或补断言，而不是改行为。

## 4. 阴性结论（核查通过 / 有意偏差）

1. **timeline.ts 本轮零改动**：`git diff 2f71225..HEAD` 与 `88adebb..HEAD` 均不含
   `timeline.ts`/`frame-reader.ts`/`first-token.ts`/`activity-timeline.ts`/`json-value.ts`，
   新提交没有把改动带进这五个文件；`locale.ts` 只加 `UI.rewind` 表（+14 行，无行为改动）。
2. **工具行状态机**：`tool/call`→`tool/result`、重复 `tool/call` 不重置已完成行、`turn/end`
   （含 `aborted`）取消仍 running 的工具、无终止符日志由 `settleRunningTools` 收尾——`timeline-check`
   208/208 本轮亲跑通过；`image-check` 8/8（图片行 id 可复现、带 `hostPath` 才建行）。
3. **compaction 双态不变量**：完整括号恰好 2 条（loading→completed），summary 画 completed、
   end 被丢弃，只有 end 时画一条 completed，start 后进程死由 `settleLoadingCompactions` 收尾并告警；
   成功 `/compact` 的命令行被 marker 吸收、失败的不吸收——`timeline-check` 段通过。
   **本轮新增核对**：已装 DSH `dsh-compaction-basic/lib/index.js:459-500,630-660` 的
   `compaction/summary` 不带 `turn` 但带 `sourceCommandId`，手动压缩的唯一调用方
   `dsh-command-compact/lib/index.js:55` 必传 `commandId`，auto 的 start/end 带 `turn` 数值——
   因此 `timeline.ts:1296` 的 trigger 判定在 start/summary/end 三态**不会翻转**（上轮未逐字段核）。
4. **attempt 重试 id**：第 1 次 attempt 保留历史 id、后续 `:2`/`:3`，durable `assistant/message`
   落到最新 attempt 的 id 上；桥确实转发 `frame.attemptId`（已装 DSH `dsh-agent-loop/lib/index.js:355-450`
   的 `AssistantStreamAttempt` 帧含 `attemptId`/`turn`/`step`，桥 `dsh-bridge/lib/server.js:747-761` 透传）；
   `assistant-stream-check` 7/7。
5. **撤回缝折叠（本 lane 重点）**：`surface-check` 18/18 亲跑通过——只折本桥 `paseo-rewind` 缝、
   遮蔽 `[startSeq, seamSeq-1]`（含尾随 `step/end`/`turn/end`），compaction 的 replace 不折
   （压缩前对话全部保留），非本桥 `user/message` replace 不折，无法解析的 replace 不动日志。
   与 `AGENTS.md` 三条撤回约束、`docs/FIELD-NOTES.md` 第 48 条一致。
6. **compaction 的 replace 在重放侧也不折**：`dsh-bridge/lib/surface.js:93` 只在
   `isRewindMarker(event)` 时 drop；compaction checkpoint（`compact-checkpoint` source）只更新
   surface 节点。`p003-timeline-check` 8/8 的“real bridge history preserves workflow/goal and replay
   builds the identical snapshots”本轮通过。
7. **新 rewind 提示行的主通道**：`rewind-notice-delivery-check` 30/30 在**真实宿主代码**上通过：
   报告行恰好一次进 daemon timeline store；conversation/both 的报告在宿主派发
   `agent.timeline.replacement`（重建之后、锁释放之前）**之后**才 append；慢宿主（2 s snapshot、
   5 s 重建）仍成立；行不在 provider history 里，后续撤回不会复活；handle 未捕获时排队、捕获后补发；
   canary 仍在 receipt 之前发出；对照实验证明同一 turn 的 `session.notice` 被宿主丢弃而 append 行存活。
8. **plugin 行 identity 与折叠**：宿主 `session.js:6012-6021` 的 `handleAgentTimelineAppendRequest`
   用 `parsePluginClientId(clientId)` **注入 `pluginId`**，identity 为 `${pluginId}/rewind-notice`，
   后一次报告替换前一次而不是堆叠（`timeline-projection.js:96-104` 的 plugin 分支）——
   `rewind-notice-append.ts:39-48` 的注释准确。
9. **文案表与识别**：`rewind-notice-check` 63/63（两 locale 成功句/计数/无数字回退逐字断言、
   live 胶囊只认 live 记录、legacy 通知识别、canary 不被误判）；`shared/rewind-notice.ts` 由
   server/client 共读一张表，服务端 `locale.ts` 与客户端识别无第二份拷贝。
10. **frame-reader 性能与保真**：32/32（20 MB 帧跨 1281 chunk 逐字节还原、随机分块 vs 旧实现
    200 轮 0 mismatch、空行/畸形行/CRLF/尾段滞留语义保持、808× 提速）；本轮探针只补边界口径，
    未发现主路径回归。
11. **locale 解析链**：`locale-check` 269/269（`DSH_PASEO_LANG > LC_ALL > LC_MESSAGES > LANG > en`、
    内建命令/preset/toolLabels/skill 覆盖、未知值透传）；本轮 `DSH_PASEO_LANG=en` 实测
    `LOCALE="en"`、成功文案全英文。
12. **json-value**：本地结构声明与全仓用量一致（`dsh-process.ts:26-27` 再导出），插件内无
    `@getpaseo/protocol` import；无运行时代价，不构成缺陷。

## 5. 未验证项（不是结论，不要当已证缺陷）

1. **真实 daemon / 真机撤回**：本轮未跑 `rewind-native-check.mjs`、`rewind-e2e.mjs`、
   `stream-probe.mjs`（需真实 daemon/模型，耗 token，任务禁止）。append 行在真机 App 上的渲染、
   第二次撤回时行 identity 合并后 React 是否重挂、胶囊是否再弹，均未验证。
2. **R2 撤回后 live builder 不同步**（沿用上轮）：`DshSession.#timeline`（`session.ts:379`）在
   `revert()` 后不重置，`#items`/`#toolNames` 仍留被撤行；若撤回后还有迟到 `tool/result` 命中旧
   callId，插件会把僵尸行发进重建后的时间线。推断，未构造真机时序。
3. **R1 重放收尾与 live 交叠**（沿用上轮）：根会话 replay 末尾无条件 `settleRunningTools()`
   （`session.ts:1201`），与随后 live builder 收到 `tool-workflow/run-end` 的组合会得到
   “workflow X: update without run-start” error 行；可达性依赖“重开时后台 workflow 仍在共享子进程里跑”。
4. **TL-06 ③ 的量级**：桥侧 attempt start 与 DSH `step/start` 的差值未实测（无真实回合），
   只确认了起点不同源。
5. **TL-10 的可达性**：DSH tool-result pruner 是否会把 `todo_write` 的结果重发未验证
   （阈值判断为不可达，但未在真实日志上抽样）。
6. **插件行跨 daemon 重启的持久化**：宿主 `agent-manager.js:2751-2794` 显示
   `historyPrimed = durableTimelineHasRows`，durable timeline store 会保存 append 行；重启后是否
   在时间线里保留旧“已撤回到这条消息”行未跑真机验证（设计上“最多一条、下次撤回重建时清除”）。
7. **degraded 路径的双弹**：replacement 超时后 `verifyAfterTimeout` 会以新 `noticeId` 补发一次
   （`rewind-notice-append.ts:225-246`），客户端 live 监视按 `noticeId` 记录，理论上可能弹两次
   胶囊；仅在超时降级路径，未验证。
8. **真实 `~/.dsh` 会话日志抽样**：本轮未读真实日志（任务只读边界内可读，但时间优先给了代码
   对照与 harness），故 TL-10/首 token 量级都只到源码/合成层。

## 6. 跨 lane 提示

- **client lane**：TL-01 的修复点在 `index.client.tsx:214-218`（legacy 清理的作用域）与
  `rewind-notice-data.ts`；另请核 `client/rewind-notice-live.ts` 的目录观察边界
  （`MAX_WATCHED_AGENTS=16`、30 分钟窗口）与“首次撤回且 agent 很旧”时胶囊可能缺席（行仍在）；
  以及 identity 合并后行组件是否重挂（§5.1）。
- **plugin-provider / rewind lane**：TL-02（`failureTitle` 接表）与 TL-01 的 fallback 文案；
  `RewindReportDelivery` 在 `deliver()` 从未被调用时的订阅释放窗口（构造函数订阅、只有
  `cancel`/`release` 释放）；`#reportFallback` 与客户端 transformer 的契约应写进注释。
- **plugin-process lane**：TL-05 ③——`parseFrame` 的 `null` 会让 `dsh-process.ts:2697` 抛
  `TypeError` 并被记成“dispatching a bridge frame failed”，建议在 `splitFrames`/`#dispatch`
  入口加一次对象校验，让日志回到“malformed line”。
- **harness lane**：需要新增三条断言：① append 失败 → fallback 通知**不被** legacy transformer
  删除；② 英文 locale 下部分失败行标题来自 `UI.rewind.failureTitle`；③ 首 token 与已装 DSH
  `assistantStreamFirstTokenTime` 的差分门（上轮 FT-05 已建议，仍未落地）。
- **bridge lane**：`surface.js` 折叠语义本轮 surface-check 全绿，无需改动；TL-06 ③ 的
  `startedAt`/`firstTextAt` 口径（`dsh-bridge/lib/server.js:769,867`）若与 DSH `step/start`
  对齐，需桥/插件同时改。
- **docs lane**：`docs/REWIND.md` / `docs/FIELD-NOTES.md` 第 79 条把“失败要响亮”作为结论，
  但 TL-01 表明 fallback 在用户可见层不响亮；文档要么补上这个边界，要么等 TL-01 修完再引用。

## 7. 本轮执行记录

| 命令 | 结果 |
|---|---|
| `git rev-parse --short HEAD` | `0c82df5` |
| `git diff --stat 2f71225..HEAD -- <六文件>` | 仅 `locale.ts` +14 |
| `git diff --stat 88adebb..HEAD` | 17 文件 +2952/−34（rewind 提示链 8 文件 +1277） |
| `cd paseo-plugin && npx tsc --noEmit` | exit 0 |
| `node harness/frame-reader-check.mjs` | 32/0，exit 0 |
| `node harness/timeline-check.cjs`（私有编译 `.dbg-tl-audit`） | 208/0，exit 0 |
| `node harness/p003-timeline-check.cjs` | 8/8，exit 0 |
| `node harness/locale-check.cjs` | 269/0，exit 0 |
| `node harness/rewind-notice-check.cjs paseo-plugin/.dbg-tl-full` | 63/63，exit 0 |
| `node harness/rewind-notice-delivery-check.mjs paseo-plugin/.dbg-tl-full` | 30/30，exit 0 |
| `node harness/assistant-stream-check.cjs` | 7/7，exit 0 |
| `node harness/surface-check.mjs` | 18/0，exit 0 |
| `node harness/image-check.cjs` | 8/8，exit 0 |
| `node harness/revert-check.mjs` | 120/0，exit 0 |
| `node harness/session-request-check.cjs` | 52/52，exit 0 |
| `node harness/host-contract-sim.mjs` | 7/7，exit 0 |
| `/tmp/tl-audit/first-token-diff.mjs`（vs 已装 DSH 0.2.1-rc.5） | 5000 streams，0 mismatch，1318 无 token |
| `/tmp/tl-audit/frame-probe.cjs` | 边界/计数/`parseFrame` 6 项断言全成立 |
| `/tmp/tl-audit/timeline-probe.cjs` + `fix-fail.cjs` | subagent_fork/workdir/data.error/未知块/fallback 识别 |
| `/tmp/tl-audit/cache-probe.cjs`（可观测私有字段副本） | 100 回合：items=300、toolInputs=100（1,024,000 字符）、compactionCommands=100 |
| `/tmp/tl-audit/activity-error-probe.cjs` | item.error 为字符串、客户端 `toolCallData.error=""` |

探针与编译产物放在 `/tmp/tl-audit` 与 gitignored 的 `paseo-plugin/.dbg-tl-*`（`.dbg-tl-audit`、
`.dbg-tl-full`、`.dbg-tl-probe`），生产文件零改动；`.dbg-tl-full` 由
`node -e "require('./harness/plugin-build.cjs').buildPlugin({dir:'.dbg-tl-full'})"` 生成（带 build stamp），
`.dbg-tl-probe` 是 `.dbg-tl-full` 中 timeline/activity/locale 的可观测私有字段副本（仅探针用）；`git status` 只有任务书声明的
`V1.txt`/`v1.txt` 与并行 lane 的报告目录。
