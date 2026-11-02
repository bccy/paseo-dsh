# plugin-provider 审查：provider.ts / bootstrap.ts

- 审查对象：`paseo-plugin/server/provider.ts`（1834 行）、`paseo-plugin/server/bootstrap.ts`（147 行）
- 代码基线：`2f71225`（main，工作区干净）
- 审查方式：逐行只读通读两个文件；交叉核对 `session.ts` / `dsh-process.ts` / `dsh-bridge/lib/server.js` 的调用契约、已安装 `@getpaseo/plugin@0.14.0` 与 `@getpaseo/server@0.14.0` 的 provider 协议实现、DSH `dsh-home-paths` 的路径语义；运行 `tsc --noEmit`、`harness/concurrent-open-check.mjs`、`harness/multi-session-check.mjs`（均为假桥 + 一次性 `DSH_HOME`，未写真实 profile、未跑真实模型回合）。
- 证据边界：未启动真实 daemon、未跑真实模型、未做 bootstrap 磁盘故障注入、未模拟多连接并发、未跑 iOS/Android。标「未验证」的条目不得当作已确认事实复用。

## 1. 结论

**provider.ts / bootstrap.ts 在本次范围内没有 P0/P1 级阻断性健康问题。**

- `de4ba8c` 的 open 事务修复在当前 HEAD 成立：双身份 claim（原生 session id + provider session id）在第一个 `await` 前同步取得，`close` 可使在飞 open 失效，发布 `session.opened/config/ready` 前后都有身份复核；`concurrent-open-check` 14/14 通过（含 close-during-holder-close、provider id mid-open rebind 两组新场景）。**未发现该提交新引入的正确性缺陷。**
- 多会话池的引用计数与隔离有回归证据：`multi-session-check` 35/35 通过（2 个会话各 1 claim、关 1 个后余 1、存活会话仍可提问）。
- 剩余风险集中在**基线已有、本轮未修复**的跨文件契约问题：S02（catalog 隐藏 Plan 但 session.config 又报回）与 S08（共享进程的 Paseo 身份沿用首会话），以及 `bootstrap` 非原子替换。它们都不是本次新引入，但都应在下一批修复中处理。

## 2. 发现清单

