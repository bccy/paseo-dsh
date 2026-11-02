# paseo-plugin/server timeline 一组（timeline / frame-reader / first-token / activity-timeline / rewind-canary / json-value / locale）全量审查

- 审查对象：`paseo-plugin/server/timeline.ts`（1400）、`frame-reader.ts`（289）、`first-token.ts`（102）、`activity-timeline.ts`（122）、`rewind-canary.ts`（65）、`json-value.ts`（16）、`locale.ts`（297），共 2291 行；当前 HEAD `2f71225`（main），基线 `9298c28`。
- 审查方式：七个文件全文逐行读审；追调用点 `session.ts`（首 token / 重放收尾）、`provider.ts`（canary 发出顺序/计数）、`dsh-process.ts`（分帧接线）与客户端 `client/locale.ts`/`client/tool-call-data.ts` 的消费面；对照已装 DSH 0.2.1-rc.5 与宿主 `@getpaseo/server` 0.14.0 的真实实现（事件 schema、首 token 算法、`mapTimelineItem`、图片 markdown 规则、compaction 参考适配器）；自写离线探针（编译产物复制到仓库内 gitignored `.dbg-audit-tl`，用完删除）与差分/变异验证。
- 边界：只读；未启动真实 daemon、未跑真实模型回合、未写真实 `~/.dsh` profile；只改本报告。宿主侧行为用**已安装的宿主代码**核对，不能证明正在运行的 daemon 已加载同一份。

## 0. 与基线的差异（先回答“新引入”）

`git log 9298c28..HEAD -- <上述 7 文件>` 为空、`git diff --stat 9298c28..HEAD -- <上述 7 文件>` 为空：**这 7 个文件与上一轮全量审查的基线逐字节相同**。基线以来 8 个提交中与调用点相关的只有 `cedeaf3`（usage）与 `de4ba8c`/`2f71225`（open 事务/撤回快照），我核对了 `provider.ts` 的 canary 段与 `session.ts` 的 `assistant/message`/`#emitStreamStats` 段：`git diff` 未触及这两段。**本报告所有发现均为“基线已有”**，不标新引入；个别点（`#compactionCommands` 从无删除）是基线报告只按“无预算缓存”概括、本轮给出具体位置与实测。

## 1. 结论

这组模块是全仓成熟度最高的一批：TimelineBuilder 的工具行状态机、compaction 双态不变量、attempt 重试后缀、图片行 markdown、canary 发出顺序都写得扎实且有回归（`timeline-check` 208 项、`frame-reader-check` 32 项、`p003-timeline-check` 8 项全绿，本轮亲跑）。**没有发现 P0/P1/P2，无阻断性健康问题**。

主要风险集中在三类：**每会话缓存无生命周期/字节预算**（`#toolInputs` 会一直保留每次工具调用的完整参数，含 write 正文）；**locale 只在 `locale.ts` 覆盖到，通知/canary/错误文案仍中英混排**；**若干“协议字段/工具名映射”保真缺口**（`subagent_fork` 未映射、bash `cwd` 是死字段、失败的结构化 identity 被丢弃、未知 content block 静默丢弃）。另有 4 条只能标“未验证”的边界（见 §2.2）。

## 2. 发现清单

格式：`ID | 严重度 | file:line | 触发条件 | 证据等级 | 新引入 vs 基线已有`

