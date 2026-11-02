# local-patches 宿主补丁审查（2026-11-02）

- 审查基线：`2f71225`（main，工作区干净）；上一轮全量审查基线 `9298c28`（`docs/FULL-AUDIT-20261031.md`，重点 L1 / D2）。
- 范围（逐行）：`local-patches/apply-rewind-history-truncation.mjs`（2769 行）、`local-patches/check-rewind-patch.mjs`（400 行）、`local-patches/startup-patch-hook.cjs`（324 行）、`local-patches/UPGRADE.md`、`local-patches/README.md`。
- 环境：本机已装 `@getpaseo/cli` / `@getpaseo/server` 0.14.0；干净备份 `plugin-provider.js.orig-20261029155808-c763a310`（md5 `c763a310…`），当前已打补丁文件 md5 `b4b46740…`；`agent-manager.js` 干净备份 md5 `499401c5…`，当前已打补丁 md5 `0e6a493c…`。
- **基线归属**：`git diff 9298c28..HEAD -- local-patches/` 为空，`git rev-parse 9298c28:local-patches/apply-rewind-history-truncation.mjs` 与 HEAD 同为 `824ffc17…`；本报告所有发现均为**基线已有**，无本轮新引入。
- 证据边界：只读代码与已装 dist；运行了无副作用的 `apply … --check`、`check-rewind-patch.mjs`、`node --check`，以及纯内存字符串变异复现（未 apply / 未 revert / 未改任何目标文件）。真实 daemon 撤回、Paseo 0.15 / Electron 打包版、macOS 桌面版、CRLF/多行尾混合等未验证。

## 结论

当前 0.14.0 上补丁在位且两套自检均 `exit 0`，主路径可用；**没有 P0/P1 阻断性问题**。但存在 **2 个 P2**：stale 重建的替换边界会删掉 `revert()` 尾部无关语句；检查器不验证 apply 真正依赖的运行时字段形状，会在 apply 必然拒绝时仍报“可自动打”。这两项都应在下一次 Paseo 升级前处理。

## 发现总表