| ID | 严重度 | file:line | 触发条件与影响 | 证据等级 | 新引入 vs 基线已有 |
|---|---|---|---|---|---|
| PP-01 | P2 | `paseo-plugin/server/provider.ts:286-287`、`:310`、`:1565`、`:918`；`paseo-plugin/server/session.ts:675` | 触发：profile 未组合 plan-mode（如叠加了 web-app 的 profile，桥报 `planMode:false`）。catalog 输出 `modes=[build]`，但 provider 在 open/configure 时发出的 `session.config.modes` 来自 `DshSession.configState()` 的无条件 `modes()`（恒含 build+plan）。宿主 `plugin-provider.js:1197-1204` 把该数组发布为 `availableModes`：用户看得见 Plan、选了必然失败。即基线 S02，未修复。 | 源码依据（宿主 0.14.0 实现已核对） | 基线已有（FULL-AUDIT-20261031 S02） |
| PP-02 | P2 | `paseo-plugin/server/provider.ts:602-618`、`:705-719`；`paseo-plugin/server/dsh-process.ts:1416` | 触发：会话 A 打开共享子进程后，会话 B 加入同池，在 bash/terminal 里执行依赖 ambient `PASEO_AGENT_ID` 的 Paseo CLI（heartbeat/schedule/agent send 等）。共享子进程 spawn 时只带首个会话的 env；`#warnEnvDiffers` 把 `PASEO_AGENT_ID`/`PASEO_AGENT_CWD` 当作 daemon 每 agent 注入的噪声而显式跳过，于是 B 的 CLI 会把 A 当作 self/source。仓库内 grep 无任何会话级 shell 身份注入。即基线 S08，未修复；本环境未执行会产生副作用的心跳/发消息探针。 | 源码依据 + 静态闭环（未真机执行身份命令） | 基线已有（FULL-AUDIT-20261031 S08） |
| PP-03 | P2 | `paseo-plugin/server/bootstrap.ts:128-137`；`paseo-plugin/index.server.ts:24-36` | 触发：插件加载期间替换 bridge 时磁盘写入失败/进程崩溃。先 `rmSync` 整个 `node_modules/dsh-paseo-bridge` 再逐文件写入，无暂存目录、无写入后 size/hash 校验；`index.server.ts` 捕获异常后仍照常注册 provider 并打印"profile ready"，随后所有会话都在半份桥上启动失败，直到下一次插件加载才修复。基线审查（`docs/audits/20261031/server.md` 第 4 节 bootstrap 行）已指出。 | 源码依据 + 推断（未做磁盘故障注入） | 基线已有 |
| PP-04 | P3 | `paseo-plugin/server/bootstrap.ts:96-101`、`:124-126`、`:84-94`；`paseo-plugin/lib/doctor.mjs:363-379` | 触发：`$DSH_HOME/profiles/paseo` 已存在（例如用户手工建过同名 profile），其 `package.json` 未把 `dsh-paseo-bridge` 写进 `dsh.profile.bundles`。`writeIfAbsent` 只建缺失文件、从不校验既有文件内容；插件仍报 profile ready，bridge 目录虽在但不会被当成 bundle 加载，所有会话初始化失败；doctor 也只查 profile 目录与桥文件存在性，查不出这个组合。 | 源码依据 + 推断（未复现同名 profile 场景） | 基线已有 |
| PP-05 | P3 | `paseo-plugin/server/provider.ts:203-217`、`:1039-1049`；`paseo-plugin/server/dsh-process.ts:2098-2115`；`dsh-bridge/lib/server.js:1517`、`:1535` | 触发：宿主"导入会话"按工作区传 `cwd`（宿主 `@getpaseo/server@0.14.0` `dist/server/server/agent/plugin-provider.js:791-796` 原样转发）。桥的 `paseo/sessions` 明确支持 `cwd` 过滤，`DshProcess.sessions()` 也接受并下发该参数，但 provider 的 `listDshSessions()` 只把 `cwd` 用作探测进程的工作目录，调用 `probe.sessions()` 时丢掉了 `cwd` 过滤。结果导入列表可跨工作区列出会话（默认上限 40），选中后按当前工作区 cwd 导入会改变会话归属。UI 是否二次过滤未验证。 | 源码依据（三处调用链对照）；UI 影响未验证 | 基线已有（d370542 引入 import 功能时的接线遗漏） |
| PP-06 | P3 | `paseo-plugin/server/provider.ts:1335-1357`；宿主 `@getpaseo/server@0.14.0` `dist/server/server/agent/plugin-provider.js:760`、`:838`、`:1420-1435`、`dist/server/server/agent/create-agent/create.js:107` | 触发：Paseo 内部辅助 agent（worktree 分支名生成、git 元数据生成、模型发现等）以 `persistSession:false` 打开 provider 会话。`ProviderSessionConfig.persist` 在 provider.ts 中从未读取，插件照常让 DSH 持久化会话并返回 persistence handle。后果是这些本应临时存在的会话在 DSH 会话库中累积、出现在"导入会话"列表（并会被当作可恢复会话）。 | 源码依据（宿主 persistSession=false 入口）+ 推断影响 | 基线已有 |
| PP-07 | P3 | `paseo-plugin/server/provider.ts:1430-1437` 对比 `:1481-1497` | 触发：open 时 `config.settings.preset` 被 DSH 拒绝（改名/旧配置/预设被禁用）。preset 失败只写 stderr，不加 timeline warning；而 permission 预设同一类失败会进入 `openWarnings` 并在 ready 后显示"权限预设未应用"。用户看不到 preset 未生效的解释（虽有 `loadPresets()` 回读真实值可让 UI 回弹，但无原因提示）。 | 源码依据（同文件两分支对照） | 基线已有 |
| PP-08 | P3 | `paseo-plugin/server/provider.ts:1359`；`paseo-plugin/server/session.ts:188` | 触发：任何 open。provider 把 `display.thinkingOptions` 传给 `DshSession`，但 `session.ts` 全文件没有读取 `#options.thinkingOptions` 的地方（实际 `#thinking()` 按当前模型的 `models[].thinkingOptions` 取）。这是一个永远不生效的构造参数，误导后续维护者以为 provider 级交集控制着会话的思考档位。 | 源码依据（全文引用检查） | 基线已有 |
| PP-09 | P3 | `paseo-plugin/server/provider.ts:1233-1263`、`:1278` | 触发：同一 DSH 会话已由 provider 会话 P1 持有，P2 以同一 native id 打开但携带一个 DSH 无法挂载的 MCP server。代码先 `await holder.close()` 把 P1 拆掉，之后才 `validateMcpServers()` 并抛错，结果是**一次注定失败的 open 先毁掉了本来可用的会话**。MCP 校验是同步纯函数，完全可以提前到 holder 拆除之前。 | 源码依据（时序）+ 推断 | 基线已有 |
| PP-10 | P3 | `paseo-plugin/server/bootstrap.ts:45-47`、`:116-118`；`paseo-plugin/server/dsh-process.ts:1409-1417` | 触发：某会话的 `config.env` 覆盖 `DSH_PASEO_PROFILE`（Paseo 插件 hook 可改 env）。bootstrap 只在插件加载时按 daemon 自身 env provision 一个 profile，而子进程按"`process.env` + 首会话 env"解析 profile 名并 `--profile` 启动；会话级覆盖会指向未 provision 的 profile，启动失败且没有本地可读解释（dsh-process 注释自认此点）。未验证实际有多少路径能设置该 env。 | 源码依据 + 推断 | 基线已有 |
| PP-11 | P3 | `paseo-plugin/server/provider.ts:1134-1143`、`:1149-1156` | 触发：会话 open 已在进行、被 `session.close` 置为失效，但其事务尚未收尾（例如仍在 holder 的 `close()` / `session.open()` 的跨进程 round trip 中）；此时同一 native 会话的重新 open 到达，会被 `#opening` 拒绝为 "another open for DSH session … is already in flight"。这是 `de4ba8c` 为换取一致性引入的**响亮失败**，不是数据损坏；宿主是否会对该错误自动重试未验证，最坏表现是用户一次"关闭后立刻重开"得到一条失败提示。 | 源码依据 + 未验证宿主重试行为 | 新引入（de4ba8c，设计取舍） |
| PP-12 | P3 | `paseo-plugin/server/bootstrap.ts:45-47`、`:117-118` | 触发：daemon 环境里的 `DSH_PASEO_PROFILE` 含 `..` 或路径分隔符（如 `../../tmp/x`）。`profileName()` 不做字符校验，`join(dshHome(), "profiles", profile)` 会写到 `$DSH_HOME` 之外。env 属于可信配置面，危害有限；但 provisioning 是插件自动执行的文件写操作，至少应拒绝含分隔符的 profile 名或明确记录解析后的绝对路径。 | 源码依据 | 基线已有（安全卫生） |