| ID | 严重度 | file:line | 触发条件 | 证据等级 | 新引入 vs 基线已有 |
|---|---|---|---|---|---|
| FT-01 | P3 | `paseo-plugin/server/timeline.ts:726`（`#items`）、`:728`（`#toolInputs`，写入 `:958`/`:1063`，读取 `:1108`，刻意保留见 `:1335-1341`）、`:738`（`#attempts`，写入 `:1021-1028`）、`:790`+`:1293`（`#compactionCommands`，只有 `.has` `:1188`，**全文件无任何 delete**）；`paseo-plugin/server/activity-timeline.ts:31`（`#runs`，成员 Map 也不清除） | 长会话持续增长、无字节/条数上限：实测（instrumented copy，私有字段改名为可读）100 轮 `/compact` → `compactionCommands.size=100`；100 个回合 → `attempts.size=100`；100 次 write（每次 10 KB 正文）→ `toolInputs.size=100` 且**仍保留 1,000,000 字符参数**、`items.size=100`；`turn/end` 只清 `#toolNames`（`timeline.ts:1342`）。一个 24h 会话每次大 write/edit 的参数都留在插件（daemon 子进程）内存里，直到会话销毁 | 实测（探针）+ 源码 | 基线已有（`docs/audits/20261031/server.md:154` 已点出 `#items/#toolInputs/#attempts` 无预算；`#compactionCommands` 的具体“只增不删”为本次新定位） |
| FT-02 | P3 | `paseo-plugin/server/timeline.ts:669-676`（只 `"subagent"`）、对照 `client/tool-call-data.ts:789`、`client/locale.ts:185,416` | DSH 标准预设同时注册两个委派工具：`subagent`（spawn）与 `subagent_fork`（`@deepseek-ai/dsh-web-app/presets/standard.patch.yml:99-103`，`provider: fork`），两者参数定义相同（`@deepseek-ai/dsh-tool-subagent/lib/index.js:390-398` 的 `description`/`prompt`）。插件只把 `subagent` 映射成 `sub_agent` detail，`subagent_fork` 落到 `unknown`：实测 builder 输出 `{"type":"unknown","input":{...},"output":"child finished"}`，而 `subagent` 输出 `{"type":"sub_agent","description":"d","log":"child finished"}`。fork 行因此显示原始 JSON（含完整 `prompt`），而不是 Paseo 的「描述 + 日志」卡 | 实测（builder 探针 + DSH 配置/工具定义） | 基线已有 |
| FT-03 | P3 | `paseo-plugin/server/rewind-canary.ts:56-64`（`title`/`description` 全中文硬编码，无 locale 入参）；`paseo-plugin/server/provider.ts:955-962`（canary 直接用它）、`:967-975`（`"文件回退未完成"` 通知同样硬编码中文）；`paseo-plugin/server/timeline.ts:1138`（`"tool failed"`）、`:1351`（`"The turn failed."`）、`paseo-plugin/server/activity-timeline.ts:83`（`"Workflow ended with error"`） | `DSH_PASEO_LANG=en` / 非中文 LANG 时，服务端 UI 文案（`locale.ts` 的 modes/settings/planCard/toolLabels/commands）走英文，但撤回提示、文件回退失败通知、workflow 失败行的错误文案仍是中文/英文混排；反向（zh 环境）workflow/goal 错误行是英文。实测：`rewindCanaryNotice` 无 locale 参数，`title="撤回已生效"` 恒定；DSH 的 `session.notice` 在宿主被原样拼成 `title\ndescription`（`@getpaseo/server/dist/server/server/agent/plugin-provider.js:1229-1237`），没有二次本地化 | 实测（源码 + 纯函数） | 基线已有（`docs/audits/20261031/server.md:158` 已记“P003 审批文案和 canary 的 locale 仍不完全统一”；本轮补点 timeline/activity 的英文错误文案） |
| FT-04 | P3 | `paseo-plugin/server/frame-reader.ts:186-199`（完成行直接 `lines.push`）vs `:202-213`（只有“最后一个换行之后的尾巴”检查上限） | 上限只在**未终止帧的尾段**检查：若某个超长帧的终止符与把它推过上限的字节落在同一个 chunk，循环先按换行完成该行并返回，`maxPendingBytes` 检查根本不会跑。实测（limit=6）：`push("aaaa")` 后 `push("bbbbbb\n")` → 10 字符行照常交付、`onOverflow` 0 次。生产路径单个 chunk 受内核/流缓冲限制（16–64 KB），所以内存上界只多一个 chunk（不构成 OOM），但文档“past the limit the frame is discarded whole”并非字面成立。另 `:206-212` 的 `dropped` 只报触发前的累计字节，`discarding` 期间丢掉的字节不计：实测 limit=4，`push("12345")` 报 `dropped:5`，实际丢弃 8 字节 | 实测（探针 `frame-reader-check` 之外自写用例）+ 源码 | 基线已有（基线 `server.md:157` 只指出“256 MiB 不是总内存预算”，未点出终止符路径与计数口径） |
| FT-05 | P3 | `paseo-plugin/server/first-token.ts:9-21`（自称 verbatim port）、`:55-63`（`dt[index-1] ?? 0` 与 DSH 的 `dt[index-1]` 不同）、`:71-73`（`isRecord` 排除数组，与 `timeline.ts:35` 同名函数语义不同）；调用点 `paseo-plugin/server/session.ts:2304-2320` | 首 token/吞吐的算法是从 DSH 私有实现手工移植的（无运行时依赖），而仓库**没有任何断言钉住它与 DSH 一致**（`grep harness` 只有 `plugin-check` 断言“出现一行合理数值”）；DSH 升级改了 `isTokenDelta`/`runFirstTokenTime`/compact record 形状时不会红，只会在真机上悄悄改变 `firstTokenMs`/`tokensPerSecond`。本轮差分实测（5000 条随机合法 stream，对照已装 0.2.1-rc.5 的 `assistantStreamFirstTokenTime`）：**0 不一致**（1012 条无 token），当前移植 faithful；差异只在畸形输入（DSH 对 `dt` 缺项会得 NaN、对缺失字段会抛，移植版更防御），所以“verbatim”措辞偏强。另一处口径差：durable stream 缺失时回退到桥的 live 快照（`dsh-bridge/lib/server.js` 的 `firstTextAt` 只统计 `text-delta`），与 durable 的“text+reasoning+tool-call 都算 token”不是同一口径（`session.ts:2314`），只在旧桥/无 stream 时生效 | 实测（差分 5000/5000）+ 源码 | 基线已有（`server.md:156` 已建议“加与受支持 DSH 版的行为差分检查”） |
| FT-06 | P3 | `paseo-plugin/server/timeline.ts:594`（bash 读 `input.cwd`）、`:1070-1143`（失败只取 `message.content`/兜底 `"tool failed"`）、`:50-56`+`:136-151`（`textOf`/`imageRows` 之外的 content block 静默丢弃） | 三个小保真缺口：① DSH bash 的模型参数是 **`workdir`**（`@deepseek-ai/dsh-tool-bash/lib/index.js:510`；Paseo 形状的 `cwd` 是 `presentBashCall` 自己算的，`:260-261`），插件读 `cwd` 永不命中 → Paseo `shell.cwd` 字段永远为空（`@getpaseo/plugin/.../provider.d.ts:397-402`）。当前客户端不读 `detail.cwd`（`client/tool-call-data.ts` grep 无 `cwd`），故今日无可见影响，属“死字段”。② `tool/result` 的 `data.error`（`{name,code,reason?}`，`@deepseek-ai/dsh-session/lib/types/types.d.ts:375-391`）未被使用；失败原因只取渲染文本，文本为空时行只剩 `"tool failed"`（agent-loop 正常会填文本，故影响面 推断/未验证）。③ DSH 的 `ContentBlockMap` 是 merge-extensible（`@deepseek-ai/dsh-llm/lib/types/types.d.ts:117-126`）；assistant/tool 结果里出现 text/image 以外的块时被静默丢掉，不建行也不告警——与同一文件 `activity-timeline` 的“失败要响亮”（`timeline.ts:811-815` 把异常转 error 行）取向不一致 | 实测（源码 + DSH d.ts）+ 影响面 推断 | 基线已有 |
| FT-07 | P3 | `paseo-plugin/server/timeline.ts:1123-1127`（每次 `todo_write` 的 `tool/result` 都发 `todo` 行）；宿主 `@getpaseo/server/dist/server/server/agent/plugin-provider.js:1460-1521`（`mapTimelineItem` 把非消息项的 `id` 剥掉）与 `paseo-plugin/node_modules/@getpaseo/protocol/dist/timeline-identity.js:1-7`（只有 `tool_call`/`plugin` 有 identity） | 宿主对 `todo`/`error`/`compaction` 这类“无 identity”行是**追加**语义，插件无法再更新同一行。若同一个 `todo_write` 的 `tool/result` 被投递两次，会出现两条 TODO 行且无法撤回：DSH 的 tool-result pruner 会对超预算的旧 tool/result 追加一个 surface-replace 变体（`@deepseek-ai/dsh-compaction-tool-result-pruner/lib/index.js:155-185`），桥把每个 `session/event` 都原样转发；todo 结果通常很小、达不到 pruner 的字符阈值，故**可达性未验证**。同类 `error` 行（`timeline.ts:1353`）也是追加语义，但桥不重复投递 `turn/end`，未发现可达路径 | 实测（宿主/协议代码）+ 可达性 未验证 | 基线已有 |

