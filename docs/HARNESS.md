# harness 离线检查清单

从 [AGENTS.md](../AGENTS.md)「改完怎么验证」拆出来的逐脚本说明：每个检查断言什么、**动了哪里必跑**。
拆出去是因为 AGENTS.md 会作为工作区指令整份注入 DSH 会话，而 DSH 的工作区指令总预算是 64 KiB，
超出时会整份丢弃更外层的 `~/.dsh/AGENTS.md`（FIELD-NOTES 第 77 条）。往这里加条目不占那份预算。

还有一组**离线**脚本，直接 require 编译产物、不需要 daemon（运行步骤写在各自头部注释里）。
下面清单里穿插的 `subagent-check.cjs` 归档用例与 `archive-registry-check.mjs` **不属于这组**：
前者是假 `dsh` 驱动的，后者要真 profile。

- `harness/timeline-check.cjs` — `TimelineBuilder` 的工具行状态机：`tool/call` → `tool/result`、
  重复 `tool/call` 不能把完成行重置回 running 或清空输出、`turn/end`（含 `aborted`）要把仍
  running 的工具收成 `canceled`。**动了 `server/timeline.ts` 必跑。**
- `harness/p003-timeline-check.cjs` — 真实 `TimelineBuilder` → `ProviderEventSchema` → 客户端
  渲染数据的端到端：`goal/change`（目标行）与 `tool-workflow/*`（工作流/成员行）的完整快照、
  重复 start 不抹进度、run-end 的终态口径、后台工作流跨回合保持 running、死重放按 canceled
  收尾。**动了 `server/activity-timeline.ts`、`server/timeline.ts` 的 activity 分支或
  `client/tool-call-data.ts` 的 workflow/goal 映射必跑。**
- `harness/newest-check.cjs` — `client/newest.ts` 的"哪一行是最新、该不该脉冲"：位置判定、
  提交批次（回放历史不闪）、窗口、交接、时钟。**动了客户端脉冲条件必跑。**
- `harness/tool-call-check.cjs` — `client/tool-call-data.ts` 的工具行映射（图标、命令、diff、
  截断、失败原因、终端卡）。**动了工具行渲染必跑（含失败原因与终端卡：错误只认顶层
  `item.error.message`，终端正文全量 + 224px 纵向滚动 + 复制）。**
- `harness/thinking-check.cjs` — 思考行折叠预览：结束后取**第一行**、运行中取最后一个首行已终结
  的段落（都是 DSH 的行为，逐字移植在 `client/thinking-text.ts`），以及折叠行在流式中的宽度
  接线（行测自己的宽度、标签测自己要减掉的那段、行宽由两者相减得出，`useRevealedText` 不许
  再接管文本节奏）。**它不断言行标题**：标题恒为 `思考` 是 `client/locale.ts` 标签表里的一个键，
  由 `harness/locale-check.cjs` 的整表遍历覆盖——改坏了标题，这个脚本不会红。
  **动了思考行显示必跑。** 运行步骤现在需要同时编译 `client/inline-thinking.tsx`
  （`--jsx react-jsx --noCheck`），见文件头。
- `harness/subagent-check.cjs` 里另有归档用例：假桥的 replay 列表带一条 `archived: true` 的
  子会话，断言它**不被重放播报**（归档重启后必须仍然成立）；还断言归档往返本身——有打开的
  会话时代为转发、**没有**打开的会话时经一次性 probe 仍能往返、以及 registry 拒绝的 id 必须
  `request.failed`。**动了 `dsh-bridge/`、`replaySubagents()` 或 provider 的归档分支必跑。**
  但假桥证明不了"真实 profile 里到底有没有 `workspaceRegistry`"：改过桥的 bundle patch 或
  桥入口后，一定要在真 `dsh --profile paseo` 上跑一次 `harness/archive-registry-check.mjs`
  ——它把 `paseo/archive` 作为**第一帧**发（不发 `initialize`，和插件的一次性 probe 同形状），
  断言请求到达了真 registry。`@deepseek-ai/dsh-workspace` 只在 web bundle 里，缺了就是
  "composes no workspace registry"；桥入口漏等 profile 装载时则是**不发 initialize 就必现**。
- `harness/archived-lineage-check.mjs` — 纯模块离线检查（无需 profile/daemon）：桥里的
  `dsh-bridge/lib/archived-lineage.js` 必须逐字等价于 DSH 的 `underArchivedSession`——自身
  或任一 `origin:"subagent"` 祖先在 `archivedSessionIds` 即算已归档，fork 不继承、环路要终止。
  **动了这个模块、`listSessions` 的归档过滤或 `paseo/subagents` 的 `archived` 判定必跑。**
