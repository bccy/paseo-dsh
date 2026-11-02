# 插件 / 客户端 / 交付 harness 判据质量审查（2026-11-02）

- 审查对象：`main` HEAD `2f71225`（工作区除本目录外干净）；范围是 `harness/` 中插件、客户端与交付相关脚本 33 个。
- 方法：逐个读头部注释与实现，重点判「断言打在协议层还是渲染/日志/宽松正则」「是否断言真实终态与错误」「跳过是否算绿」「环境依赖与副作用」「失效形态」。安全脚本实跑；未写真实 `~/.dsh` profile、未触发真实模型回合。
- 基线：`docs/FULL-AUDIT-20261031.md` 的 T01–T04 与 `docs/audits/20261031/harness.md`；用 `git diff 9298c28..HEAD -- harness/` 对账文件归属——本周期只有 12 个 harness 文件有改动，`plugin-check.cjs` / `route-test.mjs` / `tools.mjs` / `probe.mjs` 等含 T01–T04 的文件在基线后 **0 改动**。
- 结论：**测试资产的主体是健康的**——假桥/编译真实实现的脚本大多把断言打在事件、id、状态、错误码和终态上，负向用例和双向对照做得比一般项目好。**问题集中在两类**：① 两个「真实环境」主门（`plugin-check`、`route-test`）仍带着上一轮 T01–T04 的假绿判据，当前 HEAD 未修；② 真实 profile/模型脚本没有 `DSH_HOME` 隔离、诊断脚本与门禁脚本混在一起，又没有机器可读清单，拿一个 `node harness/*.sh` 或「全绿」当发布判据会得出错误结论。

## 1. 脚本清单

表中的「判据质量」按文件自述目标与实际断言能力评：强 = 断言打在协议/数据层且有负向或双向对照；中 = 有实质断言但关键环节靠手抄/静态快照/弱证据；弱 = 只打印、不断言或判据可被自身输入满足。

### A. 真实 profile / 真实模型（不可进离线门）

| 脚本 | 执行环境/依赖 | 副作用 | 判据质量 | 残余风险 |
|---|---|---|---|---|
| `plugin-check.cjs` | 真实 `dsh` profile + 真实模型；手工 tsc 到 `paseo-plugin/.dbg`；依赖 `@getpaseo/plugin` | 加载插件即 `ensurePaseoProfile()` 重写真实 `~/.dsh/profiles/<name>` 内嵌桥；写真实会话日志；`:242` 把权限切成 `danger-full-access` 后跑真实回合；耗 token | **中**：28+ 项里多数是协议级事件/错误断言，但 T03 邻接判据先过滤事件、T04 图片判据可被提示词自身满足（见 HP-01/02），另有 goal/preset 条件跳过 | 真实模型和路由能力会改变结论（文本路由使图片检查全绿）；无 DSH_HOME，重复运行污染真实 profile/会话；无预算/超时上限 |
| `route-test.mjs` | 真实 `dsh --profile`（默认 paseo）+ 真实模型；无 DSH_HOME | 每条路由创建一个真实会话（写会话日志）；每路由固定 25 s；耗 token | **弱**：`:136` 只看有没有文本，fatal error 仍打印 `WORKS`；全 FAIL 仍 exit 0；不等待匹配的 `turn/end` | T01 原样保留（基线已有）；25 s 固定等待把慢回合误判 FAILS；90 s 定时器不清理 |
| `probe.mjs` | 真实 profile + 真实模型 | 写 `harness/frames-probe.jsonl`；真实会话；耗 token | **弱（诊断，不是门）**：问题卡未到达只打印 `!!` 并继续（`:141-145`）；plan/config 只打印不断言（`:147-168`） | 退出码不反映交互是否发生；不能当「提问卡链路通过」的证据 |
| `tools.mjs` | 真实 profile + 真实模型 | 写 `harness/frames.jsonl`；真实会话；耗 token；180 s 定时器 | **弱（诊断，不是门）**：无断言；`:73` `initialize` 不带 sessionId 而 `:76-77` prompt 带 `SESSION_ID`，当前桥必拒绝（T02） | 工具可见性诊断实际不可用；`setTimeout` 不 unref/清理，结束后进程可能挂到 180 s |
| `catalog.mjs` | 真实 `dsh --profile`（默认 paseo），不发 prompt | 读 profile；90 s 定时器不清理 | **弱（诊断，不是门）**：空模型目录也打印空并 exit 0（仅异常时 `:68` 置非零） | 无法作为「catalog 非空」门；症状（0 个模型）看起来仍像成功 |
| `archive-registry-check.mjs` | 真实 `dsh --profile`，无模型；`DSH_BINARY` 可覆盖 | 启动真实 runtime，首帧 `paseo/archive`/`paseo/unarchive`；声明不写 | **强**：第一帧触达真 registry，`available:false` 且错误含探测 id、unarchive `available:true`；exit 1/0 | 依赖 profile 合成 `@deepseek-ai/dsh-workspace`；无 DSH_HOME，若 profile 有启动钩子仍会执行 |

