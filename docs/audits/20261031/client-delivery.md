# 客户端与交付链审查（提交主编复核）

基线：`9298c28`，2026-10-31。范围为 `paseo-plugin/client/`、客户端入口、安装与发布文件、doctor/probe、`local-patches/`。本报告只记录审查与方案，没有修改产品代码、配置、Git 状态或正式运行进程，没有运行补丁 apply/revert，没有调用真实模型。复现全部使用临时目录、合成事件或 mock fetch。

本轮确认了 5 个 P2 缺陷，其中 4 个针对当前可达的代码路径、1 个针对维护者补丁重建的特定组合。另有 CI/兼容矩阵、轮询规模与移动端验收等工程方向。这里没有证据把这些结论扩大成“当前服务已故障”或“移动端一定不可用”。

## 1. 覆盖范围

以下生产模块均已逐模块检查。大块图标 PNG 的字节不做视觉审核，只核对其已是 PNG、无需原生 SVG 支持；自动生成的 package-lock 检查清单/版本/依赖一致性，不将逐条传递依赖视为源码审查。

| 区域 | 文件 | 检查重点 |
|---|---|---|
| 客户端入口与合同 | `paseo-plugin/index.client.tsx`、`client/agent-message.ts` | transformer 范围、字段丢失、schema、宿主原生 fallback |
| 工具行 | `client/tool-call-data.ts`、`client/tool-call.tsx`、`client/tokens.ts`、`client/paseo-mark.ts` | 错误信息、计划内容/实际结果、结构化 read/search/diff/web、LCS 限界、展开与复制、主题 |
| 思考与动画 | `client/inline-thinking.tsx`、`client/thinking-text.ts`、`client/newest.ts`、`client/text-shimmer.tsx`、`client/shimmer-css.ts`、`client/sweep-geometry.ts`、`client/sweep-native.tsx` | 流式落定、脉冲判定、清理、DOM 平台隔离、原生成本 |
| 后台任务 | `client/jobs-pill.tsx`、`client/jobs-popover-layout.ts`、`client/jobs-spinner.tsx`、`client/poll-sequence.ts`，以及接口 `shared/jobs.ts` | 全 agent 订阅、序号/entry 防过期、in-flight、权限拒绝、清理、compact 布局 |
| 本地化与统计 | `client/locale.ts`、`client/stream-stats.tsx` | 默认语言、metadata relay、公开 i18n 退出机会、统计行语言 |
| 自检与探测 | `lib/doctor.mjs`、`lib/probe-provider.mjs`、`bin/paseo-dsh.mjs`、`tools/probe-provider.mjs` | 有效配置判据、退出码、错误分类、凭据脱敏 |
| 安装与产物 | `install.sh`、`templates/cordis.patch.yml`、`scripts/generate-bridge-assets.mjs`、`package.json`、`package-lock.json`、`tsconfig.json`、`paseo-plugin.json` | 唯一安装来源、profile、文件清单、版本约束、内嵌桥、脚本边界 |
| CI | `.github/workflows/sync-upstream.yml` | 触发时机、测试覆盖、自动合并发布边界 |
| 可选宿主补丁 | `local-patches/apply-rewind-history-truncation.mjs`、`check-rewind-patch.mjs`、`startup-patch-hook.cjs`、`README.md`、`UPGRADE.md` | 查/改边界、幂等、失败分级、原地重建范围、备份、上游退役判据 |

复核了 `AGENTS.md`、`ADOPTION.md` 的架构与约束、FIELD-NOTES 中客户端/静默降级/补丁相关历史，以及 2026-10-20 和 2026-10-29 审查的相关裁决。没有把明确接受的首行 locale fallback、短历史脉冲、HTTP/MCP 上游缺口等再报为新故障。

## 2. 已确认问题

### C1 / P2：写入、编辑失败时，客户端丢失实际错误原因