| ID | 严重度 | file:line | 触发条件 | 证据等级 | 新引入 vs 基线已有 |
|---|---|---|---|---|---|
| LP-01 | P2 | `local-patches/apply-rewind-history-truncation.mjs:1332-1355`、`:1372-1394`（调用 `:1663`） | 存量文件已有本补丁且 METHOD/CALL 判定为 stale；同时 `revert()` 的 `await this.bridge.revert({...});` 之后还有其它上游/本地语句（另一个本地补丁、上游新增 tail、日志/清理语句） | 实测（纯内存复现，见「关键证据」）+ 源码推断；同一问题在上一轮 L1 已记录 | 基线已有（文件与 9298c28 完全相同） |
| LP-02 | P2 | `local-patches/check-rewind-patch.mjs:42-55`、`:131-263`；`local-patches/apply-rewind-history-truncation.mjs:1469-1481`、`:1505-1533`、`:1544-1563`、`:1741-1760`、`:2666-2733` | 上游保留两个插入锚点、但重命名 `this.timelineSnapshots` / `this.revertTokens`（或文件其它类仍保留这些字符串）时：check 报 `patchable` / `ok:true`，apply 实际以 `host-fields-changed` 拒绝；#7675 形状（或仅注释里出现 `this.history.read(`）时 check 仍可能报 patched/current，而 apply 以 `upstream-history-shape-changed` 拒绝 | 实测（内存变异：`hostFieldShapes` 返回 `ok:false`，同文件仍 `markers=0, anchorA=1, anchorB=1, upstreamFix=false`，check 路径判定为 `patchable`）+ 源码推断 | 基线已有 |
| LP-03 | P3 | `local-patches/apply-rewind-history-truncation.mjs:578-604`；`local-patches/check-rewind-patch.mjs:219-235` | `revert()` 方法体内出现**注释或字符串**形式的 `this.history =` / `this.history.splice(` / `this.history.pop(`（例如调试注释、迁移说明）；`detectUpstreamSelfFix` 会把它当成上游已自修，apply 报 `upstream-fixed-retire-patch`，check 以 `exit 4` 指示删除补丁 | 实测（向干净备份的 `revert()` 内插入一行注释后，函数返回 `{"fixed":true,"hits":1}`） | 基线已有 |
| LP-04 | P3 | `local-patches/apply-rewind-history-truncation.mjs:1344-1349`、`:1150-1184` | 上游在 `bridge.revert({...})` 参数里加入嵌套回调（出现更内层的 `});`），或 `revert()`/METHOD 内出现含 `{`/`}` 的正则字面量：`locateRewindCallRegion` 的 `callEnd` 不校验 `});` 缩进是否等于 await 缩进；`matchClosingBrace` 不识别正则字面量，可能截断错位置或判无闭合 | 源码推断（当前 0.14.0 形状简单，未触发；当前干净/补丁文件均已实测正常） | 基线已有 |
| LP-05 | P3 | `local-patches/apply-rewind-history-truncation.mjs:1685-1701`、`:2060-2076`（对照主路径 `:1848-1880`） | 临时目录不可写/磁盘满导致 `syntaxCheck` 抛 `SYNTAX_CHECK_UNAVAILABLE`，且此时走 stale 重建分支：被归为 `stale-rebuild-unparsable` / `turnid-stale-rebuild-unparsable`，错误文案把环境问题说成“补丁内容不解析”，并丢掉可用性分类 | 源码推断（分支差异明确） | 基线已有 |
| LP-06 | P3 | `local-patches/check-rewind-patch.mjs:57-59`、`:197`、`:249`、`:260`、`:293`、`:380` | 自定义 `REWIND_PATCH_HOME`（README 定义它只放备份与 status）时，checker 的 `APPLY_SCRIPT` 仍用 `${REWIND_PATCH_HOME}/apply-rewind-history-truncation.mjs`，所有提示与 `--json.applyScript` 指向不存在路径 | 实测（`REWIND_PATCH_HOME=/tmp/nonexistent-rewind-home` 运行 `--json`，返回 `applyScript: /tmp/nonexistent-rewind-home/apply-rewind-history-truncation.mjs`） | 基线已有 |
| LP-07 | P3 | `local-patches/startup-patch-hook.cjs:307-323`；对照 `local-patches/apply-rewind-history-truncation.mjs:2581-2618` | 仅 `turnId` target 失败（apply 退出 1）或仅 `turnId` degraded（apply 退出 3）时，钩子仍记录 “rewind will not reset” / “SECOND rewind in a session will fail”；`turnId` 故障实际只影响重开会话后的回合折叠。钩子注释写 “Exit 2 = …”，而 apply 实际只会返回 0/1/3 | 源码推断（当前本机日志只有成功记录，未构造 turnId-only 失败） | 基线已有 |
| LP-08 | P3 | `local-patches/apply-rewind-history-truncation.mjs:86-111` | systemd/最小 PATH 环境中 `paseo` 不在 PATH（且未设 `PASEO_CLI_ROOT`）：`resolvePaseoCliRoot` 返回 `null` → `TARGET` 为空 → `target-missing`，补丁静默不生效。函数注释声称会回退到 `<npm global root>/@getpaseo/cli`，实现没有该回退 | 源码推断；本机 `paseo.service` 的 `Environment=PATH=…/.npm-global/bin:…` 实测包含 paseo，故当前机器未触发 | 基线已有 |
| LP-09 | P3 | `local-patches/apply-rewind-history-truncation.mjs:167-176`；`local-patches/README.md:159-171`；`local-patches/startup-patch-hook.cjs:235-270` | Paseo 0.15+/未来版本只改 `mapTimelineItem`/`streamHistory` 的语义而保留锚点与字段名时，补丁可能变成运行时 no-op；文档没有兼容版本矩阵，只记录 0.13.0 的 `BASE_MD5`。此外钩子按三个 basename 硬编码入口，Paseo 重命名 entry 时钩子会在不写日志的情况下直接 return（静默丢失 App 内升级覆盖） | 源码推断 + 本次实测 0.14.0 干净副本 `anchorA=1, anchorB=1`、各字段形状存在（说明 0.14.0 可用，但不构成未来版本保证） | 基线已有 |
| LP-10 | P3 | `local-patches/check-rewind-patch.mjs:73-79`、`:348-357`；`local-patches/UPGRADE.md:91-98` | 维护者阅读代码注释时被误导：注释说姊妹补丁“never change the exit code”，实际 `combinedExitCode` 会把 `turnId` 的 not-patched/stale-body 拉高到 1、half-patched 到 2、target-missing 到 3；UPGRADE 已正确描述合并退出码 | 实测（代码路径 + 当前 checker 输出：两姊妹均 OK 时 exit 0；`--json.exitCodeFrom` 字段存在） | 基线已有 |
| LP-11 | P3 | `local-patches/apply-rewind-history-truncation.mjs:2628-2655` | 运行 `node apply-rewind-history-truncation.mjs --help`、`--dry-run` 或把 `--revert` 拼错：未识别的参数不报错，直接走 apply 并可能改写已安装 dist | 源码推断 | 基线已有 |
| LP-12 | P3 | `local-patches/check-rewind-patch.mjs:299-311`；`local-patches/apply-rewind-history-truncation.mjs:2654`；`local-patches/UPGRADE.md:106-108` | 用户先手动跑 `--revert`（或手动 apply）后再运行 checker：`rewind-patch.status.json` 被改写为 `ok:true / reason:reverted`，但 checker 输出标题仍叫“上次 ExecStartPre 记录”，容易被读成“上次 ExecStartPre 成功”，而此刻补丁其实不在位 | 源码推断 | 基线已有 |
| LP-13 | P3 | `local-patches/UPGRADE.md:33-50` | 复用者按 UPGRADE 第 1 节执行升级前自唤醒：`restart-with-wake.mjs` / `selfwake.mjs` 不在仓库（`git ls-files local-patches` 只有 README、UPGRADE、3 个脚本），无法复现该流程；上一轮 client-delivery 报告已指出同类文档问题 | 实测（仓库文件清单） | 基线已有 |