- `harness/image-host-path-check.mjs` — 纯模块离线检查（无需 profile/daemon）：桥里的
  `dsh-bridge/lib/image-host-path.js` 给 `tool/result` 的每个图片块**追加** `hostPath`，原有
  字段一个不动；attachments 缺失、`imageHostPath` 抛错（无效 ref 抛 `AttachmentError`）、
  返回非字符串、或事件不是 `tool/result` → **原样返回**。`historyEvents` 把同一规则用在
  `history()` 的重放投影上（`{type, seq?, time?, data}`）。**动了这个模块、桥的三处注入点或
  `history()` 的事件投影必跑。**
- `harness/sweep-check.cjs` — 原生扫光的几何：mask 曲线的停点、阶梯 alpha 的对称性与平铺、
  1.5s/0.3s/2-3 行程、`steps(48)`。**动了 `client/sweep-*.ts` 必跑。** iOS 上跑不了，这些
  数字就是"与 DSH 一致"的唯一凭据。
- `harness/style-check.cjs` — `client/tokens.ts` 的共享样式常量表（Phase 1 把工具行每个数值
  收进这里；13 还是 14、2×2 方块还是圆点、8% 还是 20% 底纹，漂移了在截图里都照样渲染，
  所以断言表本身，React 组件刻意不断言）。**动了 `client/tokens.ts` 或行样式必跑。**
- `harness/locale-check.cjs` — 客户端显示 locale 的纯函数解析链（`DSH_PASEO_LANG` 与
  `LANG`/`LC_ALL` 的优先级）和标签表覆盖：每个工具名在**两种语言**下都要有值，英文列是
  中文列的复制也要抓出来。**动了 `client/locale.ts` 或标签表必跑。**
- `harness/jobs-poll-check.cjs` — jobs 轮询状态机（从 JSX 抽到 `client/jobs-polling.ts`，假时钟 +
  假 RPC + 假目录页，不 import React/host）：可见性（有 live 显示 live 数、仅 settled 显示总数、
  0 job 隐藏）、三个间隔（可见 4s / 隐藏 15s / 失败指数退避 8→16→30s）与抖动、首屏 `pageInfo`
  分页与过期页丢弃、终态错误码停轮询。**动了 `client/jobs-pill.tsx` / `client/jobs-polling.ts` /
  `client/locale.ts` 的 jobs 表 / `shared/jobs.ts` 必跑；`jobs-poll.tsconfig.json` 是它的编译配置。**
- `harness/jobs-popover-check.cjs` — jobs popover 的几何、状态标记、JSX 接线与宿主主题数据；
  `HOST_APP` 指 Paseo checkout，没有就会跑完但 exit 2。**同上触发条件必跑（需 `HOST_APP`），
  跑法见文件头注释。**
- `harness/replay-turn-check.cjs` — 重放历史的回合标识：`replayHistory()` 必须把 DSH 日志里的
  `turn/start`…`turn/end` 括号翻译成成对的 `session.turn`（started 在前、行在中间、终态在后），
  否则 Paseo 的 `currentTurnId` 在重放期间恒为 null，重开出来的每一行都没有 `turnId`，
  客户端退回「每条 user_message 起一个回合」，被拆块的提问就永远折不起来。断言：两个回合
  各被 started…终态闭合、4 条行全部落在区间内、两回合 turnId 不同、同一回合的 user 与
  assistant 行归属同一个 turnId、turnId 稳定派生自 DSH 回合号（重开可复现）。用假桥驱动
  编译后的真实 `DshSession.replayHistory()`，并逐字复刻 Paseo 的 `translateTurn`/
  `translateTimeline` 规则，所以断言打在协议层而不是界面。**动了 `server/session.ts` 的
  重放路径或 `session.turn` 的发出时机必跑。**
- `harness/context-usage-check.cjs` — 用编译后的真实 `DshSession`、只替换进程传输，断言
  上下文占用的上报边界（打开会话上报已用量与容量、回合内合并更新、压缩后下降、未知容量
  清除旧值、无效计数拒绝、切模型时迟到的旧响应不能覆盖、关闭后不再发）。参数是编译输出
  目录：`node harness/context-usage-check.cjs <dir>`。**动了 `server/dsh-process.ts` 的用量
  读取或 `DshSession` 的用量上报必跑。**
- `harness/catalog-cache-check.mjs` — catalog 缓存按 cwd 的小 LRU（不是单槽）：多工作区
  A→B→A 只起 2 个 probe（旧实现 3 个），每个 cwd 命中各自条目。**动了 `provider.ts` 的
  `loadCatalog` / catalog 缓存 / TTL 必跑。**
- `harness/open-degrade-check.mjs` — open 期降级必须用户可见：`paseo/history` 抛错、preset
  被拒、plan 对账失败（plan 模式）都要发 `session.notice`/warning，而不是只写 stderr；
  子代理枚举失败也点名。**动了 `session.ts` 的 `replayHistory`/open 降级通知、`provider.ts`
  的 `openWarnings`/preset 校验，或 `fake-dsh-bridge.mjs` 的 `history-error`/`preset-reject`/
  `plan-error` 场景必跑。**
