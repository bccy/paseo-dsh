# 客户端其余模块审查（client-misc）

- 审查基线：`2f71225`（main，工作区干净；上一轮全量审查基线 `9298c28`）
- 范围：`paseo-plugin/client/locale.ts`、`newest.ts`、`thinking-text.ts`、`inline-thinking.tsx`、`stream-stats.tsx`、`sweep-geometry.ts`、`sweep-native.tsx`、`text-shimmer.tsx`、`shimmer-css.ts`、`paseo-mark.ts`、`paseo-plugin/index.client.tsx`（共 11 文件，逐行读审）
- 方法：全量读源码 + 与已装 DSH 0.2.1-rc.5 / Paseo 0.14.0 实际包对照 + 可安全运行的离线检查与定向探针。未起真实模型回合、未写真实 profile、未改任何 tracked 文件（本报告除外）。本 lane 相对基线的生产代码改动只有 `locale.ts` 的 jobs 文案 +21 行（其正确性已核）；其余发现全部为**基线已有**。
- 证据分级约定：「实测」= 本机可复现的代码/模块运行结果；「源码推断」= 读实现与调用链得出、未做设备/真机验证；「文档/类型依据」= 已装包类型或官方 CSS 原文；「未验证」= 未取得运行证据。

## 1. 结论

**没有阻断性健康问题。** 这组文件整体实现质量较好：思考预览逐字移植 DSH、扫光几何与官方 CSS 的数值/关键帧一致、locale 两种语言表结构与覆盖完整（263 条离线断言全过）、内嵌 PNG 与声明一致、两处定时器都有 cleanup。**唯一 P2 是基线 C2 仍未修复**：`inline-thinking` 的 `useGrowing` 在“文本增长 + phase=complete 同帧到达”时不会落定，扫光会一直停留在“生成中”状态（已用编译组件 + 最小 hooks dispatcher 实测复现）。其余为窄口径/可维护性问题：locale 中继只挂 tool_call 且会被无 metadata 行重置、未知 agent-message 事件的表查找走原型链、入口与 stream-stats 丢弃注册 cleanup、统计行文案硬编码中文等。

## 2. 发现清单