## 关键证据

### 0. 当前 0.14.0 的正面核验（实测）

- `node --check` 对 3 个脚本均通过。
- 已装 `@getpaseo/cli@0.14.0` 的 `@getpaseo/server@0.14.0`：
  - 干净备份 `plugin-provider.js.orig-20261029155808-c763a310`：`anchorA=1`、`anchorB=1`；`this.history = []`、`this.history.push(`、`this.timelineSnapshots = new Map()`、`this.timelineSnapshots, this.revertTokens`、`this.revertTokens = new Map()`、`this.revertTokens.get(` 均存在（`hostFieldShapes` 会通过）。
  - 当前已打补丁文件：`markers=2`、`rewindPatchStaleness.current=true`；`apply-rewind-history-truncation.mjs --check` 输出 `rewind: OK — patched (2/2 markers, body current)`、`turnId: OK — patched (2/2 markers, body current)`，**exit 0**。
  - `check-rewind-patch.mjs` 对当前文件：`state: patched`、`sisters both OK`，**exit 0**。
  - `agent-manager.js` 干净备份 `TURNID_CALL_RE` 命中 2 次、两个上下文分别为 `if (broadcastTimeline) {` / `if (deferredBroadcast) {`；当前打补丁文件 `turnIdStaleness.current=true`。
- 因此：**0.14.0 的当前锚点/字段形状对这套脚本可用**；但这只是本机当前安装的实测，不等价于版本矩阵。

### 1. LP-01：stale 重建会删掉 `revert()` 尾部无关语句（P2）

`locateRewindCallRegion()`（`apply-rewind-history-truncation.mjs:1332-1355`）的替换区是：

- `start`：`await this.bridge.revert({...});` 结束的 `});` 之后；
- `end`：`revert()` 方法最后的闭括号所在行之前（`source.lastIndexOf("\n", close) + 1`）。

