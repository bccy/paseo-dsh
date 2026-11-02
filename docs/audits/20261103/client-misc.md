# 客户端其余模块审查（client-misc）— 2026-11-03

- 审查基线：`0c82df5`（main；工作区仅有未跟踪的 `V1.txt` / `v1.txt` 与 `docs/audits/20261103/`，未改动）
- 审查方式：独立只读审查（fresh 上下文），逐行通读全部范围内文件，不采信其它 lane 与本仓库提交信息的结论；每条结论由本轮自己复跑或重新读码得出。
- 范围（11 文件，2241 行）：`paseo-plugin/client/locale.ts`(721)、`newest.ts`(273)、`inline-thinking.tsx`(227)、`stream-stats.tsx`(141)、`sweep-geometry.ts`(72)、`sweep-native.tsx`(133)、`shimmer-css.ts`(180)、`text-shimmer.tsx`(105)、`thinking-text.ts`(106)、`paseo-mark.ts`(23)、`paseo-plugin/index.client.tsx`(260)。另按任务书只读核对撤回提示胶囊与本 lane 的接缝（`client/rewind-notice.tsx`、`rewind-notice-data.ts`、`rewind-notice-live.ts` 的 `startRewindLiveMonitor` 签名与清理），不审提示逻辑本身。
- 方法：全量读码 + 与已装 DSH 0.2.1-rc.5 / Paseo 0.14.0 实际包（含宿主 web bundle）对照 + 可复跑的离线检查与定向探针。未起真实模型回合、未读写真实 `~/.dsh` profile、未装包、未做 git 写操作；除本报告外未写任何 tracked 文件。
- 证据等级：**实测**＝本机可复现命令 + exit code/输出片段；**源码推断**＝读实现与调用链得出、未做设备/浏览器验证；**文档/类型依据**＝已装包 d.ts 或官方 CSS 原文；**未验证**＝未取得运行证据，单列第 5 节。

## 1. 本轮复跑的检查（命令与结果）

| # | 命令（工作目录） | exit | 结果 |
|---|---|---:|---|
| 1 | `cd paseo-plugin && npx tsc --noEmit` | 0 | 类型门干净（0 行输出） |
| 2 | 编译 `client/locale.ts client/tool-call-data.ts` 后 `node locale-check.cjs` | 0 | **269 passed / 0 failed** |
| 3 | 编译 `client/thinking-text.ts client/inline-thinking.tsx` 后 `node thinking-check.cjs` | 0 | **51 passed / 0 failed**（含 C2 同帧落定的组件状态回归） |
| 4 | 红基线：把 `6394809^` 的 `inline-thinking.tsx` 与 HEAD 其余依赖同法编译后跑同一 `thinking-check.cjs` | **1** | **45 passed / 6 failed**，失败项即落定窗口类（`…it only starts the settle window`、`…and then settles without another host frame` 等） |
| 5 | 编译 `client/newest.ts` 后 `node newest-check.cjs` | 0 | 36 passed / 0 failed |
| 6 | 编译 `client/sweep-geometry.ts` 后 `node sweep-check.cjs` | 0 | 25 passed / 0 failed |
| 7 | 探针 `/tmp/cm-probe.cjs`（编译模块直接驱动 locale/newest/sweep/thinking 纯函数） | 0 | 见 CM-02/03/06/07/12 的证据片段 |
| 8 | 探针 `/tmp/cm-probe-newest.cjs`（按微任务折叠一个渲染 pass） | 0 | 见 CM-06 |
| 9 | 差分探针 `/tmp/cm-first-token-diff.cjs`：插件 `server/first-token.ts` vs 已装 `@deepseek-ai/dsh-llm` 的 `assistantStreamFirstTokenTime`，15 组 fixture | 0 | **15/15 SAME，mismatches=0**；仅畸形 packed run 上 DSH 抛错、插件返回 `undefined`（防御性差异） |
| 10 | 内嵌 PNG 解码（`paseo-mark.ts` / `inline-thinking.tsx` 的 base64） | 0 | 均 64×64、bitdepth 8、colortype 6（RGBA），与注释一致 |

## 2. 健康度评分

