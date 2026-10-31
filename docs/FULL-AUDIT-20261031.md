# 全项目审查与上游调研（2026-10-31）

代码基线：`9298c28`，分支 `main`；开始时工作区干净。本次交付审查、证据与实施方案，未修产品、未合并上游、未升级或部署。

配套文档：[架构选择与优化路线](ARCHITECTURE-ROADMAP-20261031.md)。分区详查及复现材料位于 [audits/20261031](audits/20261031/README.md)。

## 1. 结论

**插件这种接入形式仍然合理，当前实现尚不能算最优。** 在保留 DSH 运行时与 Paseo 原生移动端体验的前提下，direct provider 比 fork 两边或完整改用 ACP/SDK 更合适；应先修复跨路径的一致性，再收窄内部 API、MCP 和 UI 的自有实现。

这次最应先处理的三个 P1 都有隔离复现：

1. **并发打开同一持久会话时，失败事务会先关闭另一正在打开的实例；被关闭实例仍报告 ready，随后提问报 unknown session。**
2. **文件快照捕获序号在进程重启后归零，撤回可能恢复到中间版本，却报告成功。**
3. **撤回过早冻结文件计划，漏掉在等待 flush 期间完成的子代理写入，随后还清掉其恢复索引。**

当前基础回归并不是红的：47 个离线/假桥/已安装宿主契约脚本均通过，DSH 导出契约 12/12、桥资产 2/2、真实 TypeScript 检查通过。新问题主要落在**跨重启、跨回合、并发接管、失败回执和实际数据保真**的组合边界。继续增加同形正向断言不能替代这些边界。

上游方面：Paseo npm `latest` 与 `beta` 都为 `0.14.0`；DSH `latest/next` 为 `0.2.1-rc.5`，`alpha` 为 `0.2.2-alpha.2`。alpha 确定改变了 `installModelSelection` 的参数与职责，并要求 Node 24.9+。建议继续使用当前已适配的 rc.5，另建 alpha 验证环境。插件上游 0.2.17 的 Web 页脚布局不应排在这些问题之前。