### B. 假桥 / 编译真实插件（一次性 DSH_HOME）

| 脚本 | 执行环境/依赖 | 副作用 | 判据质量 | 残余风险 |
|---|---|---|---|---|
| `session-request-check.cjs` | 假桥 `DSH_FAKE_MODE=live` + 一次性 `DSH_HOME`；手工 tsc | `.dbg` 目录；临时 DSH_HOME 退出清理 | **强**：persistence handle、cwd/title/description、canary 恰好一条且在回执前、被拒无 canary、序号递增、files 作用域无 canary | fixture 行数写死 `rows.length === 2`；canary 文案用正则 `^\d{2}:\d{2}:\d{2} · #1。` 绑定格式 |
| `concurrent-open-check.mjs` | 假桥 `multi` + `DSH_FAKE_HOLD_*` 文件闸；一次性 DSH_HOME；`plugin-build.cjs` 自动编译 | `.dbg-*`（gitignored）；/tmp hold 目录自清理 | **强**：恰好一个 ready、失败方 `request.failed` 且为 guard 文案、胜者可继续提问、失败事务释放 claim、close 使 open 失效、provider id 排他 | 场景 (a) 只断言 `session.ready`/`session.opened` 不发布，**未断言 `session.config`**（HP-13）；真实 DSH 写锁语义仍不在假桥内 |
| `context-usage-check.cjs` | 编译真实 `DshSession` + `FakeProcess` 传输；自动构建 `.dbg-t5-context` | 写 repo 内 `.dbg-*`；无 profile | **强**：打开上报、回合内合并、压缩下降、未知容量、无效计数、迟到旧响应、关闭后不发、补发四档与定时器清理 | 固定假设 4 个 delay/定时器；`FakeProcess` 每个方法都是 stub（注释要求全量实现） |
| `replay-turn-check.cjs` | 编译真实 `DshSession` + 假传输 + 真桥 `surface.js`；自动构建 `.dbg-replay-turn` | `.dbg-replay-turn` | **强**：两个回合 started…终态闭合、4 行全部在区间内、两回合 id 不同、行归属同一 id、turnId 稳定派生 | 只覆盖 completed 回合；Paseo 规则本地复刻（HP-12） |
| `assistant-stream-check.cjs` | 真插件 + 假桥 `stream`；一次性 DSH_HOME；手工 tsc | `.dbg`；临时 DSH_HOME | **强**：多个增长快照、id==messageId、durable 同 id、折叠恰好一行 | 折叠 oracle 复制（HP-12）；单 step fixture |
| `assistant-retry-check.cjs` | 真插件 + 假桥 `retry`；一次性 DSH_HOME；手工 tsc | `.dbg`；临时 DSH_HOME | **强**：两 attempt 不同 id、durable 落在第二 id、最终答案一次、旧 attempt 独立、reasoning 同后缀 | oracle 复制；`assistant:1:1:2` 后缀是隐式契约 |
| `image-check.cjs` | 真插件 + 假桥 `image`；一次性 DSH_HOME；手工 tsc | `.dbg`；临时 DSH_HOME | **强**：恰好一条 markdown 图片行、路径逐段编码、无 hostPath 无行、过 `ProviderEventSchema`、replay 同 id 文本 | 依赖假桥 fixture 的 attachment 形状 |
| `steer-check.cjs` | 假桥 `steer/late/failonce/cancel`；一次性 DSH_HOME；手工 tsc | `.dbg`；帧日志在 DSH_HOME | **强**：steer 被准入且回执 turnId 与 started 一致、不新开回合、cancel 语义、失败回落 | Paseo admission 本地复刻（同 HP-12 类） |
| `subagent-check.cjs` | 假桥 `live/nested/label-*/replay`；一次性 DSH_HOME；手工 tsc | `.dbg`；两个 `os.tmpdir()` 帧日志不清理（`:703`、`:1474`） | **强**：父子归属、父母能力门、错误态、归档往返、replay 过滤归档、label 晚到/永不 | 临时日志残留；`:477`、`:876` 两处 `check(..., true, ...)` 依赖前置 `untilIn` 抛错（冗余但非假绿） |
| `uploaded-file-check.cjs` | 手工编译 `session.ts` | `.dbg-attach` | **中**：文本、字段顺序、diff 行逐字断言，但期望值来自手抄的本地 `renderPromptAttachmentAsText` 副本；无运行时上游对照 | Paseo 官方格式漂移不会红（HP-15）；17 条断言覆盖文本/图片/未知类型 |