### 2.1 重点说明

- **FT-01 不升级的理由**：基线已把这一类列为“先采样 heap 再裁剪”的方向；本轮只做确定性计数（不测 RSS）。最有实际风险的是 `#toolInputs` 保留 write/edit 正文（单次可达 MB 级），而 `#compactionCommands`/`#attempts` 只是少量字符串。建议按“会话级预算 + 完成即可弃”统一收口，而不是只修一个 map。
- **FT-02 的修法**：`toolDetail` 的 `case "subagent"` 改为 `case "subagent": case "subagent_fork":` 即可（参数 schema 相同，`description`+`log` 都可得），客户端标签/图标已就绪；风险为零，属于“能力声明要与数据源一致”的同类问题。
- **FT-03 的修法**：`rewindCanaryNotice` 增加 `locale`/或从 `locale.ts` 取文案；`timeline.ts`/`activity-timeline.ts` 的英文错误文案要么走中英表，要么在注释里明确“错误文案只给 `paseo plugin logs`，不承诺本地化”，别让 `DSH_PASEO_LANG` 只覆盖一半。
- **FT-04 的修法**：在“完成行”处也检查 `maxPendingBytes`（超限则丢弃并 `onOverflow`，同时跳过该行），或把上限判定改为“每次 push 后总量校验”；`dropped` 语义改成“本帧累计丢弃字节”（把 `discarding` 期间跳过的字节也加上）。
- **FT-05 的修法**：新增一个纯离线差分脚本（在已装 DSH 里 require `assistantStreamFirstTokenTime`，喂固定/随机合法 stream 逐值比较），挂到 `dsh-api-contract-check` 同类清单；并把 `?? 0`/`isRecord` 差异注释成“有意增强，不是逐字等价”。
- **FT-07 不升级的理由**：宿主追加语义与插件“重复播报同一结果”的组合才是缺陷形状；pruner 的阈值让 todo 结果基本进不去，需真实会话证据才升级。

