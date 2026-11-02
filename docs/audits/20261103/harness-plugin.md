# 插件 / 客户端 / 交付 harness 判据质量审查（2026-11-03）

- 审查对象：`main` HEAD `0c82df5`；工作区只有未跟踪的 `V1.txt`/`v1.txt`，未动。
- 审查范围：插件/客户端/交付相关 harness 脚本 22 个（逐个通读，非抽样），外加修复轮新增的
  `harness/harness-gates.cjs`、`harness/harness-gates-check.mjs`、`harness/isolated-dsh-home.cjs`、
  `harness/bridge-entry-check.mjs`（H-01 的修复产物）。
- 方法：读实现与头部注释 → 判「断言打在协议/事件/终态层还是渲染/日志/宽松正则」「跳过是否算绿」
  「副作用与隔离」「失效形态」→ 用独立假 peer / 合成日志 / 变异副本跑反例（全部在 `/tmp/hp-audit`），
  纯离线脚本实跑。**未**跑真实模型回合、真实 daemon、真实 `~/.dsh` profile；**未**改产品代码、
  文档、harness；无 git 写操作。
- 证据等级：【实测】= 本轮在 HEAD 上运行或反例演算并给出 exit code/输出片段；【源码事实】=
  读代码可确定的控制流/形状；【源码推断】= 由结构推出、未构造运行；【文档】= 仅文档声明。

## 1. 本轮实跑记录（均为纯离线/假桥，不耗 token）

| 命令 | 结果 |
|---|---|
| `node harness/harness-gates-check.mjs` | exit 0，**41/41** |
| `node harness/bridge-entry-check.mjs` | exit 0，**13/13** |
| `node harness/doctor-check.mjs` | exit 0，**37/37** |
| `node harness/probe-check.mjs` | exit 0，**46/46** |
| `node harness/jobs-poll-check.cjs`（按 CI 步骤编译 `.dbg-poll`） | exit 0，**100/100** |
| 私有编译树 `.dbg-hp-audit` 内：`image-check.cjs` / `assistant-stream-check.cjs` / `steer-check.cjs` / `subagent-check.cjs` / `mcp-injection-check.cjs` | exit 0，分别 **8/8、7/7、25/25、90/90、40/40** |
| 显式传私有编译目录：`multi-session-check.mjs` / `process-crash-check.mjs` / `open-degrade-check.mjs` / `session-state-check.cjs` | exit 0，分别 **40/40、13/13、8 passed/0 failed、25/25** |
| `plugin-check.cjs --self-test`（私有编译树） | exit 0，**4/4 self-test passed** |
| 独立假 peer 驱动 `route-test.mjs`（7 条合成路由） | exit 1；`FAILS partial-then-error`、`WORKS clean`、`CANCELED`、`EMPTY`、`UNKNOWN`、`FAILS retry-then-success`、`TIMEOUT` |
| 独立严格 peer 驱动 `tools.mjs` | exit 0；`initialize` 与 `session/prompt` 的 `sessionId` 相同 |
| `session-calls.mjs` 合成会话 | 无 `request/header` → 2；干净 → 0；未声明键 → 1；无调用 → 0；`--tool` 拼错 → 0（见 HP-02） |
| `route-test.mjs` 默认隔离端到端（合成 source home + 假 peer） | exit 0；`DSH home: isolated …`，临时 home 退出后已清理，源 home 两文件未变；source profile 缺失 → exit 2 |
| 变异副本（`/tmp`）：把 T02 旧形状塞回 `tools.mjs` | 严格 peer 拒绝，exit 1，T02 判据 **RED**；把 T03 预过滤塞回 `plugin-check` 源码后，gates-check 的接线断言仍为真（见 HP-03） |

## 2. 健康度评分