### C. 纯模块 / 表驱动

| 脚本 | 执行环境/依赖 | 副作用 | 判据质量 | 残余风险 |
|---|---|---|---|---|
| `plugin-build.cjs` | 基础设施：node fs + spawnSync tsc，无网络 | 写 `paseo-plugin/<dir>`（调用方私有） | **强**：源码集、mtime、缺失/stray 产物、package marker、stamp 版本、tsc 版本、配置输入 | mtime-only；删除配置输入不会 stale（HP-14）；`PASEO_PLUGIN_BUILD`/显式 argv 绕过只告警 |
| `plugin-build-check.mjs` | 纯元数据 + 临时副本 + 一次真实 tsc | `/tmp` 私有目录；symlink `node_modules` | **强**：86 断言、每个场景「构造→断言→还原→再断言」，含根入口、stamp、配置输入、外部构建告警 | 未覆盖配置输入被删除/不可读；依赖 scratch 文件系统与 tsc |
| `image-host-path-check.mjs` | 纯桥模块 + 真实临时文件 | 写共享 `TMPDIR/paseo-dsh-attachments-<uid>/`（真实 UID），只清 `.png/.jpg`；`/tmp/image-host-path-check-*` | **强**：42/42，字节一致、扩展名从 mediaType、未知类型/缺 store/抛错原样返回、historyEvents 投影 | TMPDIR 未隔离，与运行中的插件共用缓存目录（HP-17）；中断时留下目录 |
| `timeline-check.cjs` | 手工编译 `timeline.ts`+`locale.ts`；真 `ProviderEventSchema` | `.dbg` | **强**：工具生命周期、重复 call、压缩括号、图片行、detail 九分支、locale 随行、schema 边界 | 手工编译；detail 分支与 `client/tool-call-data.ts` 的一致性靠两边人工同步 |
| `newest-check.cjs` | 手工编译 `client/newest.ts` | `.dbg` | **强**：位置、提交批次、窗口、交接、时钟、真实 `shouldPulse` 判据 | 手工编译 |
| `tool-call-check.cjs` | 手工编译 `tool-call-data/tokens/paseo-mark` | `.dbg` | **强**：图标/命令/diff/截断、typed detail、renderer schema 对齐、源码接线 | 手工编译；图标/标签手抄部分无运行时对照 |
| `thinking-check.cjs` | 手工编译 `thinking-text.ts`+`source-shape` 读 TSX | `.dbg` | **强**：首行/段落规则、em 宽度、尾部窗口、JSX 测量接线 | 依赖 `source-shape` 子集解析；`advanceEm=0.55` 手抄 DSH 度量 |
| `locale-check.cjs` | 手工编译 `locale.ts`+`tool-call-data.ts`；`@getpaseo/protocol` | `.dbg` | **强**：locale 优先级、双语表覆盖、官方 catalog 逐字对照、jobs 文案、语言 relays | `MOUNTED_TOOLS` 是静态 136/25 快照（`:319-404`），不是当前挂载；新工具不在名单不会被发现（HP-16） |
| `jobs-poll-check.cjs` | 手工编译 `poll-sequence.ts`+`shared/jobs.ts` | `.dbg-poll` | **强**：旧算法同样场景必败的对照、轮询序号、排序/分桶 | 手工编译 |
| `jobs-popover-check.cjs` | 手工编译 `jobs-popover-layout.ts` + `typescript`；可选 `HOST_APP` | `.dbg-jobs` | **强（有 HOST_APP）**；无 HOST_APP 明确 exit 2 incomplete | host 半边用不少格式化正则匹配 Paseo 源码，宿主格式化即红（HP-19）；不设 HOST_APP 则这半边永远不跑 |
| `agent-message-check.cjs` | 手工编译 + `@getpaseo/protocol` + `source-shape` | `.dbg-am` | **强**：官方 display model 对照英文标签、中文手写表、各种降级、transformer 分支条件 | protocol 包缺失只红一条、其余继续；源码分支断言依赖解析器 |
| `style-check.cjs` | 手工编译 `tokens.ts` + 读 TSX | `.dbg` | **强**：共享样式数值表 + 状态色/结构接线 | 无 host 对照（RN 侧做不了）；数值手抄 DSH |
| `sweep-check.cjs` | 手工编译 `sweep-geometry.ts` | `.dbg` | **强**：mask 停点、阶梯、1.5s/0.3s/2-3、steps(48) | 数值手抄 DSH |
| `source-shape.cjs` | 基础设施：TSX 子集解析器 | 无 | **中**：读取失败返回 `undefined`（fail closed），但自身无回归用例 | 规则改动无独立覆盖；依赖消费者把 `undefined` 判成失败 |
| `doctor-check.mjs` | 沙箱 `DSH_HOME` + 真 `runDoctor()` + PATH 伪 `dsh`；依赖 `paseo-plugin/node_modules/yaml` | `/tmp` 临时目录，正常路径 `rmSync` 清理；无真实 profile | **强**：29/29（空 provider/model、YAML 错误、空值/refs 外凭据、桥缺 lazy 模块、文件列表不可读 fail、无 plugin parser 时 DSH fallback 的正/负对照） | 无 `try/finally`，中途异常会残留临时目录；只覆盖 doctor 判定不覆盖真实安装启动 |
| `probe-check.mjs` | 本地 loopback HTTP server + 真 `runProbe()`；无 profile | 进程内 server；无外部服务 | **强**：21/21（200+error、200+HTML、4xx 回显 Authorization、429 unknown、无结论非零、happy path） | 不覆盖真实网关的 TLS/重定向/代理行为（脚本范围之外） |