**长期演进补充**：官方 SDK 的限制不能推广成所有 DSH API 的限制。补查确认 rc.5 的官方 SessionController/JobController/WorkspaceController 已有取消、历史/实时事件、任务订阅和归档等能力。方案已明确调整为：P1 修复与第一批只读 API 迁移验证并行，逐项删掉被官方能力接替的桥代码。具体替换清单、接口副作用、单写入者原则和退出标准见 [路线图第 9 节](ARCHITECTURE-ROADMAP-20261031.md#9-长期主线逐项用官方-api-替换自有桥)。

## 2. 范围、方法与证据边界

### 2.1 覆盖

基线有 193 个 tracked 文件。生产源码共 60 个文件、29,822 行，其中不含可选宿主补丁的部分为 57 个文件、26,329 行；生成的 base64 桥不计入源码行数。另有 68 个 harness 文件。

| 区域 | 审查方式 | 结果位置 |
|---|---|---|
| `dsh-bridge/` 的 18 个模块及 package/patch | 全模块读审，核已装 DSH API；真实文件/真实 gateway/合成异步时序复现 | [bridge.md](audits/20261031/bridge.md) |
| `paseo-plugin/server/`、服务端入口、shared | 全模块读审；真实编译插件、真实 stdio 假桥和宿主源码对照 | [server.md](audits/20261031/server.md) |
| client、入口、安装/doctor/probe、manifest/lock、CI、local-patches | 全模块读审；真实 mapper/组件、mock HTTP、纯字符串补丁变换 | [client-delivery.md](audits/20261031/client-delivery.md) |
| `harness/` | 全入口与副作用分类，关键判据专项复现；47 个现有检查执行 | [harness.md](audits/20261031/harness.md)、[测试清单](audits/20261031/harness-inventory.csv) |
| 文档、生成资产、静态附件 | 阅读当前架构/设计/历史审查，核对说明漂移；资产逐字节校验，非运行附件做范围归类 | [coverage.csv](audits/20261031/coverage.csv) |
| DSH / Paseo 上游 | release、npm tags、相关原包 lib、官方公开文档及关键源码/PR 状态 | [路线图第 4 节](ARCHITECTURE-ROADMAP-20261031.md#4-上游版本趋势与升级判断)、[来源清单](audits/20261031/sources.json) |

主代理负责上游研究、现有回归、分区结果裁决和新增复现的独立复跑。三路子代理分别读审桥、服务端、客户端/交付，随后补审测试体系。没有委派产品修改，也没有把子代理的候选项未经核对直接当结论。

这是一轮全项目范围审查，不是对所有传递依赖、所有 profile 组合或所有设备的正确性证明。生成桥用字节一致性检查；大块内嵌 PNG 不做逐字节视觉审核；package-lock 核结构与直接依赖，不声称审过第三方依赖的全部实现。DSH/Paseo 上游只审与本插件有关的契约和变化，未审两边整个仓库。

### 2.2 本次验证边界

- 从 `git archive 9298c28` 创建独立临时副本，复用已装依赖做类型检查和 CJS 编译。假桥测试使用一次性 DSH_HOME，未把内嵌桥写入正在使用的 profile。
- 新复现分别使用临时文件、loopback HTTP、编译后的真实类、明确记录的 API 替身或判据 VM；**复现脚本 exit 0 表示成功证实缺陷仍存在，不表示修复通过**。
- 宿主契约测试 import 已安装的宿主库，不修改宿主文件，也不能证明正在运行的 daemon 已加载同一份代码。
- 未启动 DSH 真实模型测试回合，未运行真实 daemon 撤回，未进行 iOS/Android 设备验收、压力/堆快照测试。
- 未读取或输出真实凭据值；doctor/probe 复现使用合成配置、合成凭据和 mock fetch。

## 3. 确认问题与优先级

P1 指应首先修复的会话可用性或恢复正确性问题；P2 为明确功能/数据/验证合同问题；P3 为较窄的显示问题。优先级不表示已观察到生产事故。

### 3.1 首先修复的 P1

| ID | 触发与实际结果 | 关键位置 | 最小修复边界 |
|---|---|---|---|
| S01 | 不同 provider session id 同时打开同一 persistence；first 被 closed 后仍 ready，prompt=unknown session；同池 sibling 正常 | `server/provider.ts:1129`、`:1186`、`:1419`、`:1451` | holder 接管前取得事务 claim；close 使 open 失效；ready 前核对 owner/实例，而不只检查 connection |
| BR-01 | 重启前后同文件 captureSeq=[2,1]；应恢复 ORIGINAL，实际恢复 AFTER_FIRST_EDIT，回执 restored=1 | `dsh-bridge/lib/file-snapshots.js:232`、`:304`、`:476` | 持久、单调、可比较的捕获顺序；保留并行逆序 commit；不靠墙钟或猜测修复旧错序 journal |
| BR-02 | child 在文件计划形成后、flush 等待中完成写入；撤回回执成功，child 文件仍存在，journal 却被清空 | `dsh-bridge/lib/server.js:2207`、`:2260`、`:2273`、`:2286` | 正确冻结/收敛后形成最终文件计划；部分失败有回执；未处理的恢复记录不 prune；不能只挪一行 |

BR-02 的复现中 child 在 interrupt/join 时已经结束，因此不是“远端操作无法取消”的已知限制；即便取消成功，旧文件计划仍遗漏其提交。详细时序和两种修法在 bridge 报告中。

### 3.2 配置、生命周期和身份

下表 `server/...` 均指 `paseo-plugin/server/...`。

| ID / 级别 | 问题和证据 | 修复方向 |
|---|---|---|
| S02 / P2 | catalog 按 profile 隐藏 Plan，`session.config` 却重新报告 build/plan；宿主确实消费后者。`provider.ts:276`、`session.ts:638` | 一份 capability source 贯穿 catalog、open、configure |
| S03 / P2 | `setPlan` 拒绝后，后端仍 build，本地 `configState.mode` 已是 plan。`session.ts:1518`；effort 有相同先写后 await 模式 | 成功回执后提交，失败保留旧值；多字段部分成功需回读真实状态 |
| S04 / P2 | 从支持 high 的模型切到无思考档位模型，后端 effort 已清空，UI 仍报 high。`session.ts:1478`、`:636` | route 与 thinkingOption 同步提交，减少双份状态 |
| BR-05 / P2 | build 对应的 queued plan=false 被取出后丢掉，持久 plan=true 恢复后仍 true。`dsh-bridge/lib/server.js:3329` | 对 true/false 对称应用，失败不得谎报已兑现 |
| S05 / P2 | 两个正常 prompt 回合各一工具，第二回合统计为 2；预置 turnId 使统计 reset 分支不执行。`session.ts:1417`、`:1686` | 把预留 id 与真正新回合初始化分开，保留 steer 语义 |
| S06 / P2 | child 已 completed，后来共享进程退出仍向它发 runtime_failed；宿主覆盖为 failed。`session.ts:519`、`:2705` | 只终结尚未结束的 child，保留历史终态及子先于根顺序 |
| S07 / P3 | A 无标题等待，B 有标题到达触发 flush，A 提前无标题打开且不能更正。`session.ts:1889`、`:1987` | 直接路径和 flush 共用 label/预算/父可用条件 |
| S08 / P2，静态闭环 | 共享子进程保留首会话 PASEO_AGENT_ID；后续会话经 shell 调用依赖 self 的 Paseo CLI 时可能沿用首会话身份。`provider.ts:569`、`:683`；已核 DSH env 清洗与 Paseo CLI 实际消费者 | 先验证无副作用 caller fixture，再实现会话级身份或明确拒绝；不能孤立改 env pool key |

S08 未创建 heartbeat、未发送 agent 消息，也未观察到生产误派发。它比“env 不同只是已知告警”更具体：被特意忽略的变量存在真实身份消费者。MCP 的 caller 身份来自各自 server 配置，不应把此问题扩大为整个 MCP 路由都串台。

### 3.3 文件边界、MCP 与客户端

| ID / 级别 | 问题和证据 | 修复方向 |
|---|---|---|
| BR-03 / P2 | 老 child 的孙任务被锚到根后来收到的新消息；撤新消息会选中本属旧指令的孙任务。`dsh-bridge/lib/server.js:1819` | 用派发/activation 因果来源，不以“根最新消息”推断归属 |
| BR-04 / P2 | 捕获后父目录被换为 symlink，恢复跟随祖先链接覆盖另一目录同名文件并报成功。`file-snapshots.js:521`、`:543` | 核捕获/恢复对象及目录身份；拒绝时保留备份与 journal |
| BR-06 / P2 | gateway 忽略 exec.signal；loopback 调用被取消后仍等待并成功返回结果。`mcp-gateway.js:547`、`mcp-http.js:130`、`mcp-stdio.js:269` | 贯穿 signal，取消本地等待和协商；不杀共享进程，不承诺撤销已完成远端业务 |
| BR-07 / P2 | `{content:[],structuredContent:{answer:42}}` 被投影成空成功结果。`mcp-gateway.js:567` | schema 与模型可见结果保留结构字段；必要时提供 JSON 文本投影 |
| BR-08 / P2 | 可预测图片 cache/staging 未验证已有目录归属，预置 staging symlink 会被 copyFileSync 跟随。`image-host-path.js:91`、`:123`、`:130` | 私有 cache root、owner/mode/链接检查、随机排他 staging；保留稳定最终路径 |
| C1 / P2 | write/edit 的失败原因在 TimelineBuilder→client mapper 中消失，展开仍是计划内容/diff；图标仍为 failed。`client/tool-call-data.ts:1231`、`:1296`、`:1467` | 独立错误字段和可读错误区域；不能把计划当执行结果；无法保真则交宿主渲染 |
| C2 / P2 | 最终文本增长与 complete 同帧，useGrowing 提前 return，之后同值不再触发 effect，扫光停不下。`client/inline-thinking.tsx:56` | 明确终态/稳定窗口，不依赖额外帧；同时保留防 phase 闪烁约束 |

BR-04/08 的证据是私有同用户文件系统行为，没有证明 OS 越权或当前机器遭利用。C2 通过真实组件配最小 hooks dispatcher 证明状态逻辑，不冒充设备复现。C1 不是“界面报成功”，而是失败原因丢失。

### 3.4 安装诊断、可选补丁和测试可信度

| ID / 级别 | 问题和证据 | 修复方向 |
|---|---|---|
| D1 / P2 | doctor parse YAML 后仍按 regex 跨区块找字段；空引号 route/key、注释空值、refs 外同名 key、禁用 default-model 等六类均全绿。`lib/doctor.mjs:442`、`:463`、`:491` | 用解析后的真实对象和有效条目，检查引用关系；保留合成完整模板对照及密钥不回显 |
| D2 / P2 | baseline 200 后收到 401/402/403，probe 仍 exit0 并建议关闭 developer role/思考；429 对照为 unknown。`lib/probe-provider.mjs:144`、`:314`、`:344` | 鉴权/额度/环境失败不能产生能力结论；明确参数拒绝才改配置 |
| L1 / P2，窄触发 | 已有补丁 stale 重建将 bridge.revert 后到方法末尾全部替换，可删掉其他补丁/上游新增 tail 语句。`local-patches/apply-rewind-history-truncation.mjs:1332`、`:1372` | 精确限定自有 marker/AST 区域，额外语句 fail closed；不是当前干净 npm 升级必现 |
| T01 / P2 | route-test 有 partial text 即可 WORKS，即使同时 fatal；全部 FAILS 也不使进程非零 | 同一请求的正确终态、错误和超时共同决定 verdict/exit，输出机器可读结果 |
| T02 / P2 | tools 诊断的 initialize 不带 sessionId，当前 bridge 对该 session 的 prompt 会拒绝 | 与实际调用契约同步，终态等待/退出可靠，避免诊断工具自身制造假故障 |
| T03 / P2 | plugin-check 在邻接合并判据前过滤掉非 assistant 项，A→reasoning→A 被看成相邻 A→A | 保留完整有序事件、seq、turnId、messageId，按真实宿主规则验证 |
| T04 / P2 | 图片检查接受 IMAGE-SEEN，而该词在 prompt 中已给出；没有图片也可满足原正则 | 用只能来自图片的内容和无图负对照，不拿模型复述指令当图像证据 |

T01–T04 的原判据和请求形状由离线 VM/真实 bridge 的无模型服务复现；未启动这些脚本去调用真实模型。详细行号、执行属性与复现见 harness 报告。现有 `plugin-check` 的历史通过记录只能按它实际检查的内容解释，不能由此推导图片理解或合并保真已经充分验证。

## 4. 工程方向与旧 workaround 的退出机会

这些是已检查到的结构和风险，不作为已经发生的性能事故计数。

- **CI 没有覆盖普通提交。** 当前唯一 workflow 只由 schedule/workflow_dispatch 触发；上游已是 ancestor 时直接退出；干净合并仅过部分门就 push main。应把 push/PR 离线门与上游同步分开，机器人维护候选 PR，不能把 Git 无冲突当契约安全。
- **版本/协议声明太弱。** bridge 的固定 serverInfo 字符串、宽版本范围和只查导出的合同，不能发现 alpha 的 model-selection 语义变化。需要版本矩阵和少量行为差分门。
- **bootstrap 存在半份产物窗口。** 当前移除旧桥后逐文件写入，失败可留下不完整桥。改成代际暂存、校验与切换，保留旧代际回退。
- **共享进程需要整体预算。** 分帧线性化已完成，但单帧字符数上限不是连接总内存限额；orphan 桶、pending RPC、整帧 JSON、历史/timeline 缓存仍需测量与背压。
- **jobs 需要总量和可见性策略。** 非 closed agent 每 4 秒轮询，多个客户端相乘；目录首个 snapshot 还有分页边界。先测量，再决定退避/聚合/事件触发，不直接把间隔改小。
- **移动端需要真正的交互门。** JSX/样式表/纯函数证明不了动态字体、触控、前后台、弱网和动画落定；Web footer 调整不能代替 native 验收。
- **通用 UI 尽量复用宿主。** C1 说明整体重画工具行会承担新增字段的保真成本。保留 DSH 特有展示；未知/无法无损表示的项交回原生 renderer；评估公开 i18n，但先核对应发行物。
- **文档需区分历史和操作指南。** P003 已实现 workflow/goal/approval/systemPrompt/projections，旧审查中的“尚未支持”不应继续当当前结论。ADOPTION 仍有“每会话起桥/修改立即生效”，OVERVIEW 仍有与已实现工具图片路径相反的说明；应在后续文档包修正。

## 5. 主编裁决：不成立或不宜直接实施的建议

| 候选说法 | 裁决 |
|---|---|
| “DSH 有 ACP，所以应立刻删自有桥” | 驳回；官方 ACP 主动排除了本插件需要的交互和重放能力 |
| “DSH alpha 的 snapshot 变 async，所以 P003 已坏” | 驳回；真实 d.ts 的 snapshot 仍同步。真正已证的迁移阻断是 model-selection API |
| “devDependencies 0.14 就证明最低 0.9.2 声明错误” | 驳回；旧 npm 包已含多项所用 API。仍需完整运行矩阵，不能反向宣称旧 App 都可用 |
| “没有原生 Paseo tools 通道就没有 Paseo 工具” | 驳回；本插件已有 MCP 通道，原生工具接口是宿主扩展缺口 |
| “所有未渲染 DSH 事件都是缺陷” | 驳回；内务事件、审计事实、模型输入与用户时间线不是同一个集合 |
| “为 env 隔离直接换成每会话一进程” | 暂不采纳；需同时处理 archive registry、持久 owner 与冷启动代价，先验证身份扩展点 |
| “用自动 reload 消除撤回 canary” | 暂不采纳；不能增加跨插件循环/会话中断来掩盖宿主历史接口缺口 |
| “再跑一遍当前所有正向测试就能证明这些问题不存在” | 驳回；本次 47 个现有门通过，同时新增时序/失败复现成立 |

## 6. 验证结果与尚未执行的门

| 层 | 本次结果 | 能证明什么 |
|---|---|---|
| TypeScript | `tsc --noEmit` exit 0，真实 React Native/Paseo 类型 | 当前源码类型兼容，不证明设备 UI |
| DSH 导出合同 | 12/12，已装 rc.5 | 当前导出存在，不证明 alpha 行为兼容 |
| 内嵌桥 | 2/2，20 个 bridge 文件逐字节一致 | 本 checkout 资产新鲜，不证明 live 进程已加载 |
| 现有离线/假桥/宿主库检查 | 47/47 exit 0 | 清单内场景通过，不覆盖新增组合边界 |
| 新增复现 | 主代理复跑；归档 runner 的 10 个批次全部确认反例，见 [复现记录](audits/20261031/reproduction-results.json) | 当前缺陷可在明确条件下复现，不是修复验收 |
| DSH 真实模型、父子写入/撤回/重启 | 本次未执行 | 后续修复的必要行为门 |
| Paseo daemon 原版/补丁状态与 iOS/Android | 本次未执行 | 后续端到端与设备门 |
| alpha 运行、压力/峰值内存 | 本次未执行 | 不据静态分析承诺支持或容量 |

现有检查首次在临时副本执行时，7 个旧式 CJS harness 缺少同目录 fake bridge 夹具而报 ENOENT；补齐其头部文档规定的夹具后，只复跑这 7 项，均通过。该准备错误不计作产品缺陷，原始与最终执行记录分开保留。

## 7. 下一步

执行顺序为：**会话/恢复正确性与可信门禁 → 配置/生命周期/工具结果 → 交付与兼容矩阵 → 有测量依据的性能和移动端优化 → 下一代 DSH 接口旁路试验**。

每个工作包的范围、依赖、回归条件、发布和回退要求已写入 [架构选择与优化路线](ARCHITECTURE-ROADMAP-20261031.md#6-实施路线与验收条件)。这轮到此只交付方案与证据；产品修复、上游 issue 提交、升级、部署和发布均未执行。