| 维度 | 评分（1-5） | 说明 |
|---|---:|---|
| 正确性 | 4 | 上轮唯一 P2（C2 思考末帧不落定）已由 `6394809` 修复，本轮红→绿复现确认；剩余为显示/边界类 P3 |
| 健壮性 | 4 | 所有定时器/动画/订阅都有清理；仍有原型链查表、locale 中继被无 hint 行清空、native 无 reduced-motion 三处窄口径欠账 |
| 可维护性 | 3 | 注释密度高但多处与事实不符（i18n 可用性、"verbatim"、setLocale 语义、quantize 未接线），且 locale 解析链双份实现、客户端一份无消费者 |
| 契约一致性 | 4 | renderer schema/phase/notification itemType/contribution cleanup 均与已装 0.14 契约核对通过；`stream-stats` 的本地化与字段口径不完整 |
| 性能 | 4 | tail 窗口化、native driver、newest 状态上限 200；native 8 份装饰副本为已知成本 |
| 安全 | 5 | 无外部输入执行、无凭据、无网络请求；仅 localStorage 调试开关且异常已捕获 |
| 测试覆盖 | 4 | locale/thinking（含 C2 红绿）/newest/sweep 四门全绿共 381 条断言；缺并列时间戳、stream-stats 文案本地化、native 动画/reduced-motion 的回归 |

**总分：28 / 35（约 4.0 / 5）**

**一句话总评：** 上轮唯一 P2（C2）已真实修复且带可复现的红→绿证据，本组文件没有 P0/P1/P2；剩余问题集中在本地化覆盖、注释与实现漂移、以及少量显示/边界口径，属"可发布、维护批次清理"状态。

## 3. 发现列表

本轮无 P0/P1/P2，全部为 P3（显示/可维护性）。"基线"列说明是否本轮改动引入。