- `harness/agent-message-check.cjs` — Paseo 0.12 的 `agent_message` 行：`agentMessage` 字段
  取用、英文标签对齐官方 display model、缺 `agentMessage` 时**交还宿主原生渲染**。
  **动了 `client/tool-call-data.ts` 的 `agent_message` 分支或 `index.client.tsx` 的
  transformer 必跑。**
- `harness/uploaded-file-check.cjs` — 附件块翻译与官方 `renderPromptAttachmentAsText` 逐字
  一致；text/image 形状不变、未知类型抛错。**动了 `server/session.ts` 的 `toDshContent` 必跑。**
- `harness/paseo-system-envelope-check.mjs` — 桥的 `<paseo-system>` 信封翻译（无属性/版本化
  两形、system 消息保持 user turn、非字符串拒绝）。**动了
  `dsh-bridge/lib/paseo-system-envelope.js` 必跑。**
- `harness/mcp-http-check.mjs` — 桥的 MCP streamable-HTTP 客户端（SSE/JSON、session id 有无、
  JSON-RPC 错误、取消路径），本地 loopback，不需要外部服务。**动了 `dsh-bridge/lib/mcp-http.js` 必跑。**
- `harness/mcp-stdio-check.mjs` — 桥的 MCP stdio 客户端（`dsh-bridge/lib/mcp-stdio.js`）：
  握手顺序（`initialize` 先于 `tools/list`、`notifications/initialized` 发出）、`tools/list`
  缓存与 `refresh`、`tools/call` 的参数、JSON-RPC error 变 reject、**stdout 混入非 JSON 行
  不能炸**（Playwright MCP 会往 stdout 打日志）、超时生效、子进程退出时在途请求被 reject
  且**后续调用立即失败**（不悬挂、不重启死进程）、`dispose` 收得掉子进程。用一个临时 .mjs
  假 server 驱动，纯离线。**动了
  `dsh-bridge/lib/mcp-stdio.js`（含取消路径）或 gateway 的 stdio 分支必跑。**
- `harness/mcp-gateway-transport-check.mjs` — gateway 的传输判定（`transportOf`）与配置
  校验：`url` → HTTP、`command` → stdio，而**两者都给、都不给、给空串、拼错键名都必须
  报错点名**。`Schema.union` 是合并式匹配、**不排他**（同时给 `url` 和 `command` 会通过
  校验并保留多余键），所以排他判据只能在 `transportOf` 里，这个脚本钉住它。纯离线，
  依赖从 DSH 安装目录按绝对路径加载（`DSH_PACKAGES_DIR` 可覆盖）。**动了 `transportOf`、
  gateway 的 `Config` 或 `clientFor` 的传输分派必跑。**
- `harness/dsh-api-contract-check.mjs` — 桥依赖的 **DSH 内部 API** 还在不在（纯离线、秒级，
  不起进程、不耗 token）。桥不是 ACP 适配器，它直接 import 八个 DSH 内部组装包
  （`dsh-llm` / `dsh-agent` / `dsh-attachment` / `dsh-brand` / `dsh-cmdline` / `dsh-tools` /
  `dsh-subprocess` / `schemastery`），这些包**没有 API 稳定性承诺**。脚本断言两件事：
  **覆盖率**（桥源码里每个 `@deepseek-ai/*` import 都必须在 `EXPECTED` 清单里，且清单里没有
  桥已不用的条目——**双向**，所以新增依赖漏登记、删了 import 留下死清单都会红）和**存在性**
  （13 个符号仍被导出、类型没变）。它查的是 FIELD-NOTES #58 那种失效：`{{cwd}}` 变量被上游
  删掉，每个回合都在提示词装配阶段抛错，界面只有一条空的 `[error]`，而 **doctor 全程是绿的**
  （doctor 只查安装完整性，查不出软契约）。**它不查行为**——签名变了但符号还在，这里不会红，
  那由 `plugin-check.cjs` 的真实回合覆盖。**它也只覆盖 import 符号，不覆盖实例方法**（如
  live agent 的 `runMaintenance`，类未导出）；升级时这里不会红，别当完整门。两个都跑才算数。
  **DSH 升版后必跑、优先于其它一切**：它最快、且失败信息直接点名哪个包的哪个符号没了。
  `DSH_PACKAGES_DIR` 可覆盖安装目录。
- `harness/bridge-assets-check.mjs` — `server/bridge-assets.ts` 必须与 `dsh-bridge/` 和
  `templates/` 逐字节一致（只读，不起进程）。**改桥后先跑它、再跑任何插件级脚本。**