中间若还有别的语句（另一个本地补丁、上游新增的清理/日志/收尾逻辑），`rebuildRewindCall()`（`:1372-1394`）会把它们全部替换为 `CALL`。脚本没有校验该区间只含自己的 CALL，也没有 marker/AST 边界。

纯内存复跑（从真实源码 AST 取 `locateRewindCallRegion/rebuildRewindCall/reindent/normaliseEol`，fixture 在 CALL 后追加 `this.upstreamCleanupAfterRewind();`；不导入 apply、不写文件）：

```json
{"unrelatedTailPresentBefore":true,"unrelatedTailPresentAfter":false,"changedSourceParses":true,"transformationOnly":true}
```

即：**无关 tail 语句消失，结果仍可解析**。这与 `local-patches/README.md:146-148` 的“只替换目标块（方法体 + `revert()` 里的调用），文件里别的东西一律不碰”和 `:161` 的“不会静默打错位置”直接矛盾；与上一轮 `docs/FULL-AUDIT-20261031.md:101` 的 L1 同源。触发是窄条件（不是当前干净 npm 升级必现），但一旦发生就是无声的代码删除。建议把替换区限定为自有 CALL 的 marker/AST 块；发现 CALL 与外层闭括号之间存在额外语句时 fail closed（保留原文件）。

### 2. LP-02：checker 与 apply 的运行时形状门禁不一致（P2）

`applyRewindPatch()` 在 **clean 文件**上会做两类实际影响运行的检查：

- `upstreamHistoryObjectShape()`（`:1469-1481`）在 `:1549-1563` 以 `upstream-history-shape-changed` fail closed；
- `hostFieldShapes()`（`:1505-1533`）在 `:1748-1760` 以 `host-fields-changed` fail closed，检查 `this.history` / `this.timelineSnapshots` / `this.revertTokens` 的若干字面量。

但：

- `check-rewind-patch.mjs` 的 `inspect()`（`:131-263`）只做 MARKER 计数、anchors、`detectUpstreamSelfFix`、`rewindPatchStaleness`；它的 import 清单（`:42-55`）没有也不导出 `hostFieldShapes` / `upstreamHistoryObjectShape`。
- `applyRewindPatch()` 自身的 `--check` 路径 `checkBothTargets()`（`:2666-2733`）同样只查 marker + staleness。
- 因此，当上游保留 `publish(event)` / `revert()` 锚点但重命名 `this.timelineSnapshots`（或 `this.revertTokens`）时：
  - 干净文件：checker 会报 `state: patchable`、`ok: true`、`exit 1`，并提示“下次启动 ExecStartPre 会自动打上”；
  - 实际 apply 会在 `host-fields-changed` 处 `exit 1`，daemon 继续以无补丁状态启动；checker 下次仍给出同样的“可自动打”。
  - 内存变异验证：把干净备份中的 `this.timelineSnapshots = new Map();` 改为 `this.timelineCache = new Map();` 后，`hostFieldShapes` 返回 `{"ok":false,"field":"this.timelineSnapshots","missing":["this.timelineSnapshots = new Map()"]}`；同一变异源仍满足 `markers=0, anchorA=1, anchorB=1, upstreamFix=false`，按 `inspect()` 分支正好落入 `patchable`。
- 另一面：#7675 守卫是文件级子串（`:1469` 的 `new PluginSessionHistory(` / `this.history.read(`），仅出现在注释里也会命中；此时 apply 拒绝而 checker 不知道这是 #7675，仍可能显示 patched/patchable。`hostFieldShapes` 同样是**文件级**子串：0.14.0 干净文件中 `this.history = []` 出现在 `ProviderRuntimeSession:455` 与 `PluginAgentSession:886` 两处；`this.history.push(` 出现在 `ProviderRuntimeSession:664`、`PluginAgentSession:1095/1295` 三处——因此“文件里有这些字符串”不能证明被插补丁的目标类有这些字段。