### 2.2 未验证 / 残余风险（不是结论，不要当已证缺陷）

1. **R1 重放收尾与 live 交叠**：根会话 replay 在末尾无条件 `settleRunningTools()`（`session.ts:1103`；`timeline.ts:855-860` 同时把未结束的 workflow run 标 `canceled`，`activity-timeline.ts:64-74`）。探针实测“replay builder 标 canceled + 新 live builder 收到 `tool-workflow/run-end`”会得到一条用户可见的 error 行（`workflow X: update without run-start`）。可达性未验证：正常情况下 Paseo close 会先走桥的 `closeSession`（`dsh-bridge/lib/server.js:3104` 起 dispose 并等 idle），replay 读到的是已闭合日志；要命中得“重开时后台 workflow 仍在共享子进程里跑”。p003 已断言“dead replay settle 为 canceled”与“turn/end 不取消 workflow”，但没有这个跨 builder 形状。
2. **R2 撤回后 live builder 不同步**：撤回不改 `DshSession.#timeline`（`session.ts:368` 构造一次，`revert` 路径 `:749-753` 不重置），而打过补丁的宿主会截断时间线；之后若有迟到 `tool/result` 命中已撤行的 callId，插件会重新播报一条“僵尸行”。推断，未构造真机时序。
3. **R3 纯文本会话不 adopt 服务端 locale**：locale 只搭在 `tool_call` 行的 `metadata` 上（`timeline.ts:533-543`），客户端在工具行 transformer 里才 `setLocale`（`index.client.tsx:68`）；一条只有文本/思考的会话拿不到 hint，客户端退回默认 `zh-CN`。client locale 文档已自认这是已知限制。
4. **R4 callId 会话内复用**：若某 provider 在会话内复用 callId，新 `tool/call` 会被“已完成行不重置”（`timeline.ts:1376-1399`）丢弃，其 result 覆写旧行；宿主本身按 `callId` 折叠（`timeline-identity.js`），故与宿主语义一致，不计缺陷。FIELD-NOTES #60 的重复证据是跨会话/fork 复制，不是会话内。