| ID | 严重度 | file:line | 触发条件 | 证据等级 | 新引入 vs 基线已有 |
|---|---|---|---|---|---|
| CM-01 | P2 | `paseo-plugin/client/inline-thinking.tsx:56-68` | 同一帧更新同时满足 `text.length` 增长且 `phase === "complete"`（流式最后快照补齐文本的常见形状）：effect 先 `setGrowing(true); return`，跳过 complete；依赖 `[text, phase]` 之后不再变化，growing 永久为 true，扫光/tail 不落定 | 实测（编译 `InlineThinking` + 最小 hooks dispatcher：`a/streaming=true → ab/complete=true → ab/complete=true`；需再发生一次 phase 变化才变 false。非真机） | 基线已有（上一轮 C2，未修复） |
| CM-02 | P3 | `paseo-plugin/client/locale.ts:689-696`（表查找在 `:692`） | `agentMessageLabel(event)` 收到 `"toString"` / `"constructor"` / `"hasOwnProperty"` / `"__proto__"` 等 `Object.prototype` 键：直接下标访问返回继承的函数/对象，`known !== undefined` 成立并把它当字符串返回；React 渲染函数或对象子节点会抛错，而不是文档承诺的 generic heading | 实测（对编译后的 `client/locale.js` 调用：`toString -> function`、`constructor -> function`、`__proto__ -> object`） | 基线已有 |
| CM-03 | P3 | `paseo-plugin/index.client.tsx:68` + `paseo-plugin/client/locale.ts:666-673` | 任一 `tool_call` 行的 `metadata` 不含 `locale`（宿主 0.14 的插件投影 `...l?{metadata:l}:{}` 只在 metadata 为真时携带；daemon 生成的 `agent_message` 行/其它生产者行可无 metadata）→ `setLocale(localeFromMetadata(undefined))` 清空已中继的 locale，之后新渲染的思考/助手行回落到 `zh-CN`；非中文 daemon 下行语言会来回跳。另：locale 是模块级全局变量，多 host/多 daemon 不同 locale 时互相覆盖 | 源码推断（路径 + 已装 0.14.0 宿主 bundle `projectPluginTimelineItems` 投影字段实读；未在真实多 host 环境观测） | 基线已有 |
| CM-04 | P3 | `paseo-plugin/index.client.tsx:28-48,50-104,106-190,201-208`；`paseo-plugin/client/stream-stats.tsx:133-141` | `addTimelineTransformer` / `addTimelineRenderer` 均返回 `PluginCleanup`（已装契约 `client/contracts.d.ts:166-167`），但入口的 2 个 transformer + 2 个 renderer 返回值全部丢弃；`contributeStreamStats` 也丢弃 `addTimelineRenderer` 的 cleanup 并返回空函数。插件 reload/unload 时旧注册可能残留，与 `index.client.tsx:196-200` “Both contributions return a cleanup, and both are kept” 的注释意图相反 | 源码依据（契约类型 + 代码路径）；宿主是否另有统一清理未验证 | 基线已有 |
| CM-05 | P3 | `paseo-plugin/client/stream-stats.tsx:47,52-55,61,67,84,87,90,93,96,107` | 统计行所有可见文案（`上下文`/`输入`/`缓存`/`输出`/`路由`/`思考`/`工具`/`首字`/`缓存命中`/`轮`/`步`/无障碍标签）写死中文，`locale.ts` 无对应资源；英文环境下该行仍显示中文 | 源码依据 | 基线已有（上一轮 E3 已指出） |
| CM-06 | P3 | `paseo-plugin/client/stream-stats.tsx:6-23,50-56` | 明细 “Tokens” 行只渲染 `inputTokens` + `cachedInputTokens` + `outputTokens`，缺 `cacheWriteTokens`（服务端 `session.ts:2372-2388` 的总量明确包含 input+cacheRead+cacheWrite+output）；同时 `streamStatsSchema` 声明并接收 `sessionTokens`，但组件从未渲染——服务端的“总量”口径在客户端不可见/不完整 | 源码对照（server/session.ts 与 client schema/渲染） | 基线已有 |
| CM-07 | P3 | `paseo-plugin/client/newest.ts:175-191,226-228` | 两行时间戳相等（同一毫秒的记录时间，如并行工具行/同批回放）时 `at >= known` 对所有并列最大值都为 true：同一 pass 的 `noteRender` 返回多个 `true`，且后续每次重渲染仍是 `true`（实测 `[true,true] → [true,true] → [true,true]`）；若其中一行是残留 `running`，`shouldPulse("running", {newest:true,fresh:false}) === true`，会一直保持 newest 扫光，直到有严格更大的时间戳或服务端在 replay/turn-end 把 running 收成 canceled。与模块注释“only the newest row does”不一致 | 实测（编译模块直接驱动 `noteRender` 等纯函数） | 基线已有 |
| CM-08 | P3 | `paseo-plugin/client/sweep-geometry.ts:65-72`；`paseo-plugin/client/sweep-native.tsx:55-75` | `quantize()` 注释称“按 `steps(48, end)` 的方式量化”，实现是 `Math.round(progress*steps)/steps`（CSS `steps(48,end)` 为 floor 语义，切换点差半步≈20.8ms）；且 `quantize` / `SWEEP_STEPS` 在原生动画里完全未接线——`sweep-native` 用 `Easing.linear` 连续运动。48 步量化实际是死代码，“与 DSH 同效”的台阶声明没有落到 native 实现 | 源码依据 + 离线 harness 阅读（`sweep-check.cjs:100-106` 只断言常量与取整自身，不验证 floor 语义/接线） | 基线已有 |
| CM-09 | P3 | `paseo-plugin/client/sweep-native.tsx:46-75` | 原生端未读取 reduced-motion（无 `AccessibilityInfo` 等），系统开启“减少动态效果”时 `Animated.loop` 仍无限运行；Web 端已由 `shimmer-css.ts:115-119` 的 `prefers-reduced-motion` 处理 | 源码依据；真机未验证 | 基线已有（上一轮 E4 已指出） |
| CM-10 | P3 | `paseo-plugin/client/thinking-text.ts:56-59`；`paseo-plugin/client/inline-thinking.tsx:206` | DSH 展示 reasoning 前会经过 `reasoningText()`：以 `<signature>` 开头的文本被隐藏/剥掉签名段；本插件直接把服务端 `item.text` 原样预览与展开，若 provider 返回带 `<signature>` 的 reasoning，会显示签名包裹内容而不是 DSH 的干净文本 | 源码对照（已装 `dsh-client-ui-chat/lib/client.js` 的 reasoning-text 段）；本机路由是否产生此类块未验证 | 基线已有 |
| CM-11 | P3 | `paseo-plugin/client/locale.ts:16-21,28-34` | 注释断言“`PluginClientContext` 没有 locale 服务、宿主 i18n 不是插件导出”，与已装 `@getpaseo/plugin@0.14.0` 契约矛盾：`PluginClientContext.i18n`（`dist/client/contracts.d.ts:147`）、`PluginI18n.locale`（`dist/client/translations.d.ts:14`）、`useTranslation`（`dist/client/index.d.ts:25`）均存在；同时“今天 DSH_PASEO_LANG=en 只本地化服务端、不本地化这些行”已被 metadata 中继部分推翻（tool_call 行会跟随）。注释误导架构判断，掩盖了用公开 i18n 收敛此问题的路径 | 文档/类型依据（已装包 d.ts 实读） | 基线已有（上一轮 E3 已指出） |
| CM-12 | P3 | `paseo-plugin/client/locale.ts:643-654`；对照 `paseo-plugin/server/locale.ts:32-45` | 同一条“DSH_PASEO_LANG → LC_ALL → LC_MESSAGES → LANG”解析链存在两份独立实现；`client/locale.ts` 的 `resolveLocale` 在生产代码中无消费者（只有 `harness/locale-check.cjs` 用），而该 harness 只按手写期望值断言 client 实现，不 import/断言 server 实现。两侧任一处优先顺序或 trim 语义漂移都不会变红，注释“identical to the server's chain”无跨模块证据 | 源码依据（grep 调用点 + harness 阅读） | 基线已有 |
| CM-13 | P3 | `paseo-plugin/client/shimmer-css.ts:10-16` | 注释称“Everything between the ‘verbatim’ markers is copied from DSH's TextShimmer.module.css”，但文件中并不存在任何 verbatim marker；实际与已装 DSH web CSS（`dsh-web-frontend/dist/assets/index-BNyAYEM7.css`）相比还有额外改动：颜色变量改为自有 `--dsh-paseo-shimmer`、装饰副本由 `::after + attr(data-shimmer-text)` 改为真实子节点 + `aria-hidden`、新增 `color: inherit !important` 等。“verbatim”说法不可核，后续维护者无法判断哪些行允许漂移 | 源码对照（DSH 官方 CSS 原文已提取比对） | 基线已有 |