建议：把 `hostFieldShapes` / `upstreamHistoryObjectShape` 导出并在 `check-rewind-patch` 与 `apply --check` 中复用；至少把检查结果分区为 `host-fields-changed` / `upstream-history-shape-changed`，不要折叠成 `patchable`。若要真正验证运行时形状，应在目标类边界内匹配，或用 AST 确认 `PluginAgentSession` 的构造函数字段与 `publish/revert` 所在类。

### 3. 其他 P3 证据摘要

- **LP-03**：`HISTORY_MUTATION_RE`（`:578`）直接在 `revert()` 的原始 slice 上 `matchAll`，没有剥离 `//` / `/* */` / 字符串；实测往干净 `revert()` 插一行 `// NOTE: this.history = [] is reset elsewhere` 后，`detectUpstreamSelfFix` 从 `{"fixed":false}` 变为 `{"fixed":true,"hits":1,"sites":["// NOTE: this.history = [] is reset elsewhere"]}`。后果不是小问题：`apply` 会拒绝打补丁并提示“上游自修”，`check-rewind-patch` 以 `exit 4` 指示删除补丁——用户可能因此把仍在工作的本地补丁删掉。
- **LP-04**：`callEnd = /\r?\n([ \t]*)\}\);\r?\n/`（`:1347`）没有把捕获的缩进与 `awaitLine[1]` 比较；“第一个 `});`”假设在上游增加嵌套回调时不成立。`matchClosingBrace`（`:1150-1184`）跳过字符串/注释，但不识别正则字面量（`/}/`），也不处理模板 `${…}` 内的嵌套反引号；当前宿主文件两种结构都未触发。
- **LP-05**：stale 分支的 `catch (error) { ... die("stale-rebuild-unparsable", ...) }`（`:1685-1701`、`:2060-2076`）没有像主路径（`:1848-1880`）那样判断 `error.code === "SYNTAX_CHECK_UNAVAILABLE"`；环境问题会被误报成补丁内容错误。
- **LP-06**：`check-rewind-patch.mjs:57-59` 的 `HOME_DIR` 是 `REWIND_PATCH_HOME ?? dirname(import.meta.url)`，`APPLY_SCRIPT = join(HOME_DIR, …)`；README `:132` 明确 `REWIND_PATCH_HOME` 只表示备份与 status 位置。自定义 HOME 时提示路径错误（本次只读实测已复现）。
- **LP-07**：`startup-patch-hook.cjs:307-323` 的 `else` 分支不区分失败 target；`apply` 的 `reportCombined()`（`:2581-2618`）只返回 0/1/3，且 turnId 单独失败时 stderr 已点名，钩子却加了一句错误的 “rewind will not reset”。注释中的 “Exit 2” 也不存在。
- **LP-08**：`resolvePaseoCliRoot()` 注释 `:88-90` 声称有 npm global root 回退，但函数 `:92-111` 在 PATH 循环结束后直接 `return null`；本机 `paseo.service` 恰好把 `.npm-global/bin` 放进 PATH（实测），所以当前机器不触发，但 README 的 systemd `ExecStartPre` 用户不一定会配 PATH。
- **LP-09**：`BASE_MD5` 注释（`:167-176`）只对 0.13.0 有参考价值；本报告只验证了 0.14.0。`startup-patch-hook.cjs:235-270` 的入口白名单是三个 basename，entry 改名时钩子直接 return 且不写日志；建议在 `check-rewind-patch` 增加“钩子最近是否在 daemon 进程上跑过”的检查（日志 pid/entry），并加 0.13/0.14/0.15 的兼容矩阵。
- **LP-10**：`check-rewind-patch.mjs:73-79` 的注释与 `:348-357` 的 `combinedExitCode` 实现相反；UPGRADE `:91-98` 已经按新语义描述。属维护性缺陷，修复时连同注释一起改。
- **LP-11**：`main()` 仅识别 `--check` / `--revert`；`--help`、`--dry-run` 或拼错参数都会走默认 apply（`:2628-2655`）。对一个会改写全局安装 dist 的脚本，建议显式拒绝未知参数。
- **LP-12**：status 文件在手动 `--revert` 后也会写 `ok:true`（`:2654`），checker 的“上次 ExecStartPre 记录”标题（`:299`）与实际语义不符；建议 status 加 `trigger: "execstartpre" | "manual-apply" | "manual-revert"`，或标题改成“上次运行记录”。
- **LP-13**：`UPGRADE.md:33-50` 引用的 `restart-with-wake.mjs` / `selfwake.mjs` 不在仓库；复用者无法执行该节。二选一：把 helper 纳入仓库，或在文档中明确标为作者环境可选、并给出外部获取方式。