- `harness/bootstrap-check.mjs` — 桥安装/替换的 verify-before-switch：暂存目录逐文件写后
  **回读 size + SHA-256** 校验、失败不发布、旧代际保留、失败日志必须明确 NOT ready（不能把
  "没装成"说成 "profile ready"）。**动了 `paseo-plugin/server/bootstrap.ts` 的桥安装/替换、
  `index.server.ts` 的 provisioning 日志、或 `bridge-assets.ts` 的 `BRIDGE_FILES` 结构必跑。**
- `harness/doctor-check.mjs` — `paseo-plugin/lib/doctor.mjs` 的判定，驱动真实的 `runDoctor()`
  跑在沙箱 `DSH_HOME` 上：空 provider/model、缺 default-model、YAML 错、无值凭据、`refs:` 外
  凭据都必须 fail，完整配置仍通过（负向用例的对照）；桥缺 lazy 加载模块必须 fail 并**点名缺的
  那个模块**（以前只查 `lib/index.js` 一个入口，残缺桥照样报 provisioned、exit 0），完整桥仍
  报 provisioned（这一条是前一条的对照，防止"只会 fail"的检查也算通过）；`bridge-assets.ts`
  取不出键清单时必须 **fail 而不是 warn**——"没能检查"和"检查通过"是两个答案，只有一个可以
  exit 0（同样带可读清单的对照，免得被"什么都 fail"的 doctor 满足）。**动了 doctor 必跑。**
- `harness/probe-check.mjs` — `paseo-plugin/lib/probe-provider.mjs` 的退出码与泄密防护
  （200+error/HTML 判失败、4xx 回显 Authorization 不得泄 key、全 429 报 unknown、什么都没
  探测到必须非零）。**动了 probe 必跑。**
- `harness/session-request-check.cjs` — 两段非回合请求：`paseo/sessions` 导入列表
  （persistence handle/cwd/title/preview→description/updatedAt）与 `paseo/revert` 撤回回执。
  撤回那一半钉住：成功发 `request.completed`、被拒必须 `request.failed`、**canary 恰好一条且
  出现在回执之前**（顺序即机制，见 AGENTS.md「撤回」一节）、被拒之后没有 canary、连续两次撤回的文案不同
  （序号递增）、`scope: "files"` 的撤回**不**发 canary（对话没被动过）、`scope: "both"` 的
  文案要点出文件那一半；仍然没有「正在回退，请稍候」这类刷新窗口通知。假桥 + 一次性
  `DSH_HOME`。**动了 provider 的
  `session.revert`/`sessions` 分支、canary 的发出位置、`dsh-process.ts` 的这两个请求、或假桥
  对应分支必跑**；**`listDshSessions`/`#listSessions` 或 `DshProcess.sessions()` 的 cwd 透传
  也算（断言出站帧 `params.cwd`）。**
- `harness/plugin-build.cjs` — **不是检查，是需要编译产物的 harness 共用的构建基础设施**
  （当前调用方见 `grep -l plugin-build harness/*`；`plugin-check.cjs` 仍走自己头部注释里的
  手工 `tsc` 步骤，不在其中）。
  它决定已有的编译树能否复用（源码集合 + 构建戳），判错不会让产物看起来有任何异常，只会让
  **其它检查在陈旧或残缺的产物上假绿**——这是这里最危险的失效形态。`resolvePluginBuild()`
  自动编译到 `paseo-plugin/.dbg-*`（产物必须在仓库内，`/tmp` 下 node 向上找不到
  `paseo-plugin/node_modules`），每个调用方传自己的目录名以免并行任务共用一棵树。
  **动了它的源码集合推导、新鲜度判据或构建戳格式必跑 `harness/plugin-build-check.mjs`。**
- `harness/plugin-build-check.mjs` — `plugin-build.cjs` 新鲜度判据的回归，纯元数据（不 require
  产物、不写仓库：构造状态全在临时目录的私有副本里）。每个场景**双向断言**——构造状态断言判据、
  还原后再断言回到 fresh，所以卡在任一答案都会红，不只是判据太松会红。钉住：刚构建的树是 fresh
  且源码集合覆盖根级入口（`index.server.ts` 注册 provider、`index.client.tsx`，这正是它存在的
  原因）；源码比构建新时 stale 且报错**点名那个文件**；缺编译产物、源码已删而 `.js` 还在、缺
  `package.json`、缺构建戳、构建后新增了源码、空源码集合，全部 stale（fail closed，绝不信没有
  构建戳的树）；`PASEO_PLUGIN_BUILD` 绕行每次都要喊、外部树与源码不一致时仍告警；判据确实接在
  复用决策上（`buildPlugin()` 会重建缺产物的树、复用 fresh 的树）。**动了 `plugin-build.cjs`
  的判据必跑。** 之所以不能省：`plugin-build.cjs` 是这条链的地基，判据一松，它下游每个
  harness 都会在陈旧或残缺的产物上变绿，而红绿本身看不出区别——这个脚本是唯一能把"判据退化了"
  和"判据正常"区分开的东西。