## 3. 关键发现说明

### CM-01（P2，C2 未修复）

- 代码路径：`paseo-plugin/client/inline-thinking.tsx:56-68`。
- 复现（本机实测，编译真实 `InlineThinking`，最小 hooks dispatcher，非真机）：

```
{"text":"a","phase":"streaming","shimmerActive":true}
{"text":"ab","phase":"complete","shimmerActive":true}   ← 增长与 complete 同帧：未落定
{"text":"ab","phase":"complete","shimmerActive":true}   ← 同值重渲染不再触发 effect：仍不落定
{"text":"ab","phase":"streaming","shimmerActive":true}
{"text":"ab","phase":"complete","shimmerActive":false}  ← 只有再发生一次 phase 变化才落定
```

- 影响：该行保持“仍在生成”的扫光与 tail preview；native 上是持续运行的 `Animated.loop`，web 上是持续 CSS 动画，直到另一次依赖变化或卸载。上一轮 C2 的建议（明确终态/短稳定窗口，不依赖额外帧）未落地。
- 修复方向（沿用上一轮）：在增长分支里优先处理 `phase === "complete"`（同帧增长也落定），或用带 cleanup 的短稳定窗口；同时保留防 phase 闪烁与卸载清理。补一个“增长+complete 同帧”的组件状态回归。

