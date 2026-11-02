# harness/ 桥相关脚本有效性审查（2026-11-02）

基线：`2f71225`（main，工作区干净；本目录其他报告为并行审查产物）。本次只审 `harness/` 中桥相关脚本的**判据质量**，不把「脚本 exit 0」当产品结论。

方法：逐脚本读头部注释与实现；核对其断言打在协议层还是源码/日志文本；运行纯离线/假桥脚本验证自述（未写真实 `~/.dsh` profile、未起真实模型回合、未跑 `plugin-check`/`route-test`/`rewind-*-e2e`）。已实际运行并通过的脚本（exit 0）：surface、paseo-system-envelope、archived-lineage、image-host-path、file-mutation-gate、snapshot-lifecycle、file-snapshot、rewind-merge、transport-frame、revert-shape、mcp-gateway-transport、bridge-server、rewind-transaction、factory-ownership-order、mcp-http、mcp-stdio、mcp-gateway-guard、frame-reader、fake-bridge-multi、process-crash、multi-session、host-contract-sim（本机宿主为 patched）。`replay-fidelity-probe`/`session-calls` 只读诊断，本次未对真实日志执行。`archive-registry-check` 需要真实 `dsh --profile`，本次未运行。

## 1. 脚本清单

| 脚本 | 执行环境/依赖 | 副作用 | 判据质量 | 残余风险 |
|---|---|---|---|---|
| `fake-dsh-bridge.mjs` | Node 脚本化 stdio peer，被假桥脚本 spawn | 仅写调用方指定的 `DSH_FAKE_LOG`/`DSH_FAKE_ARGV` 文件；不写 profile | 中（夹具，不是独立检查） | 协议由作者手写，不能证明真实 DSH 语义；未实现 `paseo/jobs`（插件会调用，见 H-03）；`hold` 机制无自身校验 |
| `revert-check.mjs` | 离线；编译插件到 `.dbg-t5-revert`，假传输驱动真实 `DshSession`；读 TS/JS 源码 | 构建目录（gitignored） | 中 | 大量接线断言是源码正则/字符串位置而非行为（H-04）；`agent.cancel→whenIdle→nextStep` 顺序未被行为验证 |
| `surface-check.mjs` | 纯模块（`surface.js`），无进程 | 无 | 强 | 只覆盖合成事件；真实日志由 `replay-fidelity-probe` 补，后者可 SKIP |
| `file-snapshot-check.mjs` | 私有临时目录，真实 `FileSnapshots` | 临时文件/日志/对象；结束删除根目录 | 强（核心）/中（安全边界） | 只测末级组件 symlink；祖先目录 symlink 恢复无用例（H-02） |
| `file-mutation-gate-check.mjs` | 纯模块（`FileMutationGate`），无 I/O | 无 | 强 | 只证明闸门模块；`index.js` 的 `beginFileMutation` 接线无覆盖（H-01） |
| `snapshot-lifecycle-check.mjs` | 私有临时目录，真实 `FileSnapshots` | 临时 journal/文件 | 强 | 模块级；未覆盖 `beginOwner` 真实接线（由 factory-ownership 覆盖） |
| `rewind-transaction-check.mjs` | 真实 `PaseoHarnessServer` + 真实 `FileSnapshots` + 合成 ctx；依赖本机 DSH | 私有临时目录 | 强 | 直接调 server 方法，绕过 `index.js` 事件钩子（H-01）；不覆盖 BR-03 锚点接线（H-09） |
| `rewind-merge-check.mjs` | 纯模块 + 私有临时目录 | 临时 journal/workspace | 强（模块）/中（集成） | `server.observeDelegatedTurn`/`server.js:476` 的派发锚无行为覆盖（H-09） |
| `factory-ownership-order-check.mjs` | 真实 DSH `dsh-agent-loop` 工厂 + 真实 `createSession`；依赖本机 DSH | 私有临时目录 | 强 | 只覆盖 create/resume 的 `beginOwner`；不覆盖驳回/失败路径 |
| `bridge-server-check.mjs` | 真实 `server.js`（module resolve hook 映射已装 DSH）+ 合成 services | 无文件/进程；仅对象 | 强 | jobs 段直接调 `rememberToolDescription` 绕过入口（H-03）；dispatch 扫描依赖固定源码格式 |
| `mcp-http-check.mjs` | Loopback HTTP 服务器；无外部服务 | 绑定 loopback 端口、临时响应 | 强 | 无可观察到的高风险；loopback 服务器在 `finally` 关闭 |
| `mcp-stdio-check.mjs` | 真实 `mcp-stdio.js` + 临时假 MCP 子进程；依赖本机 DSH subprocess | 临时脚本/子进程 | 强 | 假 server 不能证明真实 MCP 业务语义 |
| `mcp-gateway-transport-check.mjs` | 依赖本机 DSH schemastery/dsh-tools | 无 | 中 | “neither/拼错键/非字符串”只断言抛错、不点名字段（H-05） |
| `mcp-gateway-guard-check.mjs` | Loopback HTTP + 真实 gateway `apply()`；依赖本机 DSH | 临时图片目录、escape 目录；`server.close()` 在 finally | 强（断言）/中（清理） | gateway 的 `paseo-mcp-images-*` 目录不删除（实测遗留，H-08）；escape 目录只在正常路径删 |
| `transport-frame-check.mjs` | 纯流 + 旧实现 oracle；无进程 | 无 | 强 | 20 MB 墙钟阈值（<1 s、ratio≥5）在重载 CI 可能假红 |
| `frame-reader-check.mjs` | 编译 `frame-reader.ts` 到 `paseo-plugin/.dbg-frame-reader-*` | 仓库内临时构建目录；退出时清理 | 强 | tsc 缺失/编译失败先 `process.exit(2)`、清理未注册（H-08）；同类墙钟阈值 |
| `process-crash-check.mjs` | 编译插件 + 假 `dsh` 子进程 + 一次性 `DSH_HOME` | 一次性 home、构建目录；只杀自己 pid | 强 | 全局 `uncaughtException` 监听只覆盖已断言的窗口；测试进程内吞掉其他异常 |
| `multi-session-check.mjs` | 同上（多会话 fake 模式） | 一次性 `DSH_HOME`、构建目录、自己子进程 | 强 | 个别断言偏弱（`logs.every` 空集可过，H-11）；依赖 5.5 s TTL 真实等待 |
| `fake-bridge-multi-check.mjs` | 直接 spawn 假桥，纯协议 | 自己子进程 | 中（按自述是前置夹具） | 证明的是假桥实现本身，不是真实桥；不能替代插件层 `multi-session-check` |
| `archived-lineage-check.mjs` | 纯模块，无 DSH | 无 | 中 | 期望值手写，未以真实 DSH `underArchivedSession` 为 oracle（H-10） |
| `image-host-path-check.mjs` | 私有文件 + 真实 per-uid 缓存目录 | 写 `tmpdir()/paseo-dsh-attachments-<uid>`（与生产同路径），只删本用例两个文件 | 强（断言）/中（隔离） | 共享缓存不整体清理，H-08；`DSH_HOME` 不覆盖 `TMPDIR` |
| `paseo-system-envelope-check.mjs` | 纯模块，无 DSH | 无 | 强 | 两形 envelope 的字段顺序按单一构造；新增属性形式可能漏 |
| `host-contract-sim.mjs` | 真实 @getpaseo/server `plugin-provider.js` + 编译插件；依赖已装 Paseo | 编译 `.dbg-host-contract`；本地对象 close | 强（补丁宿主）/中（原版半场） | 仅默认宿主那半场随机器而定；原版（stock）半场要按头部手工解包，常规 CI 不跑 |
| `replay-fidelity-probe.mjs` | 读真实会话日志（zstd/zlib）；无 profile 写入 | 无 | 中（诊断） | 无日志/无目标时 `SKIP` 且 exit 0（H-07） |
| `revert-shape-probe.mjs` | 真实 `@deepseek-ai/dsh-session`；依赖本机 DSH | 内存 Session | 强（真实 DSH 写入形状） | 不覆盖桥的 append 集成路径；`DSH_SESSION_MODULE` 默认路径本机专用 |
| `session-calls.mjs` | 读真实 `$DSH_HOME/sessions` 多帧 zstd 日志；诊断 | 只读 | 中（诊断） | schema 按工具名取最后一个 `request/header`，不按调用时序绑定（H-06） |
| `plugin-build.cjs` | 共享构建基础设施；Node + 项目内 tsc | 写/删 `paseo-plugin/.dbg-*` 编译树 | 强（新鲜度判据） | mtime 判据；`PASEO_PLUGIN_BUILD` 与显式目录“不强制新鲜度”是最大的假绿入口（头部已声明） |
| `archive-registry-check.mjs`（相邻，未跑） | 真实 `dsh --profile`（只读 archive 帧） | 装载真实 profile；不创建 agent | 强（真 runtime） | 需要运行中的真实 profile；本次按约束未执行，状态未验证 |