## 3. 核查通过 / 有意偏差（不作为缺陷）

1. **工具行状态机**：`tool/call`→`tool/result`、重复 `tool/call` 不重置已完成行、`turn/end`（含 `aborted`）取消仍 running 的工具、无终止符日志由 `settleRunningTools` 收尾——`harness/timeline-check.cjs` 208/208 通过；自写探针补测了“running 中重复 call 取最新参数仍为 running”“完成后重复 call 不重置”“空失败文本兜底”“result 在 turn/end 之后会把 canceled 翻回 completed”（后者在合法日志序里不可达，仅记录语义）。
2. **attempt 重试 id**：第 1 次 attempt 保留历史 id、后续 `:2`/`:3`，durable `assistant/message` 落到最新 attempt 的 id 上，无 attempt 字段时行为与旧版一致；桥侧确实传 `frame.attemptId`（`dsh-bridge/lib/server.js:628-642`），字段名与插件一致（实测探针）。
3. **compaction 双态不变量**：完整括号恰好 2 条（loading→completed），summary 画 completed、end 被丢弃，只有 end 时画一条 completed，start 后进程死由 settle 收尾并告警；成功 `/compact` 的命令行被 marker 吸收、失败的不吸收——`timeline-check` 段通过与宿主参考适配器一致（宿主 codex 适配器同样 loading/completed 两条：`.../providers/codex-app-server-agent.js:5010-5027`）。
4. **图片行**：只有带 `hostPath` 的 image block 才建行、id 由 callId+位置决定（重放去重可复现）；markdown 的 alt/source 转义与宿主逐字一致（对照 `@getpaseo/server/dist/.../providers/provider-image-output.js:161-186` 的 `escapeMarkdownImageAlt`/`encodeFilePath`/`windowsFileUri`/`markdownImageSource`/`escapeMarkdownImageSource`）。
5. **协议边界**：所有产出 shape 经真实 `ProviderEventSchema.parse` 验证（`timeline-check` 末段）；`detail.meta` 会被 schema 剥掉、`metadata.presentationMeta` 能存活——这一点用真实 schema 断言过，不是注释承诺；`locale` 搭在每个 tool_call 行的 `metadata` 上（命令行 `:1205`、工具行 `:539-541`）。
6. **activity-timeline 的 DSH 契约**：`tool-workflow` 的 `outcome`/`stopReason` 允许集与已装 DSH 完全一致（`@deepseek-ai/dsh-workflow/lib/types/types.d.ts:55,98`）；`goal/change` 的 `version:1`、operation/phase/`blockedReason.message`/`cleared.id` 与 `@deepseek-ai/dsh-goal/lib/types/domain.d.ts:12-70`、`types.d.ts:38-70` 一致；重复 start 不抹进度、终态不被回退、非法事件转可见 error 行并 `#warn`（实测 `p003-timeline-check.cjs` 8/8，本轮亲跑）。
7. **canary 机制**：`provider.ts:955-962` 在 `request.completed`（`:962`）**之前**发，`scope: "files"` 不发、`both` 文案点出文件；序号 `#rewindSeq`（`:423`、`:954` 递增）保证同秒多次撤回文案不同；文案拼接与宿主 `translateNotice` 的 `[title, description].filter(Boolean).join("\n")` 等价（宿主 `plugin-provider.js:1229-1237`）。顺序/作用域/`#2` 由 `harness/session-request-check.cjs` 断言、宿主截断行为由 `harness/host-contract-sim.mjs` 断言；本轮**未执行**这两个脚本（需先手工编译插件/宿主解包，属 task-16/20 覆盖），只做代码对照。
8. **locale**：解析链 `DSH_PASEO_LANG > LC_ALL > LC_MESSAGES > LANG > en` 纯函数实测（显式覆盖、空串跳过、zh 前缀、POSIX 回落、`presetLabel` 优先 reported 名、未知 command/effort 原样透传）；覆盖面对齐已装 DSH：内建命令 5/5（`goal/compact/feedback/permission/plan`，与已装包注册名逐一核对）、preset 4/4 中文名与 DSH 自身一致（`dsh-client-ui-agent-preset/lib/client.js:949`）、两个 `toolLabels` 与 DSH 中英文表逐字相同（`dsh-client-ui-conversation/lib/client.js:16155,16357,16532,16734`）、Paseo 6 个 skill 全覆盖；`isRecord` 是否含数组在四份拷贝里不一致（FT-05 已记）。
9. **frame-reader**：`harness/frame-reader-check.mjs` 32/32 通过（20 MB 帧跨数千 16 KB chunk 逐字节还原、单 chunk 多帧、跨 chunk 重组、空行跳过/畸形行上报后继续、CRLF 保留 `\r`、尾部残行滞留、旧实现随机分块 oracle、性能旧 6017 ms vs 新 7 ms ≈905×）。
10. **json-value**：本地结构声明与全仓用量一致（`dsh-process.ts:26-27` 再导出、`session.ts:24` 经它引用）；插件内无任何 `@getpaseo/protocol` import（grep 全仓），历史安装失败原因已不适用但保留声明无运行时代价——不构成缺陷。
11. **first-token 当前一致性**：与已装 DSH 0.2.1-rc.5 的 `assistantStreamFirstTokenTime` 差分 5000 条随机合法 stream 全等（见 FT-05）。