## 健康度评分

| 维度 | 分数 | 说明 |
|---|---|---|
| 正确性 | 3 / 5 | 0.14.0 主路径与双 target 自检通过；stale 重建会删无关 tail，检查器有 false patchable 窗口 |
| 健壮性 | 2 / 5 | 锚点/字段匹配是文本级，class 边界、嵌套 `});`、注释/字符串都会改变判定；resolve 路径回退未实现 |
| 可维护性 | 3 / 5 | 注释和防御性分支很多，但注释与实际行为多处漂移（README “只替换目标块”、checker 姊妹补丁注释、hook exit 2） |
| 契约一致性 | 2 / 5 | check / apply / status 三套口径不完全一致；`--check` 与 `check-rewind-patch` 对同一文件可能给出不同结论 |
| 性能 | 4 / 5 | 单文件 O(n) 字符串扫描、日志 500 行上限；没有明显性能问题 |
| 安全 | 4 / 5 | 无 shell 拼接，写盘为原子替换；但未知参数会执行写入、状态/提示路径依赖环境变量 |
| 测试覆盖 | 1 / 5 | 仓库没有 local-patches 的 harness/CI 测试；仅有上一轮审查的临时 probe（不在 `harness/`、不在 CI），且本次无法在未准备环境直接复跑 |

**一句话总评**：这是一套在当前 Paseo 0.14.0 上确实可用、带原子写和多层自检的可选宿主补丁，但“文本匹配”与“运行时生效”之间仍有缺口，stale 重建边界和检查器门禁是下一次升级最值得先处理的两处。

**Top 问题（≤5）**：

1. **LP-01 / P2**：stale 重建替换 `revert()` 尾部整段，可能静默删除其它补丁/上游 tail 语句（已纯内存复现）。
2. **LP-02 / P2**：checker 不运行 apply 的 `hostFieldShapes` / `upstreamHistoryObjectShape` 门禁；上游字段改名时报告“可自动打”而 apply 必拒绝，形成升级期静默降级。
3. **LP-09 / P3**：无宿主兼容矩阵；hook 入口 basename 改名会静默 no-op，未来 Paseo 升级没有可判定的兼容护栏。
4. **LP-08 / P3**：`resolvePaseoCliRoot` 的文档承诺的 npm-global 回退未实现，最小 PATH 的 systemd 环境会 `target-missing`。
5. **LP-07 / P3**：启动钩子把 turnId-only 失败/降级写成“rewind 不可用/第二次撤回失败”，错误引导排障。

**建议优先级**：

1. 先修 LP-01（限定 CALL marker/AST 边界，额外语句 fail closed）与 LP-02（导出并复用形状门禁；checker 增加 `host-fields-changed` / `upstream-history-shape-changed` 状态）。
2. 再修 LP-08、LP-07、LP-06 这三个低风险但会导致误排障/误提示的运行时问题。
3. 最后处理 LP-09 兼容矩阵与 LP-10/LP-11/LP-12/LP-13 的文档/参数/状态注释一致性；补一个纯 `harness/local-patches-check.mjs`，至少覆盖本次 L1 probe、marker/staleness、host-field 与 #7675 分支。

**是否有阻断性健康问题**：**没有 P0/P1 阻断性问题**；由于 local-patches 是可选、非发布产物，当前不阻塞插件本体。但 LP-01、LP-02 属于 P2，建议在下次 Paseo 升级前修复，否则升级期可能静默丢失撤回补丁或删除无关的 `revert()` 尾部代码。