## 2. 发现

| ID | 严重度 | file:line | 触发条件 | 证据等级 | 新引入 vs 基线已有 |
|---|---|---|---|---|---|
| H-01 | P2 | `dsh-bridge/lib/index.js:68-130`；`harness/revert-check.mjs:550-562` | `dsh-bridge/lib/index.js` 的 `startBridge` 事件接线（`tools/execute` → `beginFileMutation`/`captureFileBeforeTool`、`tools/post-execute` → `commitFileTool`/`finishFileMutation`、`tools/execute` → `rememberToolDescription`）没有任何 harness 行为级驱动：`harness/` 里唯一引用是 `revert-check` 的源码正则，且该正则只匹配 `captureFileBeforeTool`，不匹配 `beginFileMutation`/`rememberToolDescription`。删掉/挪动任一 hook、或把 ticket 放到 snapshot 之后，所有离线 harness 仍全绿（`rewind-transaction-check` 是直接调 `server.beginFileMutation`，见 `:288`）。 | 源码检索（`grep -rn "dsh-bridge/lib/index" harness/` 仅命中 `revert-check.mjs:550` 的 `read()`；无任何 harness import 入口） | 结构缺口基线已有；`beginFileMutation`/jobs 描述接线属本轮新增功能的覆盖空白 |
| H-02 | P2 | `harness/file-snapshot-check.mjs:291-316`；`dsh-bridge/lib/file-snapshots.js:659-694` | 用例只把**最终路径组件**做成 symlink（`guard-link.txt`）；捕获后把父目录换成 symlink 的 BR-04 形状没有用例。实测：捕获 `work/a.txt` 后把 `work` 目录换名为 `work-moved`、建 `work -> other`，`restore()` 返回 `restored:['…/work/a.txt']`、`failed:[]`，实际把 `other/a.txt` 覆盖为 `ORIGINAL`，原目录 `work-moved/a.txt` 仍是 `CHANGED`。即 harness 无法发现该 P2 数据/安全缺陷（BR-04 在基线被记为未修）。 | 实测（临时目录复现，未改仓库）+ 源码 | 基线已有（基线 harness 报告已指出只测末级；本轮复现确认仍未覆盖） |
| H-03 | P3 | `harness/bridge-server-check.mjs:443-527`；`harness/fake-dsh-bridge.mjs:761-1191`；`dsh-bridge/lib/index.js:124-129`；`dsh-bridge/lib/server.js:2739-2800`；`paseo-plugin/server/dsh-process.ts:1841` | jobs 描述测试直接调 `server.rememberToolDescription()`，未证明真实入口在 `tools/execute` 调用它；且该段没有断言 `created.length === 0`，而 `jobs()` 的文档要求“不得 materialize 会话”。同时假桥没有 `paseo/jobs` case，插件 `DshProcess.jobs()` 在 fake-dsh 场景必经 `unknown method` 错误，无法形成插件层覆盖。回归：删掉 `index.js:126` 的捕获或让 `jobs()` 调 `getOrCreateSession`，本测试仍绿。 | 源码对照 + grep（`fake-dsh-bridge.mjs` 无 `case "paseo/jobs"`；`bridge-server-check` jobs 段无 `created` 断言） | 新引入（jobs 功能与 jobs 段均为基线后） |
| H-04 | P3 | `harness/revert-check.mjs:272-283`、`:507-512`、`:193-213` | 多处“接线/顺序”断言是源码文本而非行为：`:507-512` 声称验证 `cancel→whenIdle→inbox.nextStep`，实际只测试三个子串在整份 `server.js` 出现（不检查顺序、await 或同一方法）；`:272-283` 只比较 `rewindCanaryNotice(` 与 `request.completed` 的源码字符串偏移，构造但未发出的 canary 也能过。触发：把 `whenIdle()` 移到别处/加 `if(false)`、或 canary 构造后不 `#emit`，文件仍绿（canary 的真实发送顺序另有 `session-request-check.cjs` 行为覆盖，settle 顺序无同等级覆盖）。 | 源码阅读 + 断言语句分析 | 基线已有 |
| H-05 | P3 | `harness/mcp-gateway-transport-check.mjs:112-158` | “neither/拼错键名/非字符串 url”三个用例只断言 `r.error !== undefined`，没有断言错误点名 `probe`/`comand`/`url`；与文件头“拼错键名都必须报错点名”不符。触发：`Config`/`transportOf` 退化为抛笼统 `invalid config` 仍绿。 | 源码阅读；实测当前错误文案确实点名字段（`$.servers.probe ...`、`mcp: server "probe" ...`），证明是判据松而非产品错 | 基线已有 |
| H-06 | P3 | `harness/session-calls.mjs:140-153`、`:265` | `schemasFrom()` 对每个工具名保留整份会话中**最后一次** `request/header` 的 schema，再套到该会话全部历史 `tool/call`。同一会话内换模型/换插件/工具重配后，早先合法调用会被按新 schema 判为 `INVALID`，或新 schema 允许的键在旧调用上被误报。 | 源码阅读（与基线残余风险同项） | 基线已有 |
| H-07 | P3 | `harness/replay-fidelity-probe.mjs:79-83`、`:176-178` | 无会话日志时 `SKIP` 后 `process.exit(0)`；有日志但无可用 human message 时跳过合成 rewind 半场也 exit 0。runner 只按 exit code 会把“未测”当通过。 | 源码阅读 | 基线已有 |
| H-08 | P3 | `harness/mcp-gateway-guard-check.mjs:452-480`、`:570-571`；`harness/image-host-path-check.mjs:83-97`、`:446-448`；`harness/frame-reader-check.mjs:74-108` | 三处隔离/清理不完整：guard 检查跑完在 TMPDIR 留 `paseo-mcp-images-*`（本次实测遗留 `paseo-mcp-images-UQ0u8g`），escape 目录仅在正常路径 `rmSync`；image 检查写与生产共享的 `tmpdir()/paseo-dsh-attachments-<uid>`，只删两个文件；frame-reader 在 tsc 缺失/编译失败时 `process.exit(2)` 早于 `process.on('exit', cleanup)` 注册，会留下 `.dbg-frame-reader-*`。 | 实测（跑后 TMPDIR 内容）+ 源码 | 基线已有（前两项基线报告已提；第三项同类） |
| H-09 | P3 | `harness/rewind-merge-check.mjs:147-163`；`dsh-bridge/lib/server.js:476`、`:1872-1889`；`harness/rewind-transaction-check.mjs:177` | `rewind-merge-check` 只测 `ChildAnchors`/`cancelWithdrawnDelegations` 纯模块；没有任何用例驱动 `server.observeDelegatedTurn` 或 `session.event` 派发（`rewind-transaction-check:177` 是直接 `server.childAnchors.record('child', 20, id)` 注入）。`server.js` 的 anchor 仍取“root 最新 human message”，若记录时机/派发监听回退，harness 全绿。 | 源码检索（`grep -rn observeDelegatedTurn harness/` 无命中） | 基线已有（BR-03 的同型覆盖缺口） |
| H-10 | P3 | `harness/archived-lineage-check.mjs:19-94` | 只 import 端口模块 `archived-lineage.js`，期望布尔值全部手写；没有以真实 DSH `@deepseek-ai/dsh-api-session-controller` 的 `underArchivedSession` 为 oracle。当前端口与已装 DSH（`.../dsh-api-session-controller/lib/index.js:2528-2541`）人工对照一致，但 DSH 升级或移植漂移时检查不会红。 | 源码对照（人工比对已装 DSH 实现） | 基线已有 |
| H-11 | P3 | `harness/multi-session-check.mjs:326-330` | “场景为两个会话都持有帧”断言为 `logs.every((line) => !line.includes("dropped"))`：日志为空时也通过，且“持有”本身无直接证据；目前靠后续 `keeping` 在 5.5 s TTL 的正对照间接兜底。 | 源码阅读 | 基线已有 |