- `harness/harness-gates-check.mjs` — harness 自己判据的回归：T01 `route-test` 按终态分
  WORKS/FAILS/TIMEOUT/CANCELED/EMPTY 且全失败必须非零、T02 `tools.mjs` initialize 与 prompt
  共用 sessionId、T03 `plugin-check` 不预过滤 assistant 行、T04 图片证据取插件发出的 prompt
  frame（模型自报的 `IMAGE-SEEN` 不再算数）、HP-08 `session-calls` 无 schema 的调用必须
  exit 2 而不是 0、HP-05 隔离 home 的默认/opt-in 行为。纯离线，会启动真实入口脚本 + 假 peer。
  **动了 `route-test.mjs` / `tools.mjs` / `session-calls.mjs` / `plugin-check.cjs` 的判据，或
  `harness-gates.cjs` / `isolated-dsh-home.cjs` 必跑。**
- `harness/harness-gates.cjs` / `harness/isolated-dsh-home.cjs` — **不是独立检查**：前者是
  `route-test` / `tools` / `session-calls` / `plugin-check` 共用的纯判据（终态分类、退出码、
  完整时间线投影、图片块断言），后者是真实 profile/模型脚本的一次性 `DSH_HOME`（克隆源
  profile、凭据只做 symlink、退出清理、`--allow-real-profile` opt-in）。改动它们必跑
  `harness/harness-gates-check.mjs` 的对应段。
- `harness/frame-reader-check.mjs` — 插件的 stdout 分帧器（`paseo-plugin/server/frame-reader.ts`，
  共享 `dsh` 子进程的每一帧都过它）：20 MB 帧跨数千个 16 KB chunk 逐字节还原、一个 chunk 里的多帧按序到达、
  被 chunk 边界切断的帧能重组、空行被**跳过**而不是报成解析错（两者是 `#consume` 里不同的日志
  行）、`\r\n` 解析通过且保留 `\r`、尾部残行滞留不发、chunk 正好停在换行时不留残留、畸形行报错
  后后续行仍到达，并用**旧实现的随机分块对照**证明增量扫描不是 O(n²)（旧写法每个 chunk 重切整个
  缓冲，回放大会话时慢到 7–12 s）。纯模块：只把这一个文件编到 `paseo-plugin/` 下的临时目录，
  用完删掉。**动了 `server/frame-reader.ts` 或 `#consume` 的分帧/报错分支必跑。**
- `harness/fake-bridge-multi-check.mjs` — 假桥的 `multi` 场景，**纯协议层**（只 spawn 假桥说
  JSON-RPC，不经过插件）：一个桥进程带多个 Paseo 会话时各拿自己的答案、没有事件被路由到别的
  会话、每个会话恰好一次 `turn/end` 且回合号是自己的、`initialize` 不带 session id 也不打乱
  绑定、同一会话第二次提问不重放第一个会话的场景。它是插件层 `multi-session-check.mjs` 的
  前置——桥这一层先按会话隔离了，插件里再串台才可能是插件自己的问题。
  **动了 `fake-dsh-bridge.mjs` 的 `multi` 场景或桥的会话绑定必跑。**
- `harness/multi-session-check.mjs` — 两个 Paseo 会话共用**一个** `dsh` 子进程时在**插件层**
  不串台（桥的协议层由 `fake-bridge-multi-check.mjs` 覆盖，这里走插件自己的 `#sessions`、
  子进程 id 与引用计数，只有过一遍插件才能证明这一对是干净的）：两会话各自提问并各自拿到自己的
  答案、每个时间线只含自己的消息（任何事件类型下都看不到对方的文本）、各自一次 `session.turn`
  起止、关掉一个另一个仍能提问并作答；另外还钉住**共享子进程的引用计数**（每开一个会话加一个
  claim、关一个还一个，另一个仍在跑所以进程不被回收）与**孤儿帧的清理**（一个会话关闭时它的
  帧桶与计时器一起消失，不会 5 s 后打一条误导的「no ancestor announced」，而另一个会话的桶
  仍然照常上报——正对照，免得"清理过头"也通过）。假 `dsh` + 一次性 `DSH_HOME`，自己编译到私有
  目录。**动了多会话路由、`#deliverLive`、`provider.ts` 的引用计数或 `session.ts` 的会话归属
  逻辑必跑；或 `dsh-process.ts` 的 prompt/close 时序也必跑。**