| 维度 | 分数 | 理由 |
|---|---|---|
| 正确性 | 4 | 上轮四条主门假绿（T01–T04）与 `session-calls` 空转（HP-08）确已修复，反例能红；残余是 route-test 的假红/死分支（HP-01）与条件跳过（HP-04） |
| 健壮性 | 4 | 真实脚本默认一次性 `DSH_HOME` 已端到端生效、缺源 profile fail closed；`subagent-check` 的 `/tmp` 帧日志仍泄漏（HP-06） |
| 可维护性 | 3 | 仍有 **19 个手工 `tsc`**、其中 **15 个共用同一个 `paseo-plugin/.dbg`**（5 种编译参数）、无机器可读清单；24 个脚本不在 `docs/HARNESS.md`（HP-05/HP-08） |
| 契约一致性 | 3 | T03/T04 的断言已移到协议层，但它们的回归只在 helper 级 + 源码子串（HP-03），`plugin-check` 仍有条件跳过与陈旧匹配（HP-04） |
| 性能 | 4 | route-test 从固定 25 s 改为等真实终态；`tools`/`route-test` 的请求定时器已 `unref`；剩余长等待属真实模型成本 |
| 安全 | 3 | 真实 profile 默认隔离已修（凭据只 symlink）；但 `plugin-check` 真实回合仍切 `danger-full-access`，`/tmp` 帧日志含会话内容且不清理（HP-06） |
| 测试覆盖 | 4 | 84 个脚本、负向/双向对照质量高（本轮实跑 14 组全绿）；缺口在 CI 覆盖（HP-09）、静态快照（HP-07）、文档登记（HP-08） |

**总体 3.7/5**（上轮 3.4）。一句话总评：**修复轮的 T01–T04/HP-08/H-01/HP-05 五组修复经独立反例核查成立，
两个真实环境主门的「全绿」现在有了协议层证据；剩余风险已从「判据假绿」转为「判据维护性/门禁覆盖面」。**

## 3. 发现列表

无 P0/P1。P2 × 1、P3 × 8。