- **位置**：`paseo-plugin/client/tool-call-data.ts:1231-1245` 接收 `error`，`:1259` 只读失败状态；`:1296-1317` 取请求中的 write 内容或 edit diff；`:1467-1499` 输出合同没有错误字段。`index.client.tsx:112-188` 的 schema 同样没有错误字段。`client/tool-call.tsx:813-816` 只用图标传达失败，展开分支没有额外错误区域。
- **触发**：DSH `write` 或 `edit` 返回 `isError: true`，例如无写权限、匹配内容不存在。服务端 `TimelineBuilder` 正确把失败原因放在 `error.message`（`server/timeline.ts:1138`），但 write/edit detail 本身是请求内容，没装输出错误。
- **结果**：失败状态仍是 `failed`，图标仍会变红；不是“假报成功”。丢失的是失败原因，展开处仍显示原计划写入的内容/差异。用户无法从这行判断为何失败。
- **隔离证据**：`probe-failed-tool-render.cjs` 驱动真实编译后的 `TimelineBuilder → toolCallData`。write 和 edit 的 `serverError.message = AUDIT_ERROR_PERMISSION_DENIED`，但 `errorSurvives=false`。同形 bash 作为正对照，错误通过 output 保留，`errorSurvives=true`。无工具真正执行。
- **最小修法**：给渲染数据加独立、明确的错误文本字段，按宿主现有错误格式化规则转换 `unknown`；失败时展示错误区域，保留请求内容用于诊断，但不能把它当成实际写入结果。无法可靠表示错误时可返回 `undefined` 交宿主原生工具行渲染。不要仅把错误盖进 diff/body，避免混淆两类信息。
- **验收**：真实 TimelineBuilder 产生的失败 write/edit/bash 三种路径；错误仅在顶层的原生 tool_call；对象/字符串错误；成功路径无错误块；schema 传输后错误仍在。跑 `tool-call-check`、`agent-message-check`、`style-check`、真实 tsc，补一次移动端失败卡可读性检查。
- **历史关系**：历史覆盖了失败标志与图标，没有覆盖错误原因跨客户端 transformer 保真。现有 `tool-call-check.cjs:252-254` 只检查 `failed/status`，这就是本例穿过既有回归的原因。

### C2 / P2：思考末帧同时增长并标 complete 时，扫光状态不能落定

- **位置**：`client/inline-thinking.tsx:56-67` 的 `useGrowing()`。
- **触发**：上一次为 `{text:'a', phase:'streaming'}`，最终同一次更新为 `{text:'ab', phase:'complete'}`。这是流式最后快照补齐文本的正常形状。
- **根因**：effect 发现长度增长便 `setGrowing(true); return`，跳过 complete；依赖只有 `[text, phase]`，后续同值重渲染不会再执行 effect。
- **结果**：该行保持“仍在生成”的扫光与 tail preview，直到发生另一次依赖变化或卸载；这也会让原生动画持续运行。不能从此推断所有真实 DSH 回合都触发，具体取决于宿主最终快照时序。
- **隔离证据**：`probe-thinking-settle.cjs` 执行真实编译组件，使用确定性的最小 hooks dispatcher，输出 `a/streaming=true → ab/complete=true → ab/complete=true`；再制造 phase 变化，complete 才变 false。该证据证明 hook 依赖问题，不冒充真实 React Native 设备验收。
- **最小修法**：先明确宿主 complete 是否可靠终态。若仍有 FIELD-NOTES §26 的 phase 闪烁，使用有清理的短稳定窗口/明确 turn 终态，而不是要求必须再来一帧；如果当前宿主 complete 已可作为终态，优先关闭。避免用无限定时刷新掩盖状态机错误。
- **验收**：增长+complete 同帧、complete 后无新帧、取消、真正的连续增长、旧回放不闪、卸载定时器清理；保留原防抖场景。现有 `thinking-check` 主要验证纯文本与源码接线，需加组件状态生命周期证据。

### D1 / P2：doctor 的 YAML 语义校验仍可把无效配置报成全绿