- `harness/concurrent-open-check.mjs` — 同一个 DSH 会话的两次并发 `session.open` 不能毁掉成功的
  那次：只有一次到达 `session.ready`；另一次**响亮失败**（`request.failed`，不是沉默）；失败方
  被 in-flight 守卫拒掉（"another open … is already in flight"），**不是** `attachSession` 的
  "already attached"——走到 attach 就是失败方的 catch 拿着胜者状态的成因；胜者仍能提问并作答
  （没有 "unknown session"，这是用户可见的那一半）；失败事务释放了守卫，之后重新 open（新
  provider session id + persistence handle，跟 reload 一样）仍然成功。冷连接复现不出这个窗口，
  需要 `replaced` 分支那几个 await 的交错，所以脚本先开一次到 ready、再并发发两次。假 `dsh` +
  一次性 `DSH_HOME`，自己编译到私有目录。**动了 `provider.ts` 的 open/close 事务或 `#opening`
  守卫必跑。**

  脚本第二部分钉住 `#opening` 单独一个守卫盖不住的另外两个窗口，都是把**第二条请求放进第一条的
  await 里**（假桥的 `DSH_FAKE_HOLD_METHOD` 让它在指定方法上停住，直到测试写释放文件——不靠
  睡等时序）：**(a)** 开事务在旧 holder 的 `close()` 里停住时，一个 `session.close` 落在同一
  provider id 上，该 open 必须**响亮失败**且**不发布** `session.opened`/`session.config`/
  `session.ready`（修复前这三条照发，界面显示已就绪而 daemon 已关掉它）；**(b)** 同一 provider
  id 在第一次 open 还没结束时被重新绑定到**另一个** native 会话（Paseo 用新 agent id 重开导入
  会话就是这形状），第二次必须被拒（"another open for this provider session is already in
  flight"），且该 provider id 只发布一次 readiness。**(a) 的 hold 在 `session/close`、(b) 的在
  `paseo/commands`**，所以它们同时覆盖"close 使进行中的 open 失效"与"provider 身份也是排他的"。
  **动了 `provider.ts` 的 `#openTransaction` / `#assertOpening` / `#openingProviders`，或假桥的
  `DSH_FAKE_HOLD_*` 必跑；open 发出的 `session.config.modes` 必须与 catalog 的 modes 全等（单源）。**
- `harness/session-state-check.cjs` — 会话状态机（真实编译 `DshSession` + 假传输，不 spawn、
  不读凭据）：`#turnId`/`#turnStarted`/统计 reset、`configure` 的提交顺序与回执回读（被拒不落
  本地值）、切模型后 `thinkingOption` 回写、`DshSessionOptions.modes` 单源、子会话 opened/label
  闸门、`DshChildSession.fail` 守卫、prompt 在 running 后失败仍有回合终态。**动了
  `server/session.ts` 的回合状态、`configure` 的提交顺序/回执回读、`DshSessionOptions.modes`、
  子会话 opened/label 闸门或 `DshChildSession.fail` 必跑。**
- `harness/mcp-gateway-guard-check.mjs` — gateway 的 `tool` 参数守卫（`resolveTargetTool`，模块
  私有，所以驱动真实的 `apply()` + `defineTool` 注册路径，用 loopback 假 server 接住本该成功的
  调用）：空串与纯空白、把网关自己的元工具名当目标（含大小写变体、零宽字符、CJK 键盘打出的全角
  写法）或把 `archive_subagents` 当目标、把整个 `mcp_call_tool` 折进另一调的 `arguments`，都必须
  **在请求发出前**被点名拒绝并说出期望形状（被拒的用例不能到达 server）；正常名放行并拿到真
  schema，padding 被 trim 后才转发（trim 是便利不是绕过）；未知但合法的名字保留自己的错误、不与
  守卫的错混成一条（两种失败不能塌成同一句话）；schema 路径与 call 路径共用守卫所以都要守，非
  字符串目标由 schema 拒绝、报错措辞要断言在 schema 上（只断言"抛了且没回显"在守卫被删后仍成立，
  等于覆盖不到那个缺陷）。纯离线，只走 loopback；`@deepseek-ai/schemastery` 与 `dsh-tools` 按
  绝对路径从 DSH 安装目录加载（`DSH_PACKAGES_DIR` 可覆盖）。**动了 gateway 的
  `resolveTargetTool` 守卫或元工具注册必跑。**
- `harness/mcp-gateway-call-check.mjs` — `mcp_call_tool` 的结果投影与取消穿透：`structuredContent`
  保留、文本为空时以 JSON 渲染、`CallToolResult` 的畸形形状（非数组 content、非布尔
  `isError`、task 结果）响亮拒绝、`exec.signal` 贯穿到 HTTP socket / stdio
  `notifications/cancelled`、取消后不投影不落盘。**动了 `dsh-bridge/lib/mcp-gateway.js` 的
  `mcp_call_tool` 结果投影或 `exec.signal` 转发必跑。**
