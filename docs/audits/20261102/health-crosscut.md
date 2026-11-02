# 横切代码健康度审查（2026-11-02）

- 审查对象：`paseo-dsh` 当前 HEAD `2f71225`（main，工作区干净；`docs/audits/20261102/` 为未跟踪输出目录）
- 基线：上一轮全量审查 `9298c28`（`docs/FULL-AUDIT-20261031.md`），本轮 `9298c28..HEAD` 共 51 文件、+7002/−128
- 范围：跨区域（桥 / 插件服务端 / 客户端 / 交付层 / CI / harness）的**全局模式**，不重复各 lane 的单文件缺陷
- 方式：只读（`git show/log/grep`、读文件、npm registry 只读比对）；不修改生产代码，不跑需要 daemon/token/写真实 profile 的脚本
- 证据等级：**实测**＝命令或文件内容直接可见；**源码推断**＝按调用链/语义推断，未运行触发；**未验证**＝列出但无证据
- 标记：`[本次引入]`＝`9298c28..HEAD` 新增；`[基线已有]`＝基线即可见

## 发现

| ID | 严重度 | file:line | 影响面 | 证据等级 | 建议 |
|---|---|---|---|---|---|
| HC-01 | P2 | `dsh-bridge/lib/transport.js:66-67,178-203`；`paseo-plugin/server/frame-reader.ts:74,151` | 同一根管道的两端各有一份增量 NDJSON 分帧器：插件侧有 256 MiB 未终结帧上限（超限整帧丢弃并 `onOverflow` 上报），桥侧**完全没有上限**。桥进程被一个连接上的所有会话共享，任何不换行的超大帧（畸形输出、被 kill 时写一半的帧）会让桥的 `#partial` 数组无限增长 → OOM 即全断。两份实现还会各自漂移（上限只加在了一侧）。 | 源码推断（两侧实现逐行对照；上限缺失为实测） | 把 `DEFAULT_MAX_PENDING_BYTES` + 丢弃上报移植到 `transport.js`；最好把算法收敛成一份可被两侧复制的文本并让 `harness/transport-frame-check.mjs` 增加溢出用例（当前该脚本只测正确分帧，无上限场景）。`[基线已有]` |
| HC-02 | P2 | `paseo-plugin/server/provider.ts:1505-1510`；对照 `paseo-plugin/server/session.ts:952-975`；`provider.ts:1434-1441`；`session.ts:624-629`；`session.ts:1198-1203` | **用户可见路径上的失败只进 stderr**，与同仓库「失败要响亮」的既定做法不一致：(a) `replayHistory()` 内部已经把 `available:false` 转成 `session.notice`（`session.ts:963-975`），但**调用本身抛错**（`paseo/history` RPC 超时/传输失败）时外层 catch 只 `process.stderr.write`，重开会话会呈现**空白对话且无任何提示**；(b) open 时 preset 被拒只写 stderr，而同文件的 permission 被拒会 `openWarnings.push` 成时间线 warning（`provider.ts:1485-1512`）；(c) plan 模式对账失败、子代理枚举失败同样只 log（后者直接 `return`，重开的子会话行静默缺席）。 | 源码推断（错误路径逐条读） | 统一一条「open 降级 → 用户可见 notice/warning」通道；至少 replay 与 preset 必须可见；在假桥用例里让 `paseo/history` 抛错，断言出现 `session.notice`。`[基线已有]` |
| HC-03 | P2 | `paseo-plugin/server/provider.ts:106,152,186-196`；`169-180` | catalog 缓存是**单槽且按 cwd 互斥**（`catalogCache.cwd === cwd`，TTL 5 min）；多工作区使用时两个 cwd 交替请求会每次都 miss，而每次 miss 都 `probeProcess()` 起一个完整 `dsh` 子进程再杀（冷启动，仓库注释实测 1.5–2.7 s）。模型选择器/会话打开在多 workspace 下会反复付出这次启动成本。 | 源码推断（缓存键与 probe 路径实测；耗时取仓库注释中的实测值） | 改成按 cwd 的小 LRU（2–4 条）或全局 catalog + cwd 差异合并；`harness` 里可断言两次不同 cwd 的请求只 spawn 一次（或 N 次）。`[基线已有]` |
| HC-04 | P2 | `README.md:452`；`paseo-plugin/package.json:3`；`README.md:340`；`paseo-plugin/OVERVIEW.md:5`；`paseo-plugin/README.md:18-21` | 版本声明三处互相矛盾：(a) README 版本策略段写「仓库里当前是 `0.2.11`」，实际 `package.json` 是 `0.2.16`；(b) Node 最低版本 `README.md:340` 写 ≥18，`OVERVIEW.md:5` 写 Node.js 22+，package.json 不声明 `engines`（后者是文档化决定，但三处口径必须一致）；(c) `paseo-plugin/README.md:18-21` 的安装首屏仍写「最新 npm 是 0.2.9（2026-10-17）……或等 0.2.10」，而包已是 0.2.16——历史注记未标注为历史。 | 实测（文件逐处对照） | 版本策略段不要写死「当前版本」（或由发布脚本生成）；统一 Node 口径（并给出实测依据）；把 2026-10-20 的 npm 提醒移到变更日志或显式标注「历史」。附：`paseo-plugin.json:requirements.paseo`/peerDeps 的 `>=0.9.2` 与 jobs 新 API 无缺口——实测 npm `@getpaseo/plugin@0.9.2` 已含 `addComposerPill`，`@getpaseo/client@0.9.2` 的 `PaseoAgentActions.list({subscribe})` 签名与 0.14.0 相同，可不动。`[本次引入]`（(a) 历史陈述随版本推进变成漂移） |
| HC-05 | P2 | `.github/workflows/sync-upstream.yml:6-13`（仅 `schedule` + `workflow_dispatch`） | 仓库唯一的 CI 门只在「合并 upstream」时跑，**push/PR 不触发**；而实际开发流程是直接向 main 提交（本轮 8 个提交）。CI 只跑 17 个脚本，harness 共 72 个（实测计数），其余靠人工按 AGENTS.md 清单记得跑。本地 commit 无任何自动兜底。 | 实测（workflow triggers + 脚本计数） | 增加 push/PR 的离线 CI（复用现有 17 项 + `frame-reader`/`replay-turn`/`concurrent-open` 等零依赖项）；用脚本校验 AGENTS.md 的 harness 清单与 CI 列表一致，避免「文档列了、CI 没跑」。`[基线已有]`（本轮仅调整了 CI 内脚本列表） |
| HC-06 | P3 | `dsh-bridge/lib/image-host-path.js:321-338`（`REPLAYED_EVENT_TYPES`）；`paseo-plugin/server/timeline.ts:802-840`；`paseo-plugin/server/session.ts:1011-1075` | 重放**跨层白名单**没有联动断言：桥的 `history()` 只发 `REPLAYED_EVENT_TYPES` 里的事件，插件消费集合是另一份代码。若插件将来消费一个桥未列入的类型，重开会话会**静默少行**（不是报错）。现有 `harness/replay-turn-check.cjs` 用假桥直接驱动 `replayHistory()`，不经过真实桥的 `historyEvents()`/白名单，抓不到这种漂移。 | 源码推断（两份集合同读；harness 数据源结构实测） | 在 `bridge-server-check.mjs` 或新脚本里用真实 `historyEvents()` 跑一组事件，断言输出类型集合 ⊇ 插件消费集合；或把白名单下移到插件侧声明。`[基线已有]` |
| HC-07 | P3 | `isRecord` ×5：`session.ts:251`、`provider.ts:148`、`timeline.ts:35`、`first-token.ts:71`、`tool-call-data.ts:294`；`messageOf` ×3：`session.ts:247`、`provider.ts:144`、`probe-provider.mjs:128` | 同一 3 行语义函数复制 5 份/3 份，且实现细节并不完全一致的风险（`isRecord` 是否排除数组、`messageOf` 是否处理非 Error）。`paseo-plugin/server/json-value.ts` 已是现成的 server 共享模块，却没有承接它们。 | 实测（grep 计数） | server 侧并入 `json-value.ts` 导出 `isRecord/messageOf`；client 侧保留一份即可。属于低风险清理，不要和功能修复混提。`[基线已有]` |
| HC-08 | P3 | `dsh-bridge/lib/mcp-gateway.js:236-247,296-305`；`dsh-bridge/lib/image-host-path.js:85-141` | 两类**进程生命周期内只增不减**的图片缓存：(a) gateway 每进程 `mkdtempSync` 一个目录，每次图片工具结果写一个文件，从不删除；(b) 附件 hostPath 的临时副本目录只写不清理。`server_browser` 是 gateway 白名单里的 stdio server，截图频繁时会持续占用 /tmp，长会话/长驻 daemon 无界。 | 实测（写入点与无删除路径逐条 grep） | gateway 在 `ctx.effect` 的 cleanup（已有 `clients.dispose`）里删本进程目录；附件副本加 TTL/容量 GC，或按会话关闭清理。`[基线已有]` |
| HC-09 | P3 | `paseo-plugin/server/session.ts:409,1972,2681` | 根会话的 `#children: Map` **只有 `set`，全文件没有 `delete`/`clear`**；每个 `DshChildSession` 自带 `TimelineBuilder`。一个根会话跑过 N 个子代理后，所有已结束子代理的行/输出一直保留到根会话关闭。典型用量下可接受，但长会话 + 大量子代理时内存随子代理总输出增长。 | 实测（全文件 grep 无删除路径） | 子代理结束/归档时从 `#children` 摘除（保留必要元数据），或给子视图行数设上限并上报。`[基线已有]` |
| HC-10 | P3 | `paseo-plugin/client/jobs-pill.tsx:64,600-651,683-720`；`paseo-plugin/server/provider.ts:1784-1826`；`paseo-plugin/server/dsh-process.ts:1841` | jobs 新功能的轮询结构：每 agent 一个 4 s `setInterval`（N agent × M 客户端 = N×M 次/4 s 的 RPC，每次在 server 侧遍历连接并读 DSH 注册表）；只有权限拒绝会停表，**其他失败按 4 s 无限重试**（`apply(available:false)` 后继续下一个 tick）。单机多 agent 场景是持续的轮询放大。 | 源码推断（定时器位置/失败分支实测） | 把 `paseo/jobs` 改成按连接聚合一次返回所有 session 的列表（1 次/4 s），或失败做指数退避（上限 30 s）+ 窗口不可见时暂停。`[本次引入]`（jobs 为本轮新增功能） |
| HC-11 | P3 | `dsh-bridge/lib/mcp-http.js:163-168,180-184,216-217`；`dsh-bridge/lib/mcp-gateway.js:528-560`；对照 `paseo-plugin/lib/probe-provider.mjs:82-86,167-179` | MCP HTTP 失败时把响应体前 200 字符拼进 `Error.message`，并经 `mcp_call_tool` 抛给模型；同仓库的 probe 对同一风险做了 key 脱敏（注释明确说「门户会在错误体回显 Authorization」）。`dsh-process.ts:930-940` 也已经为「config 回显 Authorization」修过一次，但**响应体这一路没有脱敏**。若第三方 MCP server 回显请求头，凭据会进模型上下文与日志。 | 源码推断（需 server 回显才触发） | 错误消息只保留状态码 + 按请求头值做替换脱敏；`httpBody` 仅本地日志用且同样脱敏；`harness/mcp-http-check.mjs` 加「响应体含 Authorization 时错误文本不含该值」用例。`[基线已有]` |
| HC-12 | P3 | `dsh-bridge/lib/transport.js:169-176` | 桥写 stdout 只包了同步 `try/catch`；`process.stdout` 全仓无 `'error'` 监听。管道对端消失时 EPIPE 是**异步 error 事件**，会以未处理 error 终止桥进程（服务所有会话），而插件侧只看到 child exit。插件侧同一根管道的另一端（`dsh-process.ts:1440-1455` 的 `child.stdin.on("error")`）已按这个形状修过并有 `process-crash-check.mjs`，桥侧没有镜像。 | 源码推断（未实测 EPIPE 杀进程；缺少监听为实测） | 桥启动时注册 `process.stdout.on('error')`，记录后走既有 `disposeAndExit`；加一个镜像 `process-crash-check` 的桥侧脚本。`[基线已有]` |
| HC-13 | P3 | 无 harness 引用的生产模块：`paseo-plugin/server/activity-timeline.ts`、`paseo-plugin/client/shimmer-css.ts`、`paseo-plugin/client/sweep-native.tsx`、`paseo-plugin/client/text-shimmer.tsx`、`dsh-bridge/lib/subagent-archive.js`（真实桥的 `archive_subagents` 工具注册）；`client/tool-call.tsx`、`client/inline-thinking.tsx` 仅有读源码的 source-shape 断言，无渲染行为断言 | 测试体系覆盖缺口：这些模块回归只能靠真机肉眼。`activity-timeline.ts` 有明确的 throw 语义（未知 `goal/change`/workflow 字段 → `TimelineBuilder` 转 error 行，`timeline.ts:809-816` 有兜底，但没有直接用例）；`subagent-archive.js` 的归档工具在真实桥侧没有任何离线断言（`subagent-check.cjs` 用假桥只覆盖插件的转发）。 | 实测（harness 全量 grep + 清单交叉） | 给 `activity-timeline`（事件形状/throw→error 行）与 `subagent-archive`（工具注册/归档回执）各补一个纯离线单测；客户端动画模块至少接入 `style-check` 的常量断言。`[基线已有]` |
| HC-14 | P3 | `paseo-plugin/server/bootstrap.ts:55-57,112-114,120-124`；`paseo-plugin/server/dsh-process.ts:1412` | `DSH_PASEO_PROFILE` 原样作为路径段 join 进 `$DSH_HOME/profiles/<name>`，随后对该目录做 `rmSync(..., {recursive:true})`/写文件，并作为 `--profile` 参数传给子进程；未校验路径分隔符/`..`。同一 OS 用户可被环境变量指向 profiles 目录之外（同权限，非提权，故为加固项而非漏洞）。 | 源码推断（路径拼接实测） | 校验 `^[A-Za-z0-9._-]{1,64}$` 并拒绝路径分隔符（与 `dsh-process.ts:556` 的 `MCP_SERVER_NAME` 同风格），`doctor` 同步检查并给出可读错误。`[基线已有]` |
| HC-15 | P3 | 无根 `package.json`；`paseo-plugin/package.json` 无 `engines`；`paseo-plugin/tsconfig.json` 仅 `strict: true` | 构建/依赖整体健康但缺统一入口：仓库没有根 manifest/scripts（72 个 harness 全靠手输命令，CI 与人工清单容易漂移）；TypeScript `strict` 已开，但没有 `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`（本仓库大量可选字段 + 条件展开，这两项能抓到的正是这类错误），也没有 lint/format 配置。`dsh-bridge` 无 lockfile 可接受（零运行时依赖 + 被内嵌，19/19 文件由生成脚本 glob 覆盖，`bridge-assets-check` 守护）。 | 实测（配置与文件清单） | 加根 `package.json` 聚合离线检查脚本（`npm test` = CI 那 17 项 + 纯离线 harness），让人工与 CI 共用一份清单；评估逐步开启 `noUncheckedIndexedAccess`（先从桥的 JS 文件迁出的模块试）。`[基线已有]`（本轮 CI 列表有改动） |