### D. 真实会话日志诊断

| 脚本 | 执行环境/依赖 | 副作用 | 判据质量 | 残余风险 |
|---|---|---|---|---|
| `session-calls.mjs` | 真实 `$DSH_HOME/sessions` 多帧 zstd（外部 `zstd` CLI，失败回退 zlib stream）；只读 | 读用户会话内容，不写 | **中**：能查未声明键并在有 `invalid` 时 exit 1，但 schema 取整份日志最后一个 `request/header`（`:140-155`），无 schema 的调用不算 invalid（`:265-271`），gate 可空转 exit 0（实测） | schema 可能不是当次调用见过的；无 schema/不可解析 call 从 invalid 计数消失（HP-08）；`--list` 有警告仍 exit 0 |

## 2. 发现

证据等级：**实测** = 本 lane 在当前 HEAD 直接运行或反例演算；**源码事实** = 读代码可确定的控制流；**源码推断** = 由代码结构推出、未构造运行；**未验证** = 未能取证。

| ID | 严重度 | file:line | 触发条件 | 证据等级 | 新引入 vs 基线已有 |
|---|---|---|---|---|---|
| HP-01 | P2 | `harness/plugin-check.cjs:469-479`（过滤在后，投影函数 `:89-116`） | 一步内 `assistant A → reasoning THINK → assistant AB`；先 `.filter(assistant_message)` 再 `projectTimelineLikePaseo`，过滤掉打断邻接的 reasoning/tool 行，最终只看到一行 | **实测**：本 lane 反例演算，完整序列投影出 2 条 assistant 行，assistant-only 过滤后 1 条 → 判据通过；`fix-verify-bridge-client` lane 在同 HEAD 独立复现 T03 | **基线已有**（文件 `9298c28..HEAD` 0 改动） |
| HP-02 | P2 | `harness/plugin-check.cjs:359`、`:494-508` | prompt 主动要求模型回复 `IMAGE-SEEN`；断言只对非 user 行文本匹配 `/image|图片|…/i`，模型按文本指令回 `IMAGE-SEEN`（含 `IMAGE`）即通过，零图片块也满足 | **实测**：无图片证据的 `IMAGE-SEEN` 文本通过同一正则；`fix-verify-bridge-client` lane 同 HEAD 复现 T04 | **基线已有**（0 改动） |
| HP-03 | P2 | `harness/route-test.mjs:118`、`:135-139` | 任一回合只要流出部分文本就 `WORKS`，即使同时收到 fatal `failure`；所有路由 FAILS 时脚本自然结束 exit 0；固定睡 25 s 不等于终态 | **源码事实** + 基线报告 T01/`fix-verify-bridge-client` 同 HEAD 实测（partial+failure→WORKS、全 FAIL exit 0） | **基线已有**（0 改动） |
| HP-04 | P2 | `harness/tools.mjs:10-18`、`:30-33`、`:73` vs `:76-77` | `initialize` 只带 `cwd`，`session/prompt` 带 `SESSION_ID`；当前桥 `dsh-bridge/lib/server.js:1060-1067` 按会话校验，必报 `not initialized for session`；诊断永远做不成工具可见性回合，且 180 s timer 不清理/不 unref，写 `harness/frames.jsonl`、继承真实 profile | **源码事实**（桥代码路径）+ 基线报告 T02/`fix-verify-bridge-client` 真桥反例 | **基线已有**（0 改动） |
| HP-05 | P2 | `harness/plugin-check.cjs`（全文无 `DSH_HOME`；`:238-250` 设 `danger-full-access`）、`harness/route-test.mjs:19-24`、`harness/tools.mjs:14-18`、`harness/probe.mjs:27-31` | 直接以默认 paseo profile 跑真实模型：`plugin-check` 加载插件经 `paseo-plugin/index.server.ts:25` 的 `ensurePaseoProfile()` 重写真实 `~/.dsh` profile 内嵌桥；其余三个向真实 `~/.dsh/sessions` 写会话；四个脚本都无预算/隔离。各文件头部只在 plugin-check/AGENTS 里间接提到部分副作用 | **源码事实**（grep 无 `DSH_HOME`；`ensurePaseoProfile` 调用链已核） | **基线已有**（0 改动） |
| HP-06 | P2（系统性） | 例：`harness/plugin-check.cjs:18-27`、`harness/timeline-check.cjs:55-58`、`harness/session-request-check.cjs:50-53` 等 19 个脚本的手工 `npx tsc`；`harness/plugin-build.cjs:431-438` 只对显式路径告警 | 无 `harness/manifest.*`；19 个脚本要求先手工编译并复制到**同名** `.dbg`/`.dbg-*`，并发任务会互相覆盖；另有 13 个已用 `plugin-build.cjs` 自动构建。陈旧/残缺编译树可让下游全绿，`plugin-build-check.mjs` 的存在本身就说明这是地基风险 | **源码事实**（`grep -l "npx tsc"` = 19；`grep -l plugin-build` = 13；无 manifest 文件） | **基线已有**（上一轮 H1 未实施）；本周期新增脚本已改用自动构建，但旧脚本未迁移 |
| HP-07 | P2 | `harness/plugin-check.cjs:204-206`、`:302-305` | profile 没有 agent-preset registry 或没有 `/goal` 命令时，对应检查只打印「skipped/not expected」，整体仍 exit 0；本应验证「能力声明与数据源一致」的菜单分发检查在看到缺失能力时反而消失 | **源码事实** | **基线已有**（0 改动） |
| HP-08 | P2 | `harness/session-calls.mjs:140-155`、`:265-271`、`:284-286` | 会话日志没有 `request/header`（或 call 的 schema 查不到）时 verdict 为 `no schema`，`clean=true` 不累加 `invalidCalls`，最终 exit 0；header 却声称「Exit code is 1 when any call carried keys the schema never declared, so this can gate a script」；另外 `schemasFrom` 对同名工具取整份日志最后一个 header，不是当次调用所见 | **实测**：构造无 `request/header` 的合法 zstd 会话，`DSH_HOME=<tmp> node harness/session-calls.mjs --latest` → `EXIT=0`，输出 `--- [no schema] tool_a`；源码事实佐证 | **基线已有**（上一轮残余风险已提，未修） |
| HP-09 | P3 | `harness/plugin-check.cjs:366`、`:371-373`、`:604-607` | `:366` 的 `until(turn completed)` 没有 `since` 切片，可能被此前回合的完成事件满足；`:371` 的 usage 从全事件收集而非 image 起点；`:604-607` 「reopen replays conversation history」只要任意一条 user/assistant 行就通过，不验证 assistant 历史或去重 | **源码事实**（结合同一文件 `:541-542` 自己对 stale-match 的注释，说明该模式已被团队认识但未统一） | **基线已有**（0 改动） |
| HP-10 | P3 | `harness/probe.mjs:141-145`、`harness/catalog.mjs:43-67`、`harness/route-test.mjs:135-139` | 无问题卡 / 空 model catalog / 全路由 FAILS 都退出 0；这些文件是诊断不是门禁，但目录和 AGENTS 常把 `probe`/`catalog`/`route-test` 与检查混列，一个 `for f in harness/*; do node $f; done` 会把诊断的 0 当通过 | **源码事实**（`probe.mjs` 无问题只 log；`catalog` 只在 catch 设 exitCode；route-test 仅无 routes 时 exit 2） | **基线已有** |
| HP-11 | P3 | `harness/tools.mjs:30-33`、`harness/route-test.mjs:59-61`、`harness/catalog.mjs:44` | `setTimeout` 未 unref、未在成功/异常后清理；每次 request 都留一个 90/180 s timer，主流程结束后事件循环仍被占住，进程像是挂起（`probe.mjs:49-54` 已修成 `unref()`，可对照） | **源码事实**（Node timer 语义；未实测整脚本挂起） | **基线已有**（probe 的修法未扩散） |
| HP-12 | P3 | `harness/plugin-check.cjs:89-116`、`harness/assistant-stream-check.cjs:116-144`、`harness/assistant-retry-check.cjs:117-143`、`harness/replay-turn-check.cjs:188-241` | Paseo 的「prefix delta + 相邻同类型合并 + messageId guard」规则被复制三份，turnId 规则又被复制一份；上游规则变化时全部保持绿，且三份之间可各自漂移；没有版本固定的共享 oracle（上一轮 H3 建议） | **源码事实**（diff 对比三份实现逐行等价） | **基线已有**（0 改动/本周期沿用） |
| HP-13 | P3 | `harness/concurrent-open-check.mjs:466-474` | 场景 (a)（close 使进行中的 open 失效）只断言不发布 `session.ready` / `session.opened`；`de4ba8c` 的修复注释明确说被关掉的会话曾照样发 `opened/config/ready`，`paseo-plugin/server/provider.ts:1565` 的 `session.config` 也有独立 `#assertOpening` 守卫；该守卫若单独退化，此检查不红 | **源码事实**（已有间接覆盖：若 `session.opened` 前的守卫一起去掉会红；单独缺 config 断言是窄缺口） | **基线后新增**（检查随 `de4ba8c` 新增/扩展，属本周期） |
| HP-14 | P3 | `harness/plugin-build.cjs:134-138`、`:242-270`、`:405-419`、`:431-438` | `configInputs()` 只返回当前存在的 `tsconfig.json`/`package.json`：把一个已记录的配置输入**删除**后，`freshness()` 遍历当前输入看不到它，已构建树仍可能 fresh；`installedTscVersion()` 读不到时静默跳过版本比较；`PASEO_PLUGIN_BUILD`/显式 argv 只告警仍使用 | **源码推断**（未构造删除 tsconfig 的实测；`plugin-build-check` 无该场景） | **基线已有**（config 输入跟踪在基线已存在） |
| HP-15 | P3 | `harness/uploaded-file-check.cjs:5-19`；`paseo-plugin/server/session.ts:3169` | 期望文本是从 Paseo `renderPromptAttachmentAsText` 手抄进测试的；插件又维护了一份同名本地实现，测试比较的是「本地副本 vs 手抄文本」，没有运行时对照官方包（插件 `node_modules` 里也没有 `@getpaseo/server`）。官方格式变化时不会红 | **源码事实**（import 的是 `./server/session.js` 的本地函数；node_modules 列表已核无 `@getpaseo/server`） | **基线已有**（0 改动） |
| HP-16 | P3 | `harness/locale-check.cjs:319-370`、`:404` | `MOUNTED_TOOLS`（136）与 `FOREIGN_SERVER_TOOLS`（25）是写死的静态快照；只有名单内工具被断言有标签/图标。profile 新挂载一个工具（或新增 MCP server）不会进入检查，而 header 自称「the full scan / end-to-end」 | **源码事实**（名单是字面量；无读当前 `request/header` 的代码） | **基线已有**（本周期 locale 有改动但未触及该快照机制） |
| HP-17 | P3 | `harness/image-host-path-check.mjs:83-100`、`:447-448` | 使用真实 UID 的共享 `TMPDIR/paseo-dsh-attachments-<uid>/` 写测试 digest 的 `.png/.jpg` 副本并删除；未设私有 `TMPDIR`。与运行中的插件共享同一缓存路径，并行/中断会留下目录（`/tmp/image-host-path-check-*` 已观察到多份） | **源码事实** + `/tmp` 观察（未证明影响真实附件） | **基线已有**（0 改动；上一轮残余风险已提） |
| HP-18 | P3 | `harness/subagent-check.cjs:703-704`、`:1474-1476`、`:477`、`:876` | 两个 `os.tmpdir()` 帧日志不在 `process.on('exit')` 清理列表内；`:477`/`:876` 的 `check(..., true, ...)` 是冗余恒真，实际保护来自前置 `untilIn` 抛错——若未来有人把 `untilIn` 换成 `maybe`，这两条会变成假绿 | **源码事实** | **基线已有**（0 改动） |
| HP-19 | P3 | `harness/jobs-popover-check.cjs:520-700` 多处（如 `:550-560`、`:640-700`） | HOST_APP 半边用正则直接匹配 Paseo 源码换行/属性顺序；宿主格式化或重排即红（假红），而宿主真实行为变化未必被这些正则抓住；不设 `HOST_APP` 时明确 exit 2（这点正确） | **源码事实**（同上一轮对 source-shape 的批评修复未覆盖 host 侧） | **基线已有**（本周期检查扩充，模式沿用） |