- **位置**：`lib/doctor.mjs:442-444` 解析 YAML 后丢弃结果；`:463-467` 从 default-model 区块一直扫描到 EOF；`:491-501` 从 refs 一直扫描到 EOF；所谓非空仅检查原始文本 `\S`。
- **触发与复现**：以下六类均在真实 `runDoctor()` 上输出 `All checks passed`、exit 0：
  1. `provider: ""` 和 `model: ""`；
  2. `agent-default-model.config` 为空，但后续无关条目含 provider/model；
  3. `refs.EXAMPLE_KEY: ""`；
  4. `refs.EXAMPLE_KEY: # no value`；
  5. `refs` 已结束，后面的其它顶层区块含同名 key；
  6. `agent-default-model` 被 `disabled: true` 禁用。
- **对照有效性**：`probe-doctor-extra.mjs` 最终版本使用模板真实分层：独立 `llm-pi-ai` 条目配置 provider/api/baseURL/models，独立 `agent-default-model` 条目选择 route/model，再给结构合法的 refs。正对照也 exit 0。endpoint 与凭据为合成数据，未验证网络连通，也不把它称为真实可用账号。
- **影响**：直接违背 doctor 的安装完整性保证；根据“doctor 全绿再启动”的流程，用户仍会装到缺路由/缺凭据的配置。不是外部服务是否接受 key 的问题，纯本地语义已经错误。
- **最小修法**：保留解析结果，按顶层 Cordis entries 的 id/name/config 读取路由；解析凭据后按真实 refs 对象读取，检查字符串非空/禁用项/路由引用关系。支持 DSH 合法的组合与配置来源时应明确查询边界，不能靠跨块 regex 猜。结构无法判断时清楚输出未验证，不宣称全绿。
- **验收**：把六个变体及模板结构正对照纳入 doctor-check；再覆盖 quoted id、行内注释、YAML alias/不同合法顺序，按真实 DSH 支持范围裁决。保留“不回显 key 值”。
- **历史关系**：是 10-20 空值、10-29 发布安装 YAML 检查修复后的残余同类缺陷，不把六种输入拆成六个独立问题。现有 doctor-check 的“完整配置”示例把 providers 放在 default-model.config 下，也应改成模板结构，避免控制组自身不代表真实配置。

### D2 / P2：probe 把鉴权/额度类 4xx 当成模型能力拒绝

- **位置**：`lib/probe-provider.mjs:144-147`，以及 `:314-318`、`:344-347`。
- **触发**：baseline 请求先成功，随后探测 developer/reasoning 时收到 401/402/403，例如凭据失效、额度耗尽、路由策略或网关临时拒绝。代码只排除 408/429，其他 4xx 都被作为能力结论。
- **隔离证据**：`probe-capability-auth.mjs` mock fetch 的第一帧 200、后七帧分别 401/402/403：每组都 exit 0，建议 `supportsDeveloperRole: false` 与 `reasoningEfforts: false`。429 正对照正确为 unknown、exit 1。
- **影响**：用户可能永久删掉本来支持的思考档位，故障从临时鉴权/额度问题转成静默配置降级。
- **最小修法**：鉴权/支付/权限状态直接归为运行环境故障，停止或标 unknown；参数拒绝尽量要求错误体指向本次被探测的参数，必要时再次跑无参数 baseline 作对照。不要仅收紧成另一个宽泛 HTTP 状态表。
- **验收**：baseline 成功后 token/额度改变、可用 baseline + 参数明确拒绝、429/5xx/HTML/200+error 原有用例；多模型时分别输出每个模型是否有可靠结论。
- **历史关系**：已有 429/传输错误防降级思路，但未覆盖认证/支付/权限故障，属于错误分类遗漏。

### L1 / P2（窄触发）：宿主补丁 stale 重建会覆盖本补丁之外的尾部语句