| ID | 级别 | file:line | 触发条件 | 证据等级 | 归属 | 基线 | 摘要 |
|---|---|---|---|---|---|---|---|
| CM-01 | P3 | `client/stream-stats.tsx:47,52-55,61,67,84,87,90,93,96,107,118` | 任何环境下渲染回答统计行 | 源码 | 本 lane | 基线已有 | 统计行全部可见文案与无障碍标签写死中文，不读 `localeText()`；英文 daemon 下该行仍中文，与已跟随 locale 中继的思考/工具行不一致 |
| CM-02 | P3 | `client/locale.ts:692-699`（表在 `:361-367`/`:574-580`） | `agentMessageLabel(event)` 收到 `Object.prototype` 键（`toString`/`constructor`/`__proto__`/`hasOwnProperty`…） | 实测 | 本 lane（同类在 tool-call-data，见跨 lane） | 基线已有 | 直接下标查表命中继承属性：返回函数/对象而非 generic heading，React 渲染函数子节点会抛错 |
| CM-03 | P3 | `index.client.tsx:79`；`client/locale.ts:670-672` | 任一 `tool_call` 行的 `metadata` 不含 `locale`（daemon 自己生成的 `agent_message`/worktree 行等非本插件生产者） | 源码推断（清空行为已实测） | 本 lane | 基线已有 | `setLocale(localeFromMetadata(item.metadata))` 无条件调用，空值即清空中继 → 之后新渲染的行回落 `zh-CN`，非中文 daemon 下行语言回跳 |
| CM-04 | P3 | `paseo-plugin/server/session.ts:2501,2645-2653`；`dsh-bridge/lib/server.js:769`；对照已装 DSH `dsh-client-ui-chat/lib/client.js:7399` | 显示「首字」数值 | 源码推断（tok/s 部分已实测，见阴性结论） | 本 lane（需桥配合） | 基线已有 | 「首字」= firstToken − 桥收到 stream `start` 的 `Date.now()`（attempt 开始）；DSH 自身 TTFT = firstToken − **step/start**。前者系统性偏小，两者不是同一口径；tok/s 分母（decode window）已与 DSH 一致 |
| CM-05 | P3 | `client/stream-stats.tsx:6-23,50-56`；对照 `server/session.ts:2567-2568` | 展开统计行明细 | 源码 | 本 lane | 基线已有 | 明细只渲染 input/cacheRead/output，缺 `cacheWriteTokens`（服务端总量口径含它）；schema 声明并接收 `sessionTokens` 但组件从不渲染 |
| CM-06 | P3 | `client/newest.ts:177`（`at >= known`）、`:226-228` | 两行时间戳完全相等（同毫秒记录时间：并行工具行、回放时 daemon 补的同一记录时刻） | 实测 | 本 lane | 基线已有 | 并列最大时间戳时多行同时 `newest`，且每 pass 持续为 true；若其中一行是残留 `running`，`shouldPulse("running",{newest:true,fresh:false})===true` → 扫光不落定，直到出现严格更大时间戳 |
| CM-07 | P3 | `client/sweep-geometry.ts:65-72`；`client/sweep-native.tsx:55-75` | 原生端扫光 | 实测（差异）+ 源码（未接线） | 本 lane | 基线已有 | `quantize` 注释称按 CSS `steps(48,end)`，实现是 `round`（1001 点采样 496 点与 floor 不同）；且 `quantize`/`SWEEP_STEPS` 生产代码从未调用，native 用 `Easing.linear` 连续运动 → "48 步量化"没有落到实现 |
| CM-08 | P3 | `client/sweep-native.tsx:46-75` | 系统开启"减少动态效果"且运行在 iOS/Android | 源码推断 | 本 lane | 基线已有 | 原生路径不读 `AccessibilityInfo`/reduced-motion，`Animated.loop` 仍无限运行；web 路径已由 `shimmer-css.ts:115-119` 处理 |
| CM-09 | P3 | `client/text-shimmer.tsx:73-78`；`client/shimmer-css.ts:64-71,88-104` | 一次会话里第一个 shimmer 行首次挂载 | 源码推断（未做浏览器复跑） | 本 lane | **本轮新增发现** | 样式表在 `useEffect`（提交后/绘制后）才注入；注入前装饰副本没有 `position:absolute`/`overflow`，会作为普通块在正文下方重复渲染一帧（行高翻倍、文本重影），随后样式到位才消失 |
| CM-10 | P3 | `client/locale.ts:173-295`（en 表） | profile 组合了 `dsh-sdk-app` / `dsh-workspace-changes` / `dsh-experimental-tool-worktree` 等 bundle | 源码（已装包静态扫描） | 本 lane（locale 表） | **本轮新增发现** | 已装 DSH 里 `str_replace_editor`（`dsh-tool-str-replace-editor`）、`load_workspace_dependencies`（`dsh-tool-workspace-dependencies`，`dsh-sdk-app` 依赖）、`create_worktree`（`dsh-experimental-tool-worktree`）都是一等工具，但标签表与 `harness/locale-check.cjs` 的 136 工具快照都不含它们；这些部署里行头回落 wire name + 扳手。桥自己的 `dsh-bridge/lib/file-snapshots.js:78-93` 明确写"A profile may also compose a third one, `str_replace_editor`"，即这是本插件面向其它部署的真实路径 |
| CM-11 | P3 | `client/locale.ts:9-21,28-34` | 维护者依据该注释判断客户端能否取 locale | 文档/类型依据 + 源码 | 本 lane（注释） | 基线已有 | 注释断言"`PluginClientContext` 没有 locale 服务、宿主 i18n 不是插件导出、allow-list 挡住它"，与已装 0.14 契约矛盾：`contracts.d.ts:147` 有 `i18n: PluginI18n`、`index.d.ts:25` 导出 `useTranslation`，宿主 runtime 也确实构造 `locale`/`i18n`（宿主 web bundle `PluginTranslationRuntime`）。注释掩盖了用公开 i18n 收敛此问题的路径 |
| CM-12 | P3 | `client/locale.ts:628-633` vs `:663-672` | `setLocale("fr")` 之类非空非 zh 值 | 实测 | 本 lane | 基线已有 | `setLocale` 注释称"空或不可识别值清空中继、不猜成英文"，实际 `normalizeLocale("fr"/"de-DE"/"english")` 全部返回 `"en"`（只有空串/非字符串才清空）；行为与 server 链一致，但注释与实现相反 |
| CM-13 | P3 | `client/shimmer-css.ts:10-16` | 维护者判断哪些行允许漂移 | 源码 | 本 lane | 基线已有 | 注释称"Everything between the 'verbatim' markers 抄自 DSH 的 TextShimmer.module.css"，文件里没有任何 verbatim marker，且实际有多处实质改动（自有 `--dsh-paseo-shimmer` 变量、装饰副本由 `::after` 改为真实子节点、新增 `!important`），"原样"不可核 |
| CM-14 | P3 | `client/inline-thinking.tsx:223`；`client/thinking-text.ts:56-59`；对照 DSH `dsh-client-ui-chat/lib/client.js:6113-6126,6190` | provider 返回以 `<signature>` 包裹的 reasoning | 源码推断 | 本 lane | 基线已有 | DSH 展示 reasoning 前先过 `reasoningText()`（剥 `<signature>` 段）；本插件直接渲染 `item.text`（`server/timeline.ts:920-928` 原样下发），会显示签名包裹内容 |
| CM-15 | P3 | `client/locale.ts:643-658`；对照 `server/locale.ts:32-45` | 任一侧解析链漂移 | 源码 | 本 lane（跨 server） | 基线已有 | "DSH_PASEO_LANG → LC_ALL → LC_MESSAGES → LANG"存在两份独立实现；客户端这份在生产代码里无消费者（只有 `harness/locale-check.cjs` 用手写期望值断言它，不 import server 实现），两侧漂移不会变红，"identical to the server's chain"无跨模块证据 |