| ID | 级别 | file:line | 触发条件 | 证据等级 | 归属 | 摘要 |
|---|---|---|---|---|---|---|
| HP-01 | P3 | `harness/route-test.mjs:193-201`、`:244-251` | 某路由的模型请求先失败一次、被 adapter 重试后成功完成（`retryPolicy` 生效），或 DSH 成功回合只发 `assistant/attempt` | **实测** + 源码事实 | 新引入（本轮修复引入的 `state.failure` 累积） | 失败标记跨 attempt 不清零 → 能工作的路由被判 `FAILS`（假红）；同时 `record.chunk.type === 'text'` 分支对真实 DSH 的 packed `text-chunks` 形状永不命中，是死代码 |
| HP-02 | P3 | `harness/session-calls.mjs:251-253`、`:288-302` | `--tool` 拼错/过滤后 0 条调用；或会话本身没有 `tool/call` | **实测** | 基线已有（HP-08 只修了「无 schema 的调用」） | 门仍可空转：`--tool no_such_tool` 输出 `showing 0` 并 exit 0；零调用会话 exit 0 |
| HP-03 | P3 | `harness/harness-gates-check.mjs:444-468`；`harness/plugin-check.cjs:43-70` | 有人把 T03 的 assistant-only 预过滤改回去；或 `plugin-check` 的判据被改坏 | **实测**（源码变异后两条接线断言仍真）+ 源码事实 | 新引入（本轮新增的回归判据本身偏弱） | T03/T04 的回归只到共享 helper + 源码子串接线，重新引入 T03 原缺陷不会让任何检查变红；`plugin-check --self-test` 只在 AGENTS.md 里被要求、不在 CI |
| HP-04 | P3 | `harness/plugin-check.cjs:232-240`、`:278-284`、`:336-339` | 默认 profile 无 agent-preset registry（实测 `dsh-base` 不含它）；或用户 profile 默认权限已是 `danger-full-access` | 源码事实 + 文档 | 基线已有（上轮 HP-07/HP-09 未修） | preset 检查打印「not expected」后仍 exit 0；`permissionApplied` 用全局 `until`，若开局的 `session.config` 已是目标值会陈旧匹配 |
| HP-05 | **P2** | 19 个脚本的 `npx tsc` 头（例 `plugin-check.cjs:22-33`、`locale-check.cjs:43-49`、`image-check.cjs:29-38`）；`paseo-plugin/.gitignore:5-6` | 开发者忘记重新编译、或两个脚本用不同 tsc 参数并发编译同一 `.dbg` | **实测**（15 个脚本 `outDir .dbg`；磁盘 33 个 `.dbg-*` 且并行 lane 正在新增）+ 源码事实 | 基线已有（上轮 HP-06，修复轮暂缓） | 无 freshness 校验的共享编译树可让下游在陈旧/错参产物上假绿；无机器可读清单（mode/needsBuild/needsProfile/usesModel） |
| HP-06 | P3 | `harness/subagent-check.cjs:703`、`:1474`（清理清单 `:77-88`）；恒真断言 `:477`、`:876`；`harness/multi-session-check.mjs:580` | 每次运行 `subagent-check` | **实测**（`/tmp/dsh-fake-log-*.jsonl` 42 个，其中 41 个为既有残留；本轮跑一次新增 1 个） | 基线已有（上轮 HP-18） | 两处 `os.tmpdir()` 帧日志不在 exit 清理里；三处 `check(..., true, ...)` 恒真（实际保护来自前置 `until`） |
| HP-07 | P3 | `harness/locale-check.cjs:326-361`、`:410-414` | profile 新挂载工具 / 新 MCP server | 源码事实 | 基线已有（上轮 HP-16） | `MOUNTED_TOOLS`/`FOREIGN_SERVER_TOOLS` 是静态快照（136/25），新工具不会进检查；「the mounted-tool snapshot is the full scan」只钉字面量数量 |
| HP-08 | P3 | `docs/HARNESS.md:3`、`:359`；`AGENTS.md:209-212` | 按 `docs/HARNESS.md` 找「动了哪里必跑」 | **实测**（文件名 grep） | 基线已有（本轮新增脚本已登记，旧缺口未补） | 84 个脚本中 24 个不在 `HARNESS.md`；其中 `p003-live-check.mjs`、`p003-approval-preflight.mjs`、`p003-bridge-check.mjs`、`p003-permission-check.cjs`、`p003-live-support.mjs` 无任何文档；`p003-live-support` 另起一套隔离实现（复制凭据而非 symlink） |
| HP-09 | P3 | `.github/workflows/sync-upstream.yml:64-103`、`:129-148` | 任何 push/PR 改动 | 文档 + 实测（仓库仅此一个 workflow） | 基线已有（上轮 DLV-12 只修了冲突清单一致性） | 没有 push/PR CI，只有每日 upstream sync；至少 20 个纯离线/假桥脚本（image/steer/subagent/assistant-stream/mcp-injection/multi-session/process-crash/session-request/timeline/locale/tool-call/thinking/…）不在任何 CI 门里（本轮实测其中 8 个仍全绿，但没有自动门防退化） |

### 3.1 关键发现详述

**HP-01（route-test 假红 + 死分支）**。修复后的判据本身正确（按 `turn/end` 终态分类、全失败非零），
但新增的 `assistant/attempt` 解析把**任何一次**失败 attempt 的 `state.failure` 永久留下
（`route-test.mjs:197-199`，只在初始化时为 `null`），后续 attempt 成功也不会清。实测反例：合成路由
`retry-then-success` 先发 `assistant/attempt`（`finish.reason.kind=error`）、再发
`assistant/message`+`turn/end completed`，脚本输出
`FAILS p/retry-then-success text="PONG" err=provider exploded` 并 exit 1 —— 一个能工作的路由被判失败。
另外 `:196` 读 `record.chunk.type === 'text'`，而 DSH 的 durable attempt stream 把文本打包成
`{type:'text-chunks', texts:[…]}`（已装 `@deepseek-ai/dsh-llm/lib/types/assistant-stream.d.ts:15-44`，
raw `chunk` 只保留 `block-start/block-end/usage/finish` 等非 delta 记录），所以该分支永不命中；
`gates-check` 的 T01 peer（`:131`）用的也是这个非真实形状，因此回归测试同样抓不到。