### 阴性结论（本次核查过、未发现问题的项）

- **TODO/FIXME/HACK/XXX**：生产代码（桥 / 插件 server+client+lib / local-patches）**0 条**（实测 `grep -rn`）。
- **空 catch / 吞异常**：44 处 `catch {` 全部带注释或明确降级说明（如 `server.js:706` 未渲染块、`764` 缺 default-model 服务、`provider.ts:837` spawn 失败自清理）；`provider.ts:1006-1014` 对「新增 ProviderInput 变体」的兜底明确发 `request.failed` 而不是 `completed`，是正确形状。
- **死代码/未引用模块**：`dsh-bridge/lib` 19 个模块全部被 import 或生成器收录；若干「只被 harness 用」的导出（`image-host-path.js:170 hostImagePath`、`jobs-popover-layout.ts:354/380/405/408`、`tokens.ts` 常量）是测试缝，不建议删。
- **桥/插件重复实现**：`paseo-plugin/server/bridge-assets.ts` 是生成的内嵌副本（6.6 k 行），生成脚本按目录 glob 收录 `.js`（19/19），`harness/bridge-assets-check.mjs` 按字节校验；设计性重复、风险可控。客户端/服务端 locale 表各自只翻译本方绘制的行，中文文案重叠仅 3 条（「计划/更新任务清单/提问」），属有意拆分。
- **资源清理（成对性）**：`provider.ts` 的 `#poolReleaseTimer`（750-777）、`session.ts` 的 `#usageRefreshTimer`/`#usageReplayTimers`（563/790/898/1741）、`dsh-process.ts` 的 `#orphanTimers`（2682-2750，`unref` + TTL + 上限）、客户端 `newest.ts:269-270`/`jobs-pill.tsx:635,732`/`sweep-native.tsx:69-71` 均有创建/释放配对；桥 `server.js` 每会话表在 `closeSession` 统一清理（3327-3350）。
- **无界缓存扫描**：`sessionRoutes`(500)/`toolDescriptions`(200)/`closedSessions`/`initializedSessions` 有修剪，`file-snapshots` 有 1000 anchors 上限 + GC 宽限期 + 对象 GC，`mcp-*` 有 `MAX_TOOL_PAGES`(100)，`newest.ts` 有 `MAX_AGENTS`(200)，`tool-call-data` 有 `MAX_DIFF_CELLS`(250k)/`BODY_LIMIT`；O(n²) 分帧问题两侧均已修（插件侧另有 256 MiB 上限，桥侧上限见 HC-01）。
- **安全其它面**：MCP server 名 `__proto__` 拒绝 + `Object.create(null)`（`dsh-process.ts:569-570,880-886`）；gateway 图片文件名经 `pathSegment` 白名单过滤（`mcp-gateway.js:246-266`，曾修过模型可控路径穿越）；附件副本目录 `0o700` + atomic rename（`image-host-path.js:130-165`）；`probe-provider` 对 key/URL userinfo 脱敏、doctor 只报「credential found」不回显值——这些点做法正确，未列入发现。