## 3. de4ba8c open 事务专项复核（重点）

已逐段对照 `de4ba8c` 的 provider.ts 增量与当前实现（`provider.ts:1130-1157`、`:1177-1187`、`:987-1001`、`:1515`、`:1564-1573`）：

1. **双身份 claim 的时序正确。** `#openTransaction` 在同一个同步 turn 内完成 `#opening.has(nativeId)`、`#openingProviders.has(sessionId)` 两次检查与两次写入，第一个 `await` 在其后；不存在"检查后让出"的窗口。`finally` 按对象身份删除 provider 侧 claim，不会被后续事务误删。
2. **close 失效通道正确。** `session.close` 在异步 teardown 之前同步把对应 `opening.closed` 置真；`#assertOpening` 同时校验连接、provider claim 对象、`#sessions` 实例身份，覆盖"connection 被关 / 会话被关 / provider id 被后续 open 接管"三种失效。
3. **发布段检查正确。** `session.opened` 后、`session.config` 后各复核一次；`session.ready` 之后采用"若已被关闭则静默返回"而不是抛错，避免在已发布 ready 后补发 `request.failed`。与宿主 `openSession` 的 catch（`@getpaseo/server@0.14.0` `dist/server/server/agent/plugin-provider.js:117-152`，catch 在 145-151 删除自身 maps）行为一致。
4. **失败清理正确。** `#open` 的 catch 按实例身份删除 `#sessions` 条目并 `session.close({park:false})`；`DshSession.close()` 首行 `#closed` 幂等保护使"reentrant close + catch 再 close"不会双重 detach；`DshSession.open()` 在 acquire 后、attach 前重新检查 `#closed`，把已取得的池 claim 归还，避免 claim 泄漏（`session.ts:583-600`）。
5. **回归实测**：`node harness/concurrent-open-check.mjs` → **14/14 PASS, exit 0**。覆盖：同 provider id 两并发 open 一胜一响亮失败且胜者可用；close 落在 holder `session/close` 的 await 中使 open 失效且不发布 opened/ready；同一 provider id 在 open 中途被重绑到另一 native id 被拒且只发布一次 readiness。
6. **未覆盖窗口（未验证）**：close 落在 `session.open()` / `loadCommands()` / `replayHistory()` 的 await 中、以及 `session.opened` 监听器内同步回发 `session.close` 的 reentrancy——静态推理会被发布段 `#assertOpening` 拦住，但没有对应假桥场景；`DSH_FAKE_HOLD_*` 目前只支持 `session/close` 与 `paseo/commands` 两个停点。