**HP-02（session-calls 仍可空转）**。HP-08 的修复把「无 schema / 参数非 JSON」计为 exit 2（实测
noheader=2），但出口只看 `invalidCalls`/`uncheckedCalls`：`--tool` 过滤后 `shown` 为空时循环不执行，
两个计数都是 0 → exit 0（实测 `### clean — 1 tool call(s), showing 0`，exit 0）；没有任何
`tool/call` 的会话同样 exit 0。「一个调用都没检查」与「检查都干净」仍是同一个退出码。

**HP-03（T03/T04 回归的覆盖力）**。`harness-gates-check.mjs:450-458` 的接线断言是
`source.includes('gates.assistantFragmentation(')` 与 `includes('countPromptFramesWithImage(')`；
把 T03 的原缺陷（先 `.filter(item => item.type === 'assistant_message')` 再交给同一个谓词）塞回
`plugin-check.cjs` 的源码副本后，两条断言仍为真（本轮实测），即该回归**抓不到自己声称要防的那个缺陷**。
`plugin-check --self-test`（唯一离线驱动 plugin-check 编译产物与图片翻译的入口，AGENTS.md:196-197
要求跑）不在任何 CI/门禁里；同时它仍走手工编译（HP-05）。

**HP-05（编译基建，P2）**。上轮 HP-06 原样存在：`grep -l "npx tsc" harness/*` = 19 个脚本；其中
`outDir .dbg` 精确同名的有 15 个（`assistant-retry-check`、`assistant-stream-check`、`image-check`、
`locale-check`、`mcp-injection-check`、`newest-check`、`plugin-check`、`session-request-check`、
`steer-check`、`style-check`、`subagent-check`、`sweep-check`、`thinking-check`、`timeline-check`、
`tool-call-check`），编译参数也不一致（既有 `--module commonjs`，也有 `--module node16` 的脚本）；没有任何脚本校验产物
新鲜度（`plugin-build.cjs` 的 freshness 判据只服务另一批 18 个脚本）。本轮审查期间磁盘上当时有 33 个
`.dbg-*` 目录（含本 lane 自建的私有树），且并行 lane 正在新增 `.dbg`/`.dbg-verify-1103` 等目录 —— 共享树被并发覆盖是现实而非假想风险。
后果是「全绿」可能跑在陈旧或错参产物上，而红绿本身看不出区别（上轮 `plugin-build-check` 就是为
这个地基写的，但只覆盖自动构建那一半）。

## 4. 阴性结论

### 4.1 修复轮核查（`6394809` 声称修 T01–T04、HP-08、H-01、HP-05）——**全部成立**

| 项 | 结论 | 证据 |
|---|---|---|
| T01 route-test 假绿 | **已修复** | `route-test.mjs:245-251` 按终态分类、`:280-287` 全失败 exit 1、空路由 exit 2；独立反例：partial+fatal→FAILS、无终态→TIMEOUT、aborted→CANCELED、completed 无文本→EMPTY、blocked→UNKNOWN、全失败 exit 1；干净路由 exit 0；`gates-check` T01 段含旧判据「必然绿」对照（41/41） |
| T02 tools.mjs initialize 无 sessionId | **已修复** | `tools.mjs:130-143` 同一 id 用于两帧；独立严格 peer 实测 exit 0 且两帧 id 相同；变异回旧形状 → 严格 peer 拒绝、exit 1、判据 RED；请求定时器已 `unref`（`:71`），gates-check 断言 15 s 内退出 |
| T03 plugin-check 预过滤 assistant 行 | **已修复**（判据本体） | `plugin-check.cjs:510-522` 把 `timelineItemsWithTurns` 的**完整**事件序列交给 `gates.assistantFragmentation`；`harness-gates.cjs:27-63` 的折叠规则要求「每个 assistant messageId 恰好投影成一行」，且 text-less 工具行也打断邻接（gates-check 有对应断言）；回归覆盖力偏弱见 HP-03 |
| T04 图片证据用模型自报 `IMAGE-SEEN` | **已修复** | `plugin-check.cjs:89-98` 记录插件交给 `DshProcess.prompt` 的 `contentBlocks`，`:537-550` 用 `countPromptFramesWithImage` 断言**精确字节 + mimeType** 出现在帧里，并有「不同字节必须 0 命中」的负对照；旧文本正则只剩注释与 self-test 负例（`:65`）；`--self-test` 4/4 通过 |
| HP-08 session-calls 空转 exit 0 | **已修复**（主要形态） | `session-calls.mjs:245-302`：无 schema/参数非 JSON 计 `uncheckedCalls` → exit 2；独立合成日志实测 2/0/1；残余空转形态见 HP-02 |
| H-01 桥入口钩子无行为级覆盖 | **已修复** | 新增 `harness/bridge-entry-check.mjs`：用模块解析钩子加载**真实** `dsh-bridge/lib/index.js`，断言 `beginFileMutation → captureFileBeforeTool` 顺序、`post-execute` 的 commit→finish、失败路径 drop+finish、未准入不 commit、`rememberToolDescription` 先于工具执行；实跑 13/13，且已进 CI |
| HP-05 真实 profile/模型脚本无隔离 | **已修复**（声明的脚本范围） | `isolated-dsh-home.cjs` 默认克隆 profile + 凭据 symlink + exit 清理，`--allow-real-profile` opt-in；端到端实测 `route-test` 默认 `isolated`、临时 home 已清理、源 home 未变、缺源 profile exit 2；`plugin-check`/`route-test`/`tools`/`stream-probe`/`rewind-e2e`/`rewind-merge-e2e` 全部接入（gates-check 接线段），`rewind-native-check` 强制 `--allow-real-daemon`；`catalog`/`probe` 仍用真实 home，但 AGENTS.md:177 已如实声明 |