补充说明（不是独立发现）：

- `plugin-check.cjs:244-249` 的 `permissionApplied` 用全事件 `until`，若打开时 profile 默认权限已是 `danger-full-access`，检查会命中打开时的 `session.config` 而假绿。只有真实 profile 默认值不是该权限时才有效。
- `plugin-check.cjs:540-560` 的「mislabeled image type corrected」只断言回合 completed 且无失败；文本路由下图片可能被 DSH 替换成文本注记，桥是否真的按字节纠正媒体类型未被协议层证据覆盖（桥侧 `dsh-bridge/lib/server.js:52-83` 有 sniff 实现，但本 script 未验证图片块真的被接收）。
- `plugin-build-check.mjs` 是本次实跑中做得最扎实的脚本（86/86，双向断言 + 变异痕迹），是本目录的正面样本。

## 3. 健康度评分

| 维度 | 分数（1-5） | 说明 |
|---|---|---|
| 正确性 | 4 | 大部分假桥/编译脚本断言在协议层且带负向对照；但 4 条已知假绿（T01–T04）仍在两个主门里 |
| 健壮性 | 3 | 假桥脚本的一次性 DSH_HOME/清理做得好；真实 profile/模型脚本无隔离，诊断定时器残留，`plugin-build` 有 fail-open 边角 |
| 可维护性 | 3 | 约 1.6 万行、33 个入口、19 个手工编译步骤、无 manifest；折叠 oracle 三份复制；新增脚本已改用 plugin-build，但旧脚本未迁移 |
| 契约一致性 | 3 | 大多数断言打在事件/错误码/终态；T03/T04、session-calls schema 绑定、手抄上传格式是剩余缺口 |
| 性能 | 4 | 离线脚本普遍快；`plugin-check`/`route-test` 慢是真实模型成本，但固定 25 s/45 s 等待和未清 timer 造成额外挂起 |
| 安全 | 3 | 无密钥泄漏（`probe-check` 有 canary 覆盖）；但真实模型以 `danger-full-access` 在真实 profile 上跑、共享 `TMPDIR` 缓存、真实会话写入都是运行风险 |
| 测试覆盖 | 4 | 覆盖广度好（33 个入口，含假桥负向、真实模块、表驱动、宿主契约半边）；缺跨重启/真实终态/真实 profile 隔离的组合覆盖 |