另核对：池 claim 计数为 `Map<DshProcess, number>` 按 child 实例记账（`provider.ts:413`、`:664-682`、`:740-761`），`#releasePoolProcess` 对旧 child 也归还，不会因 `#pooled` 已换代而漏减；`multi-session-check` 35/35 实证 2 会话 2 claim → 关 1 个余 1 且存活会话可继续提问。占位 session id `__paseo_shared_process__` 现状：`#prepareProcess` 发送**不带 sessionId** 的 process 级 `initialize`（`dsh-process.ts:1487-1530`），构造 id 只存在于本地 handlers/options 表（`dsh-process.ts:1178`、`:1407`），不会写入桥的 `sessionCwd/sessionRoutes/initializedSessions/pendingMcpServers`，无需额外清理。

## 4. 已核对未发现问题的区域

- **provider 注册**：`id/label/icon` 完整（icon 文件存在）；`version=1` 与 `PROVIDER_PROTOCOL_VERSION` 一致；不注册 `before("agent.session_open")`（符合仓库硬约束）。
- **能力声明**：逐项与 SDK `PROVIDER_CAPABILITIES` 及实现核对，未发现过度声明；`session.revert.files` 故意不声明（桥无 files-only 撤回），`toolPolicy.preapproved` 故意不转发且注释说明了原因。
- **catalog 生成**：provider-wide thinkingOptions 取交集、默认档位只取交集内值、`planMode:false` 时过滤 Plan 的方向正确（缺口仅 PP-01 的 session.config 双源）；`catalog` 失败会回 `request.failed` 而非挂起。
- **持久化 handle**：open 发出的 `persistence.data.sessionId` 是 native DSH id（导入会话保持原 id），`sessions` 列表为每个存储会话重新生成同形 handle；archive/unarchive 通过 handle 解析 native id，解析失败响亮抛错。
- **归档路由**：四层 carrier（持有者 → 其他 open root → 共享池进程 → 一次性 probe）保证写落在"回答 gate 的那个进程"；`pooled === undefined` 才允许 tier4，且有活池时拒绝 probe 写并说明原因（`provider.ts:1640-1708`）。本仓单连接模型下未发现可达缺陷。
- **错误回执**：`send()` 的 requestId/sessionId 两级兜底会把未知 input、未知会话都变成显式失败；`DshSession.prompt` 自己把翻译/请求错误收敛为 `session.prompt_result.failed`，不会误升格为 `session.runtime_failed`（`session.ts:1395-1429`）。
- **jobs RPC**：`readAgentJobs` 对"无连接/无会话"返回 `available:true` 空列表、"有会话但读失败"返回 `available:false`，与 `shared/jobs.ts` 的语义边界一致且注释已说明；连接关闭时注销，不会遍历死连接。

## 5. 健康度评分