## 3. 健康度与结论

**评分（1-5）**：正确性 4 / 健壮性 3 / 可维护性 3 / 契约一致性 4 / 性能 4 / 安全 3 / 测试覆盖 3。

**一句总评**：桥相关 harness 基本盘很硬——真实模块、真实协议、负向用例与正对照普遍到位，本轮可安全运行的离线/假桥脚本全部通过；但它的“全绿”仍不能覆盖 `dsh-bridge/lib/index.js` 的钩子接线、祖先目录 symlink 与 jobs 路径这三类缺口，此外仍有一批源码正则/文本顺序断言和临时目录隔离问题。

**Top 问题（≤5）**
1. **H-01（P2）**：桥入口事件接线无行为级测试，新的写闸门 ticket 顺序与 jobs 描述捕获可静默回退。
2. **H-02（P2）**：祖先目录 symlink 恢复可越目录写入且报成功，`file-snapshot-check` 只有末级组件用例，完全抓不到。
3. **H-03（P3）**：jobs 功能覆盖不完整——`fake-dsh-bridge` 无 `paseo/jobs`；`bridge-server-check` 绕过 `index.js` 且未断言“不 materialize 会话”。
4. **H-04（P3）**：`revert-check` 的 canary 顺序与 agent settle 顺序仍靠源码文本，不是事件行为。
5. **H-08（P3）**：临时图片目录/共享附件缓存/失败路径 frame-reader 构建目录存在泄漏，污染本机 TMPDIR 与生产同款缓存路径。

**建议优先级**：先补 P2 两项的行为级回归（`startBridge` 的 fake-ctx 钩子注册与顺序；`file-snapshot-check` 增加“捕获后父目录换 symlink”的 restore 用例）；再补 jobs 的插件层 fake 路径与 `created` 反断言；然后把 `revert-check` 的顺序断言迁到事件序列；最后统一清理临时目录（每个 suite 私有 `TMPDIR` + `finally`）。

**阻断性健康问题**：**无 P0/P1**。但 H-01、H-02 属于“全部现有检查通过仍可能漏掉 P1 类缺陷”的覆盖性风险，修复验收前建议把这两条转成会先红后绿的回归。