### CM-07（P3，newest 并列时间戳）

- 实测（编译 `newest.ts` 纯函数）：

```
A1 first pass [ false ]
A2 two rows same ts [ true, true ]
A3 re-render both [ true, true ]
A4 rerender again [ true, true ]
A5 stale running pulses? true
B1 first [ false ]
B2 two rows (distinct ts) [ true, true ]
B3 re-render [ false, true ]        ← 不同时间戳只允许一帧重叠，之后收敛
```

- 说明：模块针对“整屏闪烁”和“短命令不闪”两端都做了防护，但 `at >= known` 在时间戳并列时无法选出唯一最新行。服务端 replay 的 `settleRunningTools()`（`server/timeline.ts:855`，调用点 `server/session.ts:1103,2960`）会收掉遗留 running 行，所以主要残余影响是并行工具行同帧多个 `newest`、极端情况下残留 running 行持续扫光。若要严格“只有一行最新”，需要并列时的稳定次序（如 commit seq）而不仅是时间戳。

### CM-02（P3，原型链查表）

- 表是普通对象字面量，`agentMessageEvents[event]` 对 `Object.prototype` 继承键会命中。实测 `agentMessageLabel("toString")` 返回 `function`；React 会把函数/对象子节点当非法 children 抛出。修复：查表前 `Object.hasOwn(text.agentMessageEvents, event)`，或用 `Object.create(null)` / `Map`。
- **跨文件同类问题（notify task-10）**：`paseo-plugin/client/tool-call-data.ts:922` 的 `toolLabel()` 同样直接 `localeText().toolLabels[name]`，实测 `toolLabel("constructor")` / `toolLabel("toString")` 也返回函数；虽然真实工具名通常来自受控 catalog，但这属于同一类防御缺口，建议由 tool-call lane 一并评估。

### CM-03 / CM-04（P3，locale 中继与生命周期清理）

- CM-03 的具体链路：`index.client.tsx:68` 在每次 tool_call transform 时无条件 `setLocale(localeFromMetadata(item.metadata))`；`locale.ts:666-668` 的设计是“不可识别/空值即清空 relay”。已装 0.14.0 宿主 bundle 的 `projectPluginTimelineItems` 内层投影只保留 `callId/name/status/error/detail/metadata`（丢弃 `agentMessage`，metadata 仅在 truthy 时携带），而 reasoning/assistant 项在 protocol 里根本没有 metadata 字段（`@getpaseo/protocol/dist/agent-types.d.ts:309-330`）。因此：非 tool_call 行只能靠“最近一次 tool_call 的 relay”生效；任何无 metadata 的行都会把 relay 清回默认 `zh-CN`。副作用是英文 daemon 下首轮思考行/助手行必为中文，且 agent_message 行之后出现语言回跳。
- CM-04 的 cleanup：`contributeStreamStats` 内 `client.addTimelineRenderer(...)` 的返回值未被保存；入口对 4 个 `addTimeline*` 注册同样未保存返回值。按已装契约每个注册都返回 `PluginCleanup`，入口返回的 cleanup 只覆盖 `contributeStreamStats` 的空函数与 jobs pill 的真实清理。建议所有注册统一收集 cleanup 并在返回函数中逆序释放。

### CM-05 / CM-06（P3，流式统计行）