| 维度 | 评分 | 依据 |
|---|---|---|
| 正确性 | 4/5 | open/close 事务、池引用计数、持久化 handle 与错误回执经代码核对与两项回归通过；S02 的 modes 双源仍是确定的用户可见不一致 |
| 健壮性 | 4/5 | 失败路径普遍响亮且清理完整（spawn kill、claim 归还、reentrant close 幂等）；bootstrap 半份产物与 PP-09 的"先破坏后验证"扣分 |
| 可维护性 | 3/5 | 单文件 1834 行、注释体量很大；存在死参数（PP-08）、`listDshSessions` 返回类型注解与实际字段漂移（`createdAt?: number` 实际为 `preview/updatedAt`）等小腐化 |
| 契约一致性 | 3/5 | 能力声明与实现基本一致；但 S02、`persist`（PP-06）、`cwd`（PP-05）三处 provider 契约字段/能力数据源没贯穿到底 |
| 性能 | 4/5 | 单池共享进程、catalog 5 分钟缓存、空闲 5s 宽限避免冷启动；catalog/sessions/archive 每次缓存失配都起一次完整 `dsh` 探针（1.5–2.7s 级），导入列表未缓存，属可接受但有上限的空间 |
| 安全 | 3/5 | 警告只报 env key 名、不泄值（好）；但进程级 env 使跨会话可见（含潜在 secret）与身份串用（PP-02），profile 名未规范化（PP-12） |
| 测试覆盖 | 4/5 | concurrent-open 14/14、multi-session 35/35、tsc 通过；缺口在 close 落在 session.open/loadCommands/replay 的窗口、opened 回调重入、bootstrap 写失败、archive 多进程一致性 |

**总评：** provider.ts 主体是健康的——open/close 事务与共享池在本次 HEAD 上成立且有可复跑回归，剩余问题主要是跨文件契约与 bootstrap 交付健壮性，均非本轮新引入；**无阻断性健康问题**。

**Top 问题（≤5）：**
1. PP-01（P2）S02：catalog 过滤 Plan 与 session.config 报告 Plan 双源不一致。
2. PP-02（P2）S08：共享进程环境下第二个会话沿用首个 agent 的 Paseo CLI 身份。
3. PP-03（P2）bootstrap 非原子替换 bridge，失败后仍注册 provider 并把半份桥留到下次加载。
4. PP-04（P3）既有 profile 的 package.json 未声明 bridge bundle 时，provisioning/doctor 都报健康但会话必失败。
5. PP-05（P3）`sessions` 请求丢弃 `cwd` 过滤，导入列表跨工作区。

**建议优先级：**
- 先修 P2：S02（把 `advertisedModes` 作为唯一能力源贯穿 catalog/open/configure）、S08（会话级 caller 身份注入，或让依赖 self 的 CLI 路径明确失败）、bootstrap（代际暂存 + 校验 + 原子切换，失败保留旧代际）。
- 再排 P3：PP-04 校验既有 package.json bundles（doctor 同步补）、PP-05 把 `input.cwd` 传到 `probe.sessions({ cwd })`、PP-06 至少不向 Paseo 广告临时会话的 persistence、PP-07/PP-08/PP-09 一致性清理。
- PP-11 建议先在宿主侧确认失败提示/重试体验，再决定是否需要给"失效后收尾中的 open"做短时等待。

## 6. 本次实际执行的验证

| 命令 | 结果 | 说明 |
|---|---|---|
| `cd paseo-plugin && npx tsc --noEmit` | exit 0 | 真实 tsconfig，类型兼容 |
| `node harness/concurrent-open-check.mjs` | 14/14 PASS，exit 0 | 假桥 + 一次性 `DSH_HOME`；覆盖同 provider 并发、close 中失效、provider rebind |
| `node harness/multi-session-check.mjs` | 35/35 PASS，exit 0 | 假桥 + 一次性 `DSH_HOME`；覆盖会话隔离、claim 2→1、env 差异告警只报 key 名 |

未执行：真实 daemon/真实模型回合（`plugin-check.cjs`、`probe.mjs`、`route-test.mjs`）、`bridge-assets-check.mjs`（由 verify-runner 覆盖）、bootstrap 写失败注入、多连接归档模拟、真机 UI。