**一句总评：测试体系是「多数强、少数关键假绿 + 环境隔离债」——可以作为开发回归资产，但当前所有「全绿」不能直接当发布判据，尤其不能把 `plugin-check`/`route-test`/`session-calls` 的绿色解读为真实回合、图片抵达或工具参数合规已验证。**

**Top 问题（≤5）**
1. `plugin-check` 的 T03/T04 假绿（HP-01/02）：这是唯一的真实模型插件级主门，两条核心判据可被自身输入满足，当前 HEAD 未修。
2. `route-test` 的 T01 + `tools` 的 T02（HP-03/04）：失败回合可打印 WORKS、全 FAIL 不非零；工具诊断的 initialize 形状已与当前桥不兼容，诊断本身必失败。
3. 真实 profile/模型脚本无 `DSH_HOME`/会话隔离（HP-05）：`plugin-check` 会重写真实 profile 内嵌桥，`route-test`/`tools`/`probe` 会向真实会话库写记录并耗 token；副作用在单个 header 里没有完整披露。
4. 无机器可读清单 + 19 个手工编译步骤共享 `.dbg`（HP-06）：陈旧/并发覆盖的编译树能让下游在旧字节上全绿，这是本目录唯一的地基级风险，上一轮 H1 仍未落地。
5. `session-calls` 的 gate 可空转（HP-08）：无 `request/header` 的合法会话会以 `no schema` 通过并 exit 0，与它自称的「可以当 gate」不符。