- 服务端 `#emitStreamStats` 的口径本身是 DSH 的 decode window（`assistant/message` 事件时间 − 首个生成 token 时间，`server/session.ts:2280-2334`），按 `outputTokens`/span 计算并做 3000 tok/s 上限保护，这部分没有发现口径错误；客户端只是展示层。
- 客户端问题：① 所有可见文案硬编码中文，未进 `locale.ts`（两种语言表覆盖不到它）；② “Tokens”明细缺 cacheWrite，`sessionTokens` 字段闲置，导致“总量”口径在 UI 不可见；③ `Math.round(tokensPerSecond)` 对 <0.5 tok/s 会显示 `0 tok/s`（窄显示问题，未单列 ID）。

## 4. 已验证通过项（正向证据）

| 项目 | 结果 |
|---|---|
| locale 解析链（client） | `locale-check.cjs` 263 passed / 0 failed；`DSH_PASEO_LANG` 优先、空值回落、LC_ALL→LC_MESSAGES→LANG 顺序、`zh*`→zh-CN 均符合 |
| 两种语言表结构与覆盖 | `allText()` en/zh 顶层键一致；`toolLabels` 92、`paseoMcpLabels` 63、`agentMessageEvents` 5、`bodyLabels` 9 键集完全相等；每个值非空；jobs 表与 `JOB_STATUSES` 完全一致；英文列非中文复制 |
| DSH 自有工具标签保真 | 与已装 DSH 0.2.1-rc.5 `dsh-client-ui-tool` 的 `TOOL_TITLE_KEYS`/`TOOL_VARIANTS` + `dsh-client-ui-conversation` zh/en 表逐条对比：55 个 DSH 自有工具 0 偏差；`run_code`/`skill`/`present` 等特殊项与表内注释相符 |
| Paseo MCP 标签 | 63 项覆盖 0.14 官方 catalog + `speak`；`locale-check` 对官方 label 逐字断言通过 |
| 未知事件兜底 | `agent-message-check.cjs` 111 passed / 0 failed（含未知事件 `bogus` → `agentMessageFallback`、host 投影缺 `agentMessage` 的 fallback 分支）；CM-02 仅原型键边界失效 |
| 内嵌 PNG | `paseo-mark.ts`、`inline-thinking.tsx` 的 THINK_ICON 均 64×64 RGBA，解码后仅纯白与全透明两种 RGB/alpha（实读 IHDR/IDAT），与“4x、white-on-transparent”声明一致 |
| 扫光几何/关键帧 | `sweep-check.cjs` 25 passed；与 DSH 官方 `dsh-web-frontend/dist/assets/index-BNyAYEM7.css` 比对：105° 渐变 0/40%/60%/100%、1.5s、delay .3s、`steps(48,end)`、`-100%→100% @66.6667%` 保持、reduced-motion 规则一致（web 分支） |
| 思考预览规则 | `thinking-check.cjs` 37 passed；`firstLine` / `latestCompletedParagraphFirstLine` 与已装 `dsh-client-ui-chat/lib/client.js` 原文逐字一致 |
| newest 基本行为 | `newest-check.cjs` 36 passed；首 pass 不闪、窗口 6s、批量 ≥5、短历史 replay 防护、timer 清理均符合设计 |
| 宿主 agentMessage 投影 | 已装 0.14.0 web bundle 的 `projectPluginTimelineItems` 确实丢弃 `agentMessage`（只拷贝 callId/name/status/error/detail/metadata），`index.client.tsx:85-87` 的 fallback 仍是必要且当前正确 |
| 生命周期 | `newest.ts:264-271` 的 pulse 定时器、`sweep-native.tsx:69-74` 的 delay/loop 均有 clear/stop；未发现未清理的 interval/订阅 |
| 安全面 | 无密钥/路径拼接/网络请求；仅 `text-shimmer.tsx:56-64` 读取 localStorage 调试开关，异常已捕获 |
| 本 lane 新改动 | 相对基线唯一生产改动是 `locale.ts` 的 jobs 文案（`settledLabel`、`unavailable` 等 +21 行）：两语言键/值非空、与 `JOB_STATUSES`/jobs-pill 使用点一致（`locale-check` 断言全过），未发现新增问题 |