### 3.1 关键发现说明

**CM-06（并列时间戳，实测）** — 探针 `/tmp/cm-probe-newest.cjs` 输出（按微任务折叠一个 pass）：

```
## tie timestamps (two rows same ms, rendered in one pass)
  pass1: [false, false]
  pass2: [true, true]      ← 并列最大值：两行都自称 newest
  pass3: [true]            ← 继续为 true，不会自愈
  stale running pulses? true
## distinct timestamps converge to one newest
  pass2: [false, true]     ← 不同时间戳只重叠一帧
```

根因是 `noteRender` 用 `at >= known` 取"运行最大值"，并列时无法选出唯一最新行。服务端 `settleRunningTools()` 会在 replay/turn-end 收掉残留 running，所以主要残余影响是并行工具行同帧多个 `newest`、极端情况下残留 running 行持续扫光；与模块注释"only the newest row does"不一致。

**CM-09（首帧样式未注入，源码推断）** — `ensureShimmerStyles()` 在 `TextShimmer` 的 `useEffect` 里调用（`text-shimmer.tsx:73-78`），而装饰副本在 `active` 时同一次提交就渲染（`:93-102`）。React 的 passive effect 在提交/绘制之后执行，所以首个 shimmer 行有一帧无 CSS：`SHIMMER_DECORATION` 没有 `position:absolute`（`shimmer-css.ts:64-71`），会作为普通块把高亮副本排在正文下方。修法建议：把样式注入提到模块加载/`useLayoutEffect`，或首帧不渲染装饰副本。**未做浏览器复跑**，见第 5 节。

**CM-10（标签覆盖，源码扫描）** — 已装 DSH 的静态扫描：

```
$ grep -hoE 'name: ?"[a-z][a-z0-9_]{2,40}"' dsh-tool-*/lib/index.js dsh-experimental-tool-*/lib/index.js dsh-tools/lib/*.js
… str_replace_editor … load_workspace_dependencies … create_worktree …
$ grep -c "str_replace_editor" paseo-plugin/client/locale.ts        → 0
$ grep -c "str_replace_editor" harness/locale-check.cjs             → 0
$ grep -rn "dsh-tool-workspace-dependencies" dsh-sdk-app/package.json → 依赖（bundle 会挂载）
$ grep -rn "dsh-tool-str-replace-editor" dsh-workspace-changes/package.json → 依赖
```

paseo 自己的 profile 是 `dsh-base` + bridge（不挂这三个），所以本机不受影响；但插件是发布给别人用的，且桥已明确支持 `str_replace_editor` 的撤回追踪，说明该组合是被预期支持的。

## 4. 阴性结论（本轮验证通过 / 上轮结论被修正）