- `harness/transport-frame-check.mjs` — 桥的**入站**分帧器（`dsh-bridge/lib/transport.js` 的
  `#onData`）：一个桥进程服务所有会话，所以这里一次 O(n²) 扫描会卡住全部会话（13 MiB 图片帧
  曾阻塞事件循环 2.2 s）。20 MiB 帧跨数千个 16 KB chunk 逐字节还原、一个 chunk 里的多帧按序
  到达、被 chunk 边界切断的帧重组、空行跳过、`\r\n` 保留 `\r`、尾部残行滞留、畸形行报错后
  后续行仍到达，并用**旧实现当 oracle** 跑随机分块（相等，不是"差不多"）+ 耗时对照。纯模块：
  `transport.js` 只 import `node:string_decoder`，所以直接 require 真实文件而不是抄一份。
  **动了 `#onData` / `#dispatchLine` 或 `#partial` 的分帧机制必跑（含未终止帧上限/溢出语义）。**
- `harness/bridge-server-check.mjs` — 桥 server 本体（`dsh-bridge/lib/server.js`）的只读路径，
  用模块解析钩子把 `@deepseek-ai/*` 映到 DSH 安装目录后**驱动真实类**（假桥只能证明协议形状，
  证明不了 server 自己的副作用）：`usage()` 不得复活已关闭的会话（`closedSessions` 闸门；
  重新 initialize 过的与恢复会话的首次查询仍必须创建）、两处归档状态读取失败要**点名原因**
  （服务缺失每进程一行、读取抛错每次一行，策略不变）、`paseo/permission/set` 必须真的到达一个
  方法上（3047948 删了 `setPermission` 却留下 `case`，权限预设从此静默不生效），以及
  **`handleRequest` 的每个 `case` 调用的方法都必须在原型上**——那正是该回归的形状，任何行为
  断言都看不出来。**依赖本机 DSH 安装，所以不进 CI**（`DSH_PACKAGES_DIR` / `DSH_INSTALL_DIR`
  可覆盖，解析失败 exit 2 并打印实际目录）。**动了 `server.js` 的请求分派或这些只读路径必跑**；
  **另外，凡动了 `server.js` 的请求分派、会话生命周期（`prompt`/`cancel`/`createSession`/
  `closeSession`）、`listSessions` 或持久化读取区段也必跑**（新增断言覆盖 queued plan 双向
  应用、query/cwd 不做窄预过滤、persistence signal/迟到句柄、冷会话创建中 cancel）。
- `harness/bridge-entry-check.mjs` — 桥入口 `dsh-bridge/lib/index.js` 的 `startBridge` 工具
  生命周期接线（模块解析钩子把 `@deepseek-ai/*` 换成 stub，加载**真实**入口）：`tools/execute`
  → `beginFileMutation` → `captureFileBeforeTool` 的顺序、`post-execute` → commit/finish、
  `tools/result` → drop/finish、失败路径；纯离线、无需 DSH 安装。**动了 `dsh-bridge/lib/index.js`
  的 `startBridge` 工具生命周期接线（`beginFileMutation`/`captureFileBeforeTool`/
  `commitFileTool`/`finishFileMutation`/`dropFileTool`/`rememberToolDescription`）必跑。**
- `harness/assistant-retry-check.cjs` — 同一 `turn/step` 内**重试**的助手文本：DSH 在已经流出
  文本后失败重试，第二个 attempt 从空快照重新增长，而 Paseo 对"不是前缀的快照"的规则是整段
  追加——旧行为把两次 attempt 的文本粘成一行，读起来像模型语无伦次。断言两次 attempt 拿到不同
  item id（首个保持历史的 `assistant:1:1`，第二个 `assistant:1:1:2`）、durable `assistant/message`
  落在**第二个** id 上（答案只出现一次）、逐字复刻宿主折叠规则后最终答案恰好一行、第一个 attempt
  的行仍独立存在、reasoning 同样带后缀。假桥 `DSH_FAKE_MODE=retry` 驱动，下面全是真实插件。
  **动了 `server/timeline.ts` 的 attempt 后缀或桥的 `paseo/assistant-delta` 载荷必跑。**
- `harness/process-crash-check.mjs` — 大帧写向一个**已经死掉**的共享子进程：`stdin.write` 的
  EPIPE 是异步 `'error'` 事件，`#send` 的 try/catch 看不到，没有监听就是 uncaught exception →
  整个插件进程退出 → 该连接上**所有**会话一起断。断言：>256 KB 的帧打给死子进程时测试进程
  没有 uncaughtException、请求**立刻**失败（远早于 120 s RPC 超时）而不是悬挂、失败可见（经
  `onProtocolError` 或 reject，绝不静默丢），并带"子进程活着时同一路径正常"的正对照。
  **动了 `dsh-process.ts` 的 `#start` / stdin 写入、`#failAll`、`#request`/`#pending` 或出站队列必跑。**