**建议优先级**
- **P1（先做）**：修 T03/T04（改为完整事件序列 + 协议层图片块/attachment 断言 + 无图负对照）；修 T01/T02（真实终态 + 失败/超时/取消 + 全失败非零 + 真实 sessionId）；给四个真实 profile/模型脚本加 `DSH_HOME` 或明确 `--allow-real-profile` 开关并在输出中标注 mode。
- **P2**：落地 `harness/manifest.*`（mode/needsBuild/needsProfile/usesModel/mutatesProfile），默认只跑 offline/fake；把 `plugin-check` 的 goal/preset 条件跳过改为 incomplete；`session-calls` 绑定 per-turn schema，无 schema 计 incomplete 并非零；把折叠 oracle 提到共享模块并固定 Paseo 版本。
- **P3**：清理 timer（unref/clear）、隔离 `TMPDIR`、`subagent-check` 临时日志、`plugin-build` 配置输入删除 fail-closed、concurrent-open 补 `session.config` 断言、locale 快照改从真实 header 生成或改名去掉「full scan」表述。

**是否有阻断性健康问题：无 P0/P1 的运行时阻断。** 但如果把本目录当发布门禁，T01–T04 的假绿是**门禁级阻断**：全绿不能证明真实回合、图片抵达与工具参数符合预期；需要先修这四条再谈「所有检查通过」。