## 全仓健康度总结（分维度 1–5）

| 维度 | 分数 | 依据（一句话） |
|---|---|---|
| 正确性 | 4/5 | 协议形状、降级策略、失败语义大多有注释和回归支撑；个别用户可见路径仍会静默（HC-02）。 |
| 健壮性 | 3/5 | 单进程多会话的故障隔离做得细，但两端分帧上限不对称（HC-01）、桥 stdout EPIPE 无监听（HC-12）、降级只进日志（HC-02）。 |
| 可维护性 | 3/5 | 注释质量在本类是高位水平，但单体文件过大（`server.js` 3636 行/53 catch、`session.ts` 3357、`dsh-process.ts` 2816），小工具函数复制多份（HC-07）。 |
| 契约与版本 | 3/5 | 能力声明与数据源一致、fallback 设计克制；但版本声明三处矛盾（HC-04）、`serverInfo.version` 无消费方校验（见 HC-04 附注）、CI 无 push 门（HC-05）。 |
| 性能结构 | 3/5 | O(n²) 大帧两侧已修、大缓存基本有界；catalog 单槽缓存（HC-03）与 jobs 轮询放大（HC-10）是两处结构性浪费。 |
| 安全 | 4/5 | 路径/凭据/权限热点多数已加固并有针对性回归；MCP 错误体回显未脱敏（HC-11）、env 路径段未校验（HC-14）是加固项，无高危绕过。 |
| 测试体系 | 3/5 | 72 个 harness、判据普遍打在协议层（多处用真实类 + 假传输），质量高；但 17/72 进 CI（HC-05）、5 个生产模块零回归（HC-13）。 |
| 依赖与构建 | 3/5 | 依赖面窄（插件仅 peer + devDeps，桥零依赖被内嵌）、锁文件干净；缺根 manifest/lint、无 `noUncheckedIndexedAccess`（HC-15）。 |