| 项目 | 结论与证据 |
|---|---|
| **C2 思考末帧落定（上轮唯一 P2）** | **已修复且可复现**。`6394809` 改为"增长照常 latch + `complete` 稳定 300ms 才落定"（`inline-thinking.tsx:63,72-86`）。绿：`thinking-check.cjs` 51/0 exit 0（含 `the frame that both grows and completes starts the window`、`…and then settles without another host frame`、`unmount clears the pending window`）。红：用 `6394809^` 的组件源码同法编译后同一 harness 45/6 exit 1，失败项正是落定窗口类 —— 归因成立，不是"测试恰好绿" |
| **tok/s 与 DSH 自身解码窗口一致** | 成立。差分实测：插件 `server/first-token.ts` 的读取器与已装 `@deepseek-ai/dsh-llm` 的 `assistantStreamFirstTokenTime` 在 15 组 fixture 上 15/15 相同（exit 0），`isTokenDelta`/`runFirstTokenTime` 语义逐条一致；窗口另一端插件用 `assistant/message` 的 `event.time`，与 DSH `dsh-session-stats/lib/index.js:107-122` 的 `decodeMs = event.time − firstToken` 同式；桥确实转发事件 `time`（`dsh-bridge/lib/server.js:613` 原样转发）。（仅「首字」基准不同，见 CM-04。） |
| locale 表结构与覆盖 | `locale-check.cjs` 269/0 exit 0：两语言顶层键一致；`toolLabels` 92、`paseoMcpLabels` 63、`agentMessageEvents` 5、`bodyLabels` 9 键集完全相等；英文列无中文复制；`jobs.statuses` 与 `shared/jobs.ts` 的 `JOB_STATUSES` 完全一致；Paseo 官方 catalog 英文列逐字断言通过 |
| wire name 保留 | 未知工具/外部 MCP server 工具按文档回落 wire name 且不伪装（`locale-check` 对 `mcp__server_browser__*`、模型臆造名 `mcp__paseo__mcp_list_tools` 断言）；思考行 `thinking` 标签走 locale 表（`思考`/`Thinking`），不再硬编码 |
| 组件卸载与定时器清理 | 全部在位：`inline-thinking` 的 settle 定时器（cleanup 在 `:83`，红绿测试覆盖 unmount）、`newest` 的 pulse 唤醒定时器（`:269-270`）、`sweep-native` 的延迟启动定时器与 `loop.stop()`（`:69-74`）、`text-shimmer` 无定时器、`index.client.tsx` 返回的 cleanup 收集三处贡献 |
| 宿主 cleanup 契约（修正上轮 CM-04） | **上轮"入口丢弃注册 cleanup = reload 后残留"不成立（至少 0.14）**。已装宿主 web bundle 的插件客户端 runtime 里，每次 `addTimelineTransformer`/`addTimelineRenderer` 都通过 `G(...)` 把 cleanup 收进 setup 清理集合 `z`，插件卸载/失败时 `for (const e of z) e()` 统一执行；且宿主强制要求 `contribute()` 返回函数（`"contribution must return a cleanup function"`），本入口满足。丢弃返回值只是冗余，不是缺陷。<0.14 宿主未验证 |
| 入口新增接缝（撤回提示胶囊） | 契约合法且清理到位：`itemType: "notification"` 在宿主允许集合内（`new Set(["user_message","assistant_message","reasoning","tool_call","todo","notification","error","compaction"])`）；renderer `schema` 是 zod（`rewindNoticeSchema`）且 `version>=1`；`contribute()` 返回值含 `startRewindLiveMonitor` 的 cleanup。`client.paseo` 与 `client.rpc` 在基线 `2f71225` 已被 jobs pill 使用，本改动没有引入新的宿主 API 依赖；老宿主若没有 `paseo`，`start()` 的 try/catch 会走 `onError` 而不是让 `contribute()` 抛错。`RewindNotice` 行内无定时器/动画，`isLegacyRewindNotice` 只匹配 copy 表（canary 不在表内，注释与实现一致） |
| 动画在 RN Web 上的生命周期 | 与 `docs/AGENTS.md` 的脉冲约束一致：web 走纯 CSS 无限动画（无 JS 生命周期），`Animated` 只在 native 路径使用（web 仅 `localStorage["dsh-sweep"]==="native"` 调试开关）；native 的 loop/延时都在 cleanup 里停止并复位 `progress` |
| 内嵌 PNG | 两处 base64 均 64×64 RGBA（IHDR 实测），与"4x 栅格化、white-on-transparent、16px 显示"注释一致 |
| 类型门 | `cd paseo-plugin && npx tsc --noEmit` exit 0 |
| 安全面 | 本组文件无网络请求、无密钥、无路径拼接、无外部输入执行；仅 `text-shimmer.tsx:56-64` 读 localStorage 调试开关且 try/catch |