## 5. 健康度评分

| 维度 | 评分（1-5） | 说明 |
|---|---:|---|
| 正确性 | 3 | 纯函数与视觉数值基本正确；C2 落定缺陷 + newest 并列时间戳 + 原型键兜底失效拉低 |
| 健壮性 | 3 | 定时器清理到位，但模块级可变 locale、cleanup 丢弃、原型链查表在异常输入下不设防 |
| 可维护性 | 3 | 注释详尽但存在过时/不可核的“verbatim”“无 locale 服务”表述；解析链双份实现；quantize 死代码 |
| 契约一致性 | 3 | renderer schema、phase、agentMessage 投影等契约核对通过；但 cleanup 契约未履行、stream-stats 字段与 locale 资源表不一致 |
| 性能 | 4 | tail-only 窗口化、native driver、纯函数、agent 状态上限 200；仅 native 8 份装饰副本属已知成本 |
| 安全 | 5 | 本组文件无外部输入执行、无凭据、无注入面 |
| 测试覆盖 | 3 | locale/newest/thinking/sweep/agent-message 五项离线门全绿（合计 472 条断言）；但缺 C2 组件状态回归、native 动画/reduced-motion、shimmer CSS 一致性、cleanup 行为测试 |

**总分：24 / 35（约 3.4 / 5）**

**一句话总评：** 功能与视觉还原扎实、离线回归全绿，但思考末帧落定（C2）仍未修复，locale 中继/生命周期清理/未知输入兜底存在一批窄口径欠账，属于“可发布但需按优先级补课”的状态。

**Top 问题（≤5）：**
1. **CM-01（P2）** 思考末帧“增长+complete 同帧”不落定，扫光持续（C2 未修复，已实测复现）。
2. **CM-03（P3）** locale 中继只覆盖 tool_call、会被无 metadata 行重置，非中文 daemon 下行语言混杂/回跳。
3. **CM-02（P3）** `agentMessageLabel` 原型键返回函数/对象，防御分支会抛渲染错误（tool-call-data 有同类问题）。
4. **CM-04（P3）** 入口 4 个 timeline 注册与 stream-stats 的 cleanup 被丢弃，reload 后可能残留旧注册。
5. **CM-05/06（P3）** 统计行硬编码中文、缺 cacheWrite / `sessionTokens` 不显示，口径与本地化都不完整。

**建议优先级：** ① 先修 CM-01 并补“增长+complete 同帧”的组件状态回归（唯一 P2）；② 再统一 CM-04 的 cleanup 收集与 CM-03 的 locale 接线（可结合已装 0.14 的公开 `i18n`/`useTranslation` 收敛，但需按 `>=0.9.2` 做 feature-detect）；③ 其余 CM-02/05/06/07/08/09/10/11/12/13 作为维护批次处理，其中 CM-02 优先。

**是否有阻断性健康问题：否。**

## 6. 未验证项

- 真机 iOS/Android：思考行动画终态、动态字体/字重、reduced-motion、8 层装饰副本的帧率与内存。
- CM-03 的运行时表现：未在真实“英文 daemon + agent_message 行 + 多 host”环境观测语言回跳（机制已从宿主 bundle 投影 + 插件代码推出）。
- CM-10：本机路由是否真的产生 `<signature>` 包裹的 reasoning 块未验证。
- CM-04：Paseo 插件 reload 时宿主是否还有统一清理、丢弃 cleanup 的实际可见后果未验证。
- 真实模型回合下的 stream-stats 展示（英文环境/低速模型）未跑（任务约定不跑真实模型）。
- `text-shimmer` 的 `forceNativeSweep` 只在 Web 调试路径使用，未在浏览器实测。