### 4.2 上轮遗留项状态（本轮独立复核）

- 已修：HP-01/02（T03/T04）、HP-03/04（T01/T02）、HP-05（隔离）、HP-08（session-calls）。
- 未修：**HP-06（P2，手工编译/共享 `.dbg`）**、HP-16（locale 静态快照）、HP-18（`/tmp` 泄漏与恒真断言）。
- 部分修：HP-07（`/goal` 在默认 profile 由 `dsh-base` 提供，对应检查会真跑；preset 检查在默认 profile
  仍恒跳过，见 HP-04）；HP-09（图片回合的 `until` 已用 `turnId` 切片，`permissionApplied` 仍是全局匹配；
  `reopen replays conversation history` 仍是 `replayed.length > 0`，但后续时间戳/顺序断言已补强）；
  HP-11（`tools`/`route-test` 的请求定时器已 `unref`；`catalog`/`probe` 不在本 lane 范围）。
- 未变：HP-19（`jobs-popover-check` 的 host 半边仍是大量格式化正则，但已新增 `functionBody`/结构读取修复，
  且不设 `HOST_APP` 时 exit 2 明确 incomplete）。

### 4.3 已核查无问题项

- `harness-gates.cjs` 的折叠/分类/退出码/图片谓词与 `plugin-check`/`route-test`/`tools`/`session-calls`
  的实际调用点一致；`projectTimelineLikePaseo` 保留 text-less 行打断邻接（gates-check 有专项断言）。
- `isolated-dsh-home.cjs`：默认/显式/`--allow-real-profile` 三分支行为正确；凭据只做 symlink，
  不复制字节；`DSH_HOME_SOURCE` 可覆盖源树。
- 本轮实跑的 14 组检查全绿（见 §1），其中 8 个脚本（image/assistant-stream/steer/subagent/mcp-injection/
  multi-session/process-crash/session-state）不在 CI，但当前行为健康。
- `jobs-poll-check.cjs` 的 live-only 可见性/图标/轮询间隔/退避/终态码/分页断言与 `client/jobs-polling.ts`
  现行语义一致（100/100）；`jobs-popover-check` 的纯函数与 JSX 结构断言、`source-shape.functionBody`
  的读取器回归都带正/负对照。
- `probe-check.mjs` 的 401/402/403 判 unknown（D2）与 `doctor-check.mjs` 的解析式配置校验（D1）在
  本轮实跑中全绿；两者都有「正向对照」，不会退化成「什么都 fail」。