**总评：3.4 / 5（健康，非优秀）**。系统的主要优势是「知道自己的失效模式」——注释、FIELD-NOTES、harness 判据共同覆盖了大量静默降级；主要系统性风险是**同一份逻辑存在两处实现时只在一处加固**（分帧上限、EPIPE、脱敏、测试覆盖），以及**交付/版本口径没有单一来源**。

## 优先修复建议（≤10 条，按预期收益排序）

1. **桥入站分帧上限 + 溢出上报**（HC-01）：与插件侧 256 MiB 对齐，补 `transport-frame-check` 溢出用例。改动小，消除单帧 OOM 全断。
2. **重放/preset 失败给用户可见提示**（HC-02）：统一 open 降级通道，补假桥抛错用例。直接消除「重开会话空白无解释」这类最高频误解。
3. **catalog 缓存改按 cwd 小 LRU**（HC-03）：多工作区用户不再每次冷启 `dsh`。
4. **版本声明单一来源**（HC-04）：README 不写死当前版本、统一 Node 口径、历史注记显式标注。
5. **加 push/PR 离线 CI，并与 AGENTS 清单同源**（HC-05/HC-15）：让 72 个脚本的「该跑哪些」由代码而不是记忆决定。
6. **MCP HTTP 错误体脱敏 + 用例**（HC-11）：与 probe 的既有做法对齐，成本低。
7. **桥 stdout `'error'` 监听 + 镜像 `process-crash-check`**（HC-12）。
8. **图片临时目录/附件副本 GC**（HC-08）：gateway 目录随 `ctx.effect` cleanup 删除，附件副本加 TTL。
9. **子代理视图摘除**（HC-09）+ **jobs 轮询聚合/退避**（HC-10）：都属长会话内存/请求量优化。
10. **重放白名单联动断言**（HC-06）+ **零覆盖模块补测**（HC-13）：先加 `activity-timeline`、`subagent-archive` 两个纯离线用例。

## 是否有阻断性健康问题

**没有。** 本次未发现 P0/P1 级横切健康问题；14 条发现中 4 条 P2、10 条 P3，均不阻断当前 HEAD 的发布或运行。最接近阻断的一类（单帧无上限 → 桥 OOM 全断、重放失败空白无提示）都已有明确的触发边界与非破坏性修法，建议按上面第 1、2 条优先处理。