- `harness/child-crash-check.mjs` — 共享子进程在**子代理回合中途**死掉：`#exitAll` 只覆盖
  attach 过的根会话，原生子代理不在那张表里（视图在 `DshSession.#children`），而
  `DshChildSession` 原本没有任何失败通道——子代理行会永远脉冲"运行中"、它持有的提问卡永不
  结算。断言：子会话确实在回合中（正对照）、子视图收到点名**子会话 id** 的
  `session.runtime_failed`、根也收到自己的、**子先于根**（宿主把 `runtime_failed` 当该会话的
  终态，后发的会被丢）、子会话不补编一个 `session.turn` 终态。崩溃由脚本自己 `SIGKILL` 假桥
  记录的 pid 制造（不给假桥加场景）。**动了 `session.ts` 的子会话终态或 `dsh-process.ts` 的
  进程退出扇出必跑；回归同时钉住「已完成子会话不被进程退出改写为 failed」。**
- `harness/host-contract-sim.mjs` — 见 AGENTS.md「撤回」一节的 canary 说明：唯一直接断言**宿主**行为的
  脚本（canary 在补丁版被截、原版存活；回执后发的在两种宿主上都存活）。只 import 宿主文件，
  从不修改。**动了 canary 的文案/顺序或 `rewind-canary.ts` 必跑。**
- `harness/local-patches-check.mjs` — `local-patches/` 的纯离线检查（spawn 真实 apply/check
  脚本，`REWIND_PATCH_TARGET` / `REWIND_PATCH_TURNID_TARGET` / `REWIND_PATCH_HOME` 全指向临时
  fixture，不读写已安装宿主）：stale 重建边界（`CALL` 区域之外有语句必须 fail closed、文件
  不变）与 checker / `apply --check` 的 `host-fields-changed` / `upstream-history-shape-changed`
  门禁。**动了 `local-patches/apply-rewind-history-truncation.mjs` 或
  `local-patches/check-rewind-patch.mjs` 必跑。**
- `harness/fake-dsh-bridge.mjs` 的**默认行为变严**：`session/prompt` 现在按会话校验
  `initialize`（文案与真桥一致），漏发 `initialize` 的插件 bug 不再在假桥上一路全绿——`f084c33`
  那个「每个会话都能打开、第一次提问必失败」的缺陷当初就是这么漏过去的。**严格是诚实默认**；
  只有刻意测 `initialize` **之下**协议层的脚本（目前仅 `fake-bridge-multi-check.mjs`）显式
  `DSH_FAKE_ALLOW_UNINITIALIZED=1` opt-out，并在自己的调用点写明理由。另有 `mcp-late` 场景：
  `paseo/mcp/set` 像真桥那样**抛错**（不是回 `mounted: false`），钉住插件把"会话已建好之后
  再设 MCP"失败成 `request.failed` 而不是静默成功。长驻子进程的场景切换用
  `DSH_FAKE_MODE_FILE`（spawn 时的环境已冻结，改 `DSH_FAKE_MODE` 对已在跑的 child 不可见）。
- `harness/source-shape.cjs` — **不是独立检查**，是几个必须读 `.tsx` 源码的检查共用的
  **TSX 结构读取器**：解析 JSX 开标签及其属性，让"这个元素自己测布局""图标按状态与可编辑性
  取色"这类只存在于 JSX 里的接线也能断言。它取代的是按格式匹配的正则——换行、属性顺序、单行
  写法都能让组件仍然正确却让正则变红，误报一次就会把后来的真回归放过去。故意不是通用解析器
  （无嵌套树、标签内注释、属性表达式里的模板字面量），读不出来就**跳过而不猜**（fail closed）。
  **动了它的 JSX/调用读取规则必跑所有 `require` 它的检查**（`grep -l source-shape harness/*`
  看当前集合，别按记忆列名单）。

上面清单之外还有四个容易被当成同类、其实不是的：`harness/tools.mjs`（真 `dsh` 的工具目录
转储）、`harness/subagent-live.mjs`（实机子会话可见性）、`harness/fake-dsh-bridge.mjs`
（上面几个假桥脚本共用的 scripted 替身，不是独立检查脚本），以及
`harness/session-calls.mjs`——**诊断工具，不是回归**：它读 `$DSH_HOME/sessions` 下的会话
日志，把每个 `tool/call` 的参数**键**与同一会话里 `request/header` 真正下发给模型的 schema
做 diff，报出未声明的键并以 `exit 1` 结束；有调用查不到 schema（或参数不是 JSON）时
`exit 2`，不把"没检查"当干净。用来回答"我到底发出去了什么"：界面和模型读到的
转写都是渲染，不能当证据。它刻意绕开两个坑——会话日志是**多帧** zstd
（`zlib.zstdDecompressSync` 只解第一帧，会把 1.6 MB 的会话读成 172 字节的头部），以及
**绝不静默跳过**解不开的文件。用法：`node harness/session-calls.mjs --list` /
`--latest` / `--session <id>`，可再加 `--tool <name>`、`--raw`。