- **位置**：`local-patches/apply-rewind-history-truncation.mjs:1332-1360` 的 `locateRewindCallRegion()`，`:1372-1395` 的 `rebuildRewindCall()`，由 stale path `:1675` 附近调用。
- **触发边界**：存量文件已有本补丁，当前补丁因 METHOD/CALL 改版而需 stale 重建；与此同时 `revert()` 的 `await this.bridge.revert(...)` 后存在其它上游/本地逻辑。不是当前正常 npm 升级必现；npm 全量替换为干净文件后走的是 clean 分支。
- **根因**：替换区块是 bridge 调用结束至整个 revert 方法最后的闭括号，未验证这段尾部只含自己的 CALL。
- **隔离证据**：`probe-patch-tail.cjs` 从真实源码 AST 取 `locateRewindCallRegion/rebuildRewindCall` 等纯字符串函数，不导入/运行 apply 或文件写入入口。合成 fixture 在 CALL 后追加 `this.upstreamCleanupAfterRewind();`，重建后该句消失，而结果仍能解析。
- **影响**：与 README 的“只替换目标块，文件里别的东西一律不碰”不一致；语法与 marker 检查可保持绿，语义却已被删除。
- **最小修法**：按受控 marker/AST 精确限定自有 CALL；缺 marker 或发现额外语句时 fail closed，并保留原文件。不要试图猜其它尾部语句是否可以删除。
- **验收**：CALL 前后其它逻辑保留；无额外代码的旧 CALL 可重建；多 marker/嵌套/字符串花括号拒绝不写；在临时副本上做语义对照。主审此次没有执行补丁 apply/revert。

## 3. 工程与产品方向（不要当成已经发生的故障）

### E1：将同步上游与代码验收拆成独立工作流

- **事实**：唯一 workflow 只在 schedule/workflow_dispatch 触发（`sync-upstream.yml:8-12`）；上游已是 ancestor 时直接退出（`:51-54`），不测试本地新提交；合并成功只跑约十几个门然后 push main（`:59-87`）。因此普通 push/PR 的 P003、jobs 或其它本地改动不保证触发 CI。
- **差距**：CI 没跑 multi-session/concurrent-open、MCP 注入/stdio、权限、jobs 生命周期等已有离线门。不能把“Git 无冲突”视为协议兼容，也不能把目前 GitHub 上 workflow 是否启用当成已确认事实，本次只核仓库配置。
- **建议**：新增 push/PR 的统一离线门；由版本/模块矩阵决定 required checks。同步机器人只维护候选 PR，合并应在全部 gate 后执行。生产真实模型/设备门仍与自动离线门分开。不要把真 profile/token 测试强塞到免费 runner，也不要让 provider 核心变更只靠 style/静态断言过关。

### E2：jobs polling 做总量预算与完整列表核验

- **事实**：`jobs-pill.tsx:61` 每 4 秒一次，每个登记的非 closed DSH agent 都有 timer（`:442-513`），与是否当前可见、是否有 job 无关。已有 in-flight/sequence/entry/lifetime 防线是有效设计，应保留。
- **推导**：N 个登记 agent 大约是 N/4 次 RPC 每秒，多个客户端再乘客户端数；这是数学上限估算，不是测得的延迟/耗电故障。
- **列表边界**：客户端只处理 snapshot.entries（`:545-548`），忽略 pageInfo；已安装 0.14.0 server `session.js:4175` 默认 page limit 为 200。若存在更多可见 agents，首个 snapshot 不代表全集；后续 agent_update 可能补充，但不保证所有静止 agent 都补到。应以当前 agent 必覆盖/分页契约复核，而不是把 200 硬改成无限。
- **权限边界**：拒绝后 clear timer 是正确的；但任意 upsert 都会重新开启被禁用 entry（`:462-472`），而 reconnect 的 snapshot 本来已经 removeAll/re-register。普通状态 upsert 不能证明权限变了。可只在连接代次/权限改变时重试。
- **建议**：活跃或可见 agent 快轮询，其余退避；聚合只读 RPC、服务器缓存/事件触发 dirty、AppState 后台暂停或降频；为总并发与队列设置预算。目标先通过 10/100/200 agents、多客户端测量，再定时间间隔。
- **测试缺口**：`jobs-poll-check` 验证序号工具，`jobs-popover-check` 检查布局和接线；需要对真实 `contributeJobsPill` 注册/拒绝/重连/清理/200+目录场景做集成级控制器测试。