- 文档侧：`docs/HARNESS.md:210-221` 对 `harness-gates-check`/`isolated-dsh-home` 的描述与实际行为一致；
  `AGENTS.md:123/177/209-212` 对默认隔离与例外的表述与代码一致。

## 5. 未验证项

1. **真实模型/真实 profile 回合**（按任务约束未跑）：`plugin-check.cjs` 完整流程、`route-test.mjs` 真实
   路由、`probe.mjs`、`tools.mjs`、`catalog.mjs`、`stream-probe.mjs`、`rewind-e2e`/`rewind-merge-e2e`/
   `rewind-native-check`、`p003-live-check`/`p003-approval-preflight`、`archive-registry-check`、
   `subagent-live`。T03/T04 判据在真实回合里的红/绿只能由代码与 helper 级反例保证。
2. **HP-01 的真实触发面**：需要 profile 的 adapter 声明 `retryPolicy` 才会出现「失败 attempt + 成功回合」；
   本轮用合成 peer 复现了判据行为，但未在真实 DSH 重试路径上验证（未跑真实模型）。
3. **15 个共用 `.dbg` 的脚本本轮未逐个实跑**（`locale-check`/`timeline-check`/`tool-call-check`/
   `thinking-check` 等）：为避免与并行 lane 争抢共享编译树，只用私有 `.dbg-hp-audit` 跑了 5 个插件级脚本；
   其中 4 个需要不同 tsc 参数（node16）的脚本本轮只做源码审读。
4. **`jobs-popover-check` 的 host 半边**需要 `HOST_APP` 指向 Paseo checkout，本环境未提供（按设计 exit 2
   incomplete），其宿主正则断言未执行。
5. **HP-04 的 `permissionApplied` 陈旧匹配**是否会在某台机器上假绿，取决于该机器 profile 的默认权限；
   未读真实 `~/.dsh` profile，故只报触发条件。
6. **HP-05 的并发覆盖后果**（陈旧产物导致假绿）是源码推断 + 磁盘观察，未构造两个脚本并发编译的实测。
7. **`p003-live-support` 的隔离是否真的可用**（临时 home + 复制凭据 + 真实 DSH）需真实模型运行，未验证。

## 6. 跨 lane 提示

- **verify-runner**：本轮实跑清单与计数见 §1；`jobs-poll-check` 使用 `.dbg-poll`（与 CI 相同命令），其余
  插件级脚本用私有 `.dbg-hp-audit`，未占用共享 `.dbg`。跑全量时注意 15 个脚本共用 `paseo-plugin/.dbg`
  且编译参数不同（`commonjs` vs `node16`），并行跑会互相覆盖，建议串行或改用 `plugin-build.cjs`。
- **delivery / docs**：HP-09（无 push/PR CI，仅每日 sync）与 HP-08（24 个脚本未登记、5 个 p003 脚本无文档）
  属交付/文档域；`p003-live-support.mjs` 与 `isolated-dsh-home.cjs` 是两套隔离实现（前者复制凭据、后者
  symlink），建议统一。
- **harness-bridge**：H-01 已由 `bridge-entry-check.mjs` 覆盖并进 CI，本轮实跑 13/13；该脚本用解析钩子
  替换 `./server.js`/`./transport.js`/`./approval.js`，断言的是钩子**顺序**而不是源码文本，可直接作为
  其余「接线类」断言的范本。
- **plugin-process / plugin-timeline**：`assistant/attempt` 的 durable stream 是 packed `text-chunks`
  （文本） + raw `chunk`（finish 等），route-test 的 HP-01 就是按错误形状解析的实例；产品侧若以后要读
  attempt 文本，必须走 `@deepseek-ai/dsh-llm` 的 expand 路径，不要假设 raw text chunk。
- **plugin-check 的真实回合门**：T03/T04 的判据本体已正确，但回归只到 helper + 源码子串（HP-03）；
  若要把「改坏判据必红」变成真回归，建议把 `imageTurnItems` 投影与图片证据判定抽成可离线驱动的纯函数
  （像 `harness-gates.cjs` 那样），并让 `plugin-check --self-test` 进 CI。