## 4. 测试覆盖缺口（针对本组模块）

- **首 token 无差分门**（FT-05）：建议加纯离线脚本，require 已装 `@deepseek-ai/dsh-llm` 的 `assistantStreamFirstTokenTime` 与编译后的 `first-token.js` 逐值比较；`dsh-api-contract-check` 只查符号存在，查不出这种算法漂移。
- **frame-reader 上限只在“尾段”路径有断言**（FT-04）：现有溢出用例是“push 一直不带换行”，补一个“终止符落在越限 chunk”与“跳过段的 dropped 计数”用例。
- **`subagent_fork` 无服务端断言**（FT-02）：`locale-check` 只断言客户端标签、`tool-call-check` 断言图标；建议在 `timeline-check` 加 `subagent_fork → sub_agent` 用例。
- **activity-timeline 有间接覆盖但未登记**：`harness/p003-timeline-check.cjs` 通过真实 `TimelineBuilder` 覆盖 workflow/goal 8 项（本轮实跑通过），但该脚本不在 `AGENTS.md` 的 harness 清单里、也没进 CI；`docs/audits/20261102/health-crosscut.md` 的 HC-13 把它列为“无 harness 引用的生产模块”，就 activity-timeline 而言**不成立**（间接用例存在），缺口是该脚本的登记与 CI 接线，建议由 harness/docs lane 收口。
- **跨 builder 边界无覆盖**（R1）：replay settle 与随后 live workflow 终态的组合。
- **用户可见通知的 locale 无覆盖**（FT-03）：`locale-check` 只覆盖表与解析链，不覆盖 canary/notice 文案语言。

## 5. 健康度评分