### E3：使用公开 i18n，让旧 metadata workaround 有退出路径

- **事实**：`client/locale.ts:14-21` 仍描述“插件 API 无 locale 服务”；已装 `@getpaseo/plugin@0.14.0` 的 `client/contracts.d.ts:148` 已有 `readonly i18n`。首个 tool metadata 决定语言是旧约束下的选择，不再适合当永久架构事实。
- **建议**：新宿主从公开 i18n/translation 接口取得用户语言，保留用户明确 DSH_PASEO_LANG 覆盖语义；旧宿主 feature-detect 后继续 metadata fallback。`stream-stats.tsx` 的所有可见文字仍写死中文，也应纳入同一资源表。
- **注意**：不能未经运行矩阵就删除旧模块导入/直接提升最低版本；这应是明确的兼容策略决定。
- **发行物边界**：抓取的上游 `reference.md:155-157` 仍把 runtime translations 标为 Unreleased API、引入版号待定。已安装 plugin 包的类型与实现存在，不等于每个同版本移动 App 都已经暴露运行时能力；迁移前须对 daemon、Web、iOS、Android 对应发行物核验。此处是可复用方向，不是已完成的兼容承诺。

### E4：移动端验收要从“数值一致”升级到“交互与状态一致”

- **事实**：`paseo-plugin/OVERVIEW.md:11` 明确 native iOS/Android 未测试。当前主要回归是协议、TS、纯函数与 JSX 接线，不能证明真机字体/手势/布局/后台恢复。
- **代码层优点**：主体使用 RN primitives；图标为 PNG；Web 动画与原生 Animated 有分支；多数清理有 cleanup；native sweep 使用 8 个装饰副本，避免 per-frame React 重渲染。
- **需要量测**：390px 紧凑视图、动态字体、两种主题、长路径/长 MCP 标签、失败 write/edit、长 diff 展开、思考末帧、jobs sheet、切后台/回前台与弱网重连。
- **a11y 差异**：Web shimmer 已处理 prefers-reduced-motion；native sweep 与 jobs spinner 未读取 reduced motion。建议使用宿主公开能力或 RN AccessibilityInfo，停动画时保留明确静态状态。
- **结构建议**：保留用户要的 DSH 视觉，但减少无差别接管宿主工具行。对未知/无法无损翻译的行返回 undefined；长期将通用行留给宿主或作为可选渲染模式。C1 表明整个工具行重画的成本不仅是 CSS，也包括错误/元数据的新字段。

### E5：安装/自检保留单一配置解析事实源

- doctor 与 bootstrap 对 DSH_HOME 的展开不一致：bootstrap 的 `dshHome()` 按 DSH 规则处理空白与 `~`，doctor `:296` 是直接 join 原始 env；同一合法配置可能查到不同目录。可归入诊断一致性工作。
- install.sh 在 `paseo plugin install` 后又直接覆写 `config.plugins['dsh-paseo']`（`:230-234`），增加与宿主新配置 schema 分叉的维护面。优先使用官方安装路径；将历史 installer 降为明确 legacy 路径，或复用宿主公开配置操作，不必持续维护两个注册实现。
- package-lock 根依赖与 package.json 一致；files 指向的路径全部存在，shared/ 已列入产物。没有证据说“发布物漏 shared”或“必需安装 RN 到生产”。
- `ADOPTION.md:383` 仍说桥每会话启动、改桥立即生效，与当前一连接共享进程/内嵌桥语义不一致。更新操作文档，避免不必要重启与“已换盘=已生效”的误判。
- `OVERVIEW.md:9` 仍说图像只支持 https、file:// 本地图片无法显示，与已经实现的 hostImagePath + Markdown 图片路径相矛盾。发布包 README 的安装引导仍保留“npm 最新是 0.2.9”的 10-20 提醒，应清楚区分历史记录与当前安装建议。
- `local-patches/UPGRADE.md:35-57` 将 restart-with-wake/selfwake 列为必须步骤，但这两个 helper 不在仓库 5 个 local-patches 文件里；对复用者要提供其来源或标成作者环境的可选做法。未读取或更改用户自唤醒配置。