## 4. 本次执行记录与未执行清单

**已实跑（纯离线/安全）**
- `node harness/plugin-build-check.mjs` → exit 0，**86/86 passed**（临时副本 + 一次真实 tsc，仓库依赖未被触碰）
- `node harness/doctor-check.mjs` → exit 0，**29/29 passed**
- `node harness/probe-check.mjs` → exit 0，**21/21 passed**
- `node harness/image-host-path-check.mjs` → exit 0，**42/42 passed**
- T03/T04 反例演算（Node heredoc，无文件写入）：完整序列 `assistant→reasoning→assistant` 投影 2 行、assistant-only 过滤后 1 行（判据通过）；零图片块时 `IMAGE-SEEN` 文本命中 `/image/i`（判据通过）
- `session-calls` 空转实测（合成 zstd 会话，`DSH_HOME=/tmp/...`）：无 `request/header` 时 `--- [no schema] tool_a`、**EXIT=0**；无 schema 的 `bad` 键也不计入 invalid

**未执行（及原因）**
- `plugin-check.cjs`、`route-test.mjs`、`probe.mjs`、`tools.mjs`、`catalog.mjs`、`archive-registry-check.mjs`：真实 profile/真实模型，按本任务约束不跑（plugin-check 还会写 live profile 内嵌桥）。
- 假桥/编译插件脚本（`session-request-check`、`concurrent-open-check`、`context-usage-check`、`replay-turn-check`、`assistant-*`、`image-check`、`steer-check`、`subagent-check`、`timeline-check`、`newest-check`、`tool-call-check`、`thinking-check`、`locale-check`、`jobs-*`、`agent-message-check`、`uploaded-file-check`、`style-check`、`sweep-check`）：需要按各 header 编译到共享 `.dbg*`；为不与并行 lane 抢编译树、不重复 `verify-runner`（task-20）的工作，本 lane 只做静态审读，不跑。
- `jobs-popover-check`：需要 `HOST_APP` 指向 Paseo checkout；本环境未提供，按脚本设计应为 exit 2 incomplete。
- `probe-check`/`doctor-check` 覆盖的是对应库，不代表真实安装；真实安装仍需 `doctor` + `plugin-check` 真机门（本报告不重复）。

**未验证项**：HP-05 的实际写盘范围（没有在真实 profile 上执行）；HP-14 的删除 tsconfig 场景（源码推断）；HP-11 的整脚本挂起时长（Node timer 语义推断）；`plugin-check` 的 `permissionApplied` 默认值依赖（需真实 profile 才能确定）。