| 维度 | 分数 | 理由 |
|---|---|---|
| 正确性 | 4 | 工具状态机/compaction/attempt 三类险区都有强回归且本轮实测成立；剩余是语义边界（late result、重放收尾）与映射缺口，未见会坏主流程的错误 |
| 健壮性 | 4 | 分帧线性化 + 未终止帧上限 + 畸形行不吞后续；activity 异常转可见 error 行；但上限有一处口径漏洞、每会话缓存无预算 |
| 可维护性 | 4 | 注释质量高、状态机不变量写清；但注释密度过大且个别承诺强于实现（“past the limit 整帧丢弃”“verbatim port”、`isRecord` 语义分叉），四个模块各带一份 `isRecord` |
| 契约一致性 | 4 | 产出全部过真实 `ProviderEventSchema`、`metadata.presentationMeta` 与 `locale` 中继都验证过；缺口是 `subagent_fork` 映射、`shell.cwd` 死字段、失败 identity 丢弃、无 identity 行的追加语义 |
| 性能 | 4 | 分帧 905× 提升且逐字节保真；单帧有上限；扣分项是会话级缓存/输入长期驻留无预算 |
| 安全 | 4 | 分帧内存有界、图片 markdown 按宿主规则转义、JSON 值边界不伪造；未发现注入/越权面；日志会带畸形帧原文（会话内容）属轻微面 |
| 测试覆盖 | 4 | 本组模块的回归密度全仓最高（208+32+8 项、含真实 schema 与旧实现 oracle、变异自证 6 红）；扣分项是首 token 差分、上限边缘、fork 映射、跨 builder 边界 |

**一句总评**：这组模块整体健康，无阻断性健康问题（P0/P1/P2 均为 0）；建议优先补上 `subagent_fork` 映射与 canary/notice 的 locale（各一两行、零风险），随后按“会话级预算”统一收口无界缓存，最后把首 token 差分与 frame-reader 上限边缘补进离线回归。

**Top 问题（≤5）**：① FT-01 每会话缓存无生命周期预算（`#toolInputs` 尤其）；② FT-03 canary/失败通知/错误文案未随 locale 走；③ FT-02 `subagent_fork` 未映射 `sub_agent`；④ FT-05 首 token 移植无差分门（当前实测一致，风险在未来漂移）；⑤ FT-04 分帧上限口径与溢出计数。

**建议优先级**：FT-02、FT-03（低风险、用户可见）→ FT-05、FT-04（测试/健壮性，各一个小用例）→ FT-01（先测量再裁剪，不要只改一个 map）→ FT-06/FT-07（按需，先确认真机触发）。

**是否有阻断性健康问题**：**否**。

## 6. 本轮执行记录

| 命令 | 结果 |
|---|---|
| `git rev-parse --short HEAD` / `git log 9298c28..HEAD -- <7 文件>` / `git diff --stat` | HEAD `2f71225`；7 文件无提交、无 diff |
| `cd paseo-plugin && npx tsc --noEmit` | exit 0 |
| `node harness/frame-reader-check.mjs` | 32 passed, 0 failed |
| `harness/timeline-check.cjs`（按脚本头注释编译到 private `.dbg-audit-tl`） | 208 passed, 0 failed |
| `node harness/p003-timeline-check.cjs` | 8 passed, exit 0（构建产物落 gitignored `.dbg-p003-timeline`） |
| 自写探针 `probe.cjs`（instrumented copy 测缓存/状态机/activity/frame/locale） | 46 passed, 0 failed |
| 自写差分 `first-token-diff.cjs`（vs 已装 DSH 0.2.1-rc.5） | 5000 streams, 0 mismatch, 1012 无 token |
| 变异自证（timeline.js 把 `cancelRunningTools` 的 `canceled` 改 `completed`） | timeline-check 由 208/0 变 202/6；还原后 sha256 一致、208/0 复绿 |

探针与编译产物均放在 gitignored 的 `paseo-plugin/.dbg-audit-tl`，结束后已删除；生产文件零改动。

**未执行**：`harness/session-request-check.cjs`（canary 顺序/作用域，需手工编译插件）、`harness/host-contract-sim.mjs`（宿主截断行为，需解包宿主并配 `node_modules` 包装目录）——两者属 task-16/20 覆盖，本报告只做代码对照；未跑真实 daemon/真机撤回。