## 4. 主动驳回与保留的边界

1. **“devDependencies 是 0.14，所以 >=0.9.2 必错”不成立。** 从 npm 原包只读检查 0.9.2、0.11.4、0.12.0、0.13.0；0.9.2 已有 addComposerPill、Popover Content、client.paseo、agents.list subscribe、ExternalLink 等本客户端依赖表面。这里不证明全插件支持 0.9.2，但足以驳回只凭 devDependency 判不兼容。需要真实多版本矩阵而非猜测。
2. **“iOS 用了 SVG Image 必坏”不成立。** 两个内嵌图标均已经栅格化成 PNG，不作为问题。
3. **“jobs 没有 request cancellation 就必泄漏”证据不足。** 既有 lifetime abort、in-flight 与 entry/sequence 防过期；服务端也有 bounded read。应测量挂起行为再加机制。
4. **“local-patches 的所有失败都会报绿”不成立。** runTarget/reportCombined 已单列 degraded，整体 exit 3；apply 有原子写/语法回滚/入口白名单。L1 是替换范围窄触发问题，不否定已有这些防线。
5. **“没有自动合并 0.2.17 就缺核心能力”不成立。** 上游这次主要是 Web footer 布局；原生客户端不享有自动测量贴靠。本机 type 修正/服务端状态必须保留，不能把这次视觉更新当优先级最高事项。

## 5. 推荐执行次序

1. **先修语义保真**：C1 失败原因、C2 最终状态、D1 自检语义、D2 探测错误分类；每项增加失败前/修复后与正常对照的最小回归。
2. **再收紧维护护栏**：L1 补丁区块守卫、统一 CI、精确版本矩阵、文档生效路径；保持补丁可选，逐项退出旧 workaround。
3. **随后做移动端闭环**：把真机问题与纯 Web 视觉改动分离，native 首先验可读/可点/可恢复/正确终态，然后再优化动画与字距。
4. **最后根据量测优化 jobs 与长内容**：总 RPC/内存/帧率预算，按真实瓶颈引入聚合、退避、虚拟化；不先改结构再寻找收益。

## 6. 证据文件

本目录中的 probe 文件仅用于此次审查，未加入产品 harness。主编可将必要者改成仓库回归；避免把 mock/纯字符串证明误写成真机验收。

| 文件 | 证明 |
|---|---|
| `probe-failed-tool-render.cjs` | 真实 server timeline 到客户端 mapper 的失败原因丢失，bash 对照 |
| `probe-thinking-settle.cjs` | 真实组件的 hook 依赖/状态落定，最小 dispatcher |
| `probe-doctor-extra.mjs`、`probe-doctor-extra.jsonl` | 模板结构控制组与六种无效配置假绿 |
| `probe-capability-auth.mjs` | mock HTTP 鉴权/支付/权限被当成能力拒绝，429 对照 |
| `probe-patch-tail.cjs` | 纯内存 stale CALL 替换会删除其它尾部代码，未运行 apply |
| `plugin-0.9.2.tgz` 等、`client-0.9.2.tgz` 等 | npm 公开发布原包，供兼容 API 表面对照 |

主编的整套离线测试结果另行汇总。本分工未重复跑全集，未声称任何 native 真机通过。