## 5. 未验证项

- **CM-09 的首帧重影**：仅从 React passive effect 时序推断，未在真实浏览器/桌面 app 复跑截图；若同一 app 生命周期内已有其它 shimmer 行先挂载，则该现象不可见。
- **CM-03 的运行时表现**：未在"英文 daemon + agent_message/worktree 行"真实会话观测语言回跳（机制已由宿主投影 + 插件代码推出；清空行为已用探针实测）。
- **CM-10 的实际影响**：未在挂载 `dsh-sdk-app`/`dsh-workspace-changes` 的 profile 里跑真实会话确认行头确实回落 wire name（按 `tool-call-data.ts` 的 fallback 规则推断）。
- **CM-04 的数值差**：未跑真实回合对比「首字」与 DSH `ttftMs` 的实际差；未验证 retry（attempt 2）时 `#streamStats` "最新窗口胜出"与 DSH 取第一次 attempt 首 token 的差异表现。
- **native 真机**：iOS/Android 上扫光的观感、reduced-motion、动态字体、8 层装饰副本的帧率/内存均未验证（本机 Linux 无模拟器）。
- **<0.14 宿主**：`requirements.paseo: ">=0.9.2"` 下，注册 cleanup 是否也由宿主统一回收、`client.i18n` 是否存在，均未验证（本轮只核了已装 0.14.0）。
- **真实模型回合下的 stream-stats**：低速模型、纯工具步骤、重试步骤的展示未跑（任务约定不跑真实模型）。
- `harness/locale-check.cjs` 的 136 工具快照取自 2026-10-20 的本机 `request/header`；本轮未刷新（禁读真实 `~/.dsh`），CM-10 是静态扫描已装包得到的**超集**缺口，不代表当前 profile 挂载集。

## 6. 跨 lane 提示

1. **tool-call lane**：`client/tool-call-data.ts:947` 的 `toolLabel()` 与 `:1217` 的 `paseoMcpLabel()` 与 CM-02 是同一类原型链查表问题（探针实测 `toolLabel("toString")` 返回函数），建议与 CM-02 一并修（`Object.hasOwn` / `Object.create(null)` / `Map`）。
2. **bridge lane**：若要把「首字」对齐成 DSH 的 TTFT，基要改成 step/start 时间（桥当前只有 attempt 起点 `startedAt: Date.now()`，`dsh-bridge/lib/server.js:769`）；只改插件侧无法补出 step 起点。
3. **server/session lane**：`stream-stats` 的 `sessionTokens`/`cacheWrite` 已由服务端算出/可算（`server/session.ts:2567-2568`、`#accumulateTotals`），客户端 schema 缺 `cacheWriteTokens` 字段；若补显示，需两边同时加。
4. **rewind-notice lane**：本 lane 只核了接缝——注册合法（notification itemType 在宿主允许集内）、`contribute()` 返回值已收集该 monitor 的 cleanup、行内无定时器；`startRewindLiveMonitor` 的目录订阅/重试语义未审（归该 lane）。提示：`RewindNotice` 的 `useEffect` 依赖 `[agentId, data, toast]`，`monitor.take()` 是一次性消费，effect 重跑不会重复弹胶囊。
5. **docs lane**：`docs/FIELD-NOTES.md:800-802`「已知缺口（未修）：插件客户端没有 locale 来源…」已过时（`metadata.locale` 中继已存在，思考/工具行会跟随；只剩无 metadata 的行与 stream-stats 行不跟随）；`client/locale.ts:9-34` 与 `:663-672` 的注释也需按 CM-11/CM-12 修正。
6. **jobs lane**：本轮相对基线的 `locale.ts` 改动只有 jobs 文案 `label→liveLabel`，已被 `locale-check.cjs` 覆盖（`liveLabel(1)="1 background"/"1 个后台"`、无 `idleLabel` 断言），未发现新问题。
