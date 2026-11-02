# local-patches 全量健康度审查（2026-11-03）

- 基线：`HEAD 0c82df5`（工作区只有未跟踪的 `V1.txt`/`v1.txt` 与 `docs/audits/20261103/`）
- 审查员：local-patches lane（只读，fresh context）
- 唯一写入：本文件

## 1. 范围与方法

**逐个通读（非抽样）**

| 文件 | 行数 | 读法 |
|---|---|---|
| `local-patches/apply-rewind-history-truncation.mjs` | 2866 | 全文逐行 |
| `local-patches/check-rewind-patch.mjs` | 450 | 全文逐行 |
| `local-patches/startup-patch-hook.cjs` | 324 | 全文逐行 |
| `local-patches/README.md` | 171 | 全文 |
| `local-patches/UPGRADE.md` | 343 | 全文 |
| `harness/local-patches-check.mjs` | 322 | 全文 |
| `harness/host-contract-sim.mjs` | 412 | 判据部分（163-168、302-406）通读 |

**对照文档**：`docs/FULL-AUDIT-20261102.md` §3.2（L1，第 94 行）、§4.2（LP-02，第 136 行）、§10.1 p8-delivery 行（第 263 行）；根 `AGENTS.md` 的「唯一的例外是 local-patches」与撤回四条约束（尤其第 4 条 canary 顺序）；`docs/REWIND.md` 补丁章节（268-300 行）；`docs/HARNESS.md` 对两个 harness 的登记（334-341 行）。

**核查修复提交**：`git show 6394809 -- local-patches/ harness/local-patches-check.mjs`（+500/-31，新增 `foreignTextAroundPatchCall`、`--check` 复用两个 gate、checker 复用两个 gate、新 harness）。

**方法**

1. 源码逐行 + git 历史（该脚本只有 3 个提交：`8eae298` → `764ad42` → `6394809`）对比。
2. 纯离线 fixture 探针：全部 fixture 在 `/tmp/lp-probe*`，用 `REWIND_PATCH_TARGET` / `REWIND_PATCH_TURNID_TARGET` / `REWIND_PATCH_HOME` 指向临时文件，**未对已安装宿主运行 apply/check**；探针脚本：`/tmp/lp-probe/probe.mjs`、`probe2.mjs`、`probe3.mjs`、`probe4.mjs`、`s7.mjs`。
3. 运行仓库自带门禁 `node harness/local-patches-check.mjs`（16/16 通过，exit 0）。
4. 只读检查已安装宿主（`~/.npm-global/.../plugin-provider.js`）与部署副本（`~/.paseo/local-patches/`）：只读文件与内存判定，不写、不跑 apply/check。
5. 证据等级：【实测】＝有可复现探针/命令与 exit code 或输出片段；【源码推断】＝读码闭环未执行；【文档】＝文档口径。

## 2. 健康度评分（1-5）

| 维度 | 分 | 理由 |
|---|---|---|
| 正确性 | 3 | L1 已修且幂等/回滚路径完整；但宿主耦合门不覆盖 `revert()` 参数名（LP-01，可导致补丁打上后每次撤回 ReferenceError）与 history 行形状（LP-04） |
| 健壮性 | 3 | fail-closed 面显著扩大（#7675、host-fields、foreign region、CRLF/tab）；备份写入未捕获/非原子（LP-05） |
| 可维护性 | 3 | 单脚本 2866 行 + 大量历史注释；死代码 `staleWarn`（LP-09）与多处文案漂移（LP-06） |
| 契约一致性 | 3 | checker / `apply --check` / apply 三方对同一文件仍可给出不同结论（LP-02、LP-03） |
| 性能 | 4 | 纯本地文件操作；稳态路径毫秒级；启动钩子入口白名单消除了无关 node 子进程的 +60~160 ms 开销 |
| 安全 | 4 | 同用户写已安装 dist（设计使然）；原子 rename + 语法检查 + 回滚；无新增网络/凭据面；无签名 app bundle 守卫（未验证） |
| 测试覆盖 | 3 | 新 harness 16 项覆盖 L1 与两个 gate；仍缺参数耦合、第二次撤回、files scope、钩子、回滚校验的回归 |

**总体 3.3/5**（上轮 `local-patches` 2.7；主要提升来自 L1 修复与 `local-patches-check`，扣分来自 LP-02 残留与宿主耦合门覆盖不足）。

## 3. 发现列表

> 归属列：**基线已有**＝`8eae298`/`764ad42` 起即存在；**本轮修复不完整**＝`6394809` 声称修但只覆盖一部分。

### LP-01 [P2] 宿主耦合门不覆盖 `revert(messageId, scope)` 参数名：补丁照打，之后每次撤回抛 ReferenceError

- **位置**：`apply-rewind-history-truncation.mjs:287-300`（CALL 引用 `messageId`/`scope`）、`:1581-1609`（`hostFieldShapes` 只查三个私有字段）、`:1838-1853`（锚点）、`:580-604`（`detectUpstreamSelfFix` 的签名正则匹配不到时只是返回 `fixed:false`，不是失败）
- **触发条件**：上游把 `revert()` 的第一个参数改名（如 `async revert(id, scope)`），方法体仍保留 `token`/`scope` 与 `await this.bridge.revert({...})` 对象字面量。此时 ANCHOR_A/ANCHOR_B 各命中 1 次、`hostFieldShapes` 通过，apply 正常写入（`patched-on-new-upstream`）；注入的 CALL 里 `messageId` 是未定义标识符 → **每次 conversation/both 撤回**在宿主 `revert()` 内抛 `ReferenceError`（桥侧撤回已先完成，宿主侧报错、时间线不刷新，UI 表现为撤回失败但会话日志其实已回退）。
- **证据等级**：【实测】`/tmp/lp-probe/probe4.mjs` C1：checker=`patchable`/`autoPatchable=true`，apply rewind=`patched-on-new-upstream`，执行打好的类得到 `ReferenceError: messageId is not defined`；对照 C2（`scope` 改名）因 ANCHOR_B 含 `scope,` 而正确 `anchor-mismatch` fail closed——说明这是 `messageId` 独有的缺口。
- **归属**：基线已有（`hostFieldShapes` 自 `764ad42` 引入起只覆盖字段；`6394809` 未涉及）。
- **建议**：干净文件路径上把 `async revert(messageId, scope)` 签名纳入前置断言（与 `detectUpstreamSelfFix` 的签名正则共用），匹配不到就 `revert-signature-changed` fail closed；CALL 改为不依赖参数名不可行（注入代码只能用宿主变量名），所以门禁是唯一解。

### LP-02 [P2] LP-02 修复不完整：stale-body「能否重建」未建模，checker 报 `autoPatchable: true` 而 apply 必拒

- **位置**：`check-rewind-patch.mjs:212-225`（`state: stale-body`、`:217 autoPatchable: true`）、`apply-rewind-history-truncation.mjs:2789-2810`（`apply --check` 输出 `STALE PATCH BODY … re-run without --check to rebuild`）、拒绝路径 `:1435-1443`（call-unlocatable）、`:1445-1464`（**call-region-foreign**，L1 修复新增）、`:1216-1225`/`:1235-1242`（method-missing/unterminated）、`:1304-1311`（marker-wrong）
- **触发条件**：文件 markers=2 但补丁体是旧版，且重建不可行——最现实的正是 L1 修复引入的 `stale-patch-call-region-foreign`（`revert()` 尾部有补丁块之外的内容，例如上游在撤回后加了清理语句）。此时：`check-rewind-patch` 报 `stale-body / autoPatchable=true / exit 1`（UPGRADE §2 把 exit 1 解释为「无需动作，下次启动会自动打上」）；`apply --check` 说「重跑即可重建」；真正跑 apply 则 fail closed、文件不动、exit 3 DEGRADED。这就是 LP-02 记录的那类「体检工具不能回答『apply 会不会拒绝』」，只是从 host-fields/#7675 换成了重建可行性。
- **证据等级**：【实测】`/tmp/lp-probe/probe.mjs` S8：`checker=stale-body/autoPatchable=true/exit=1`，`apply --check exit=1`（STALE PATCH BODY），`apply exit=3`、`reason=stale-patch-call-region-foreign`、文件 byte-identical。
- **归属**：本轮修复不完整（`6394809` 给 checker/`--check` 补了 host-fields 与 #7675 两门，未补 stale 重建可行性；L1 新增的拒绝路径未被任何 checker 建模）。
- **建议**：把 `rebuildRewindInPlace` 的可行性判定（`foreign === null` 且 METHOD 可定位且 marker 可收敛）抽成只读函数，checker 在 `stale-body` 分支调用：不可重建时给独立 state（如 `stale-body-unrebuildable`，code 2、`autoPatchable:false`），`apply --check` 同源复用。

### LP-03 [P3] `apply --check` 未复用 `detectUpstreamSelfFix`：上游自修时 `--check` 报「NOT patched（去跑 apply）」，apply 实际拒绝并叫退休

- **位置**：`apply-rewind-history-truncation.mjs:2749-2759`（`rewindGate` 只有 historyShape + hostFields 两门）、`:2766-2811`（`checkTarget`）；apply 侧该门在 `:1803-1815`（仅干净文件路径）；checker 侧有正确判定 `check-rewind-patch.mjs:240-260`（code 4）
- **触发条件**：上游自己修好 #4667（`revert()` 内已截断 `this.history`），且两个锚点仍命中（例如在 `await this.bridge.revert` 之前加 `this.history.length = 0;`）。
- **证据等级**：【实测】`/tmp/lp-probe/s7.mjs`：同一 fixture 上 `check-rewind-patch` → `code=4 state=upstream-fixed-retire-patch exit=4`；`apply --check` → `FAILED — NOT patched (0/2 markers …)`；`apply` → `upstream-fixed-retire-patch` exit 1。同一文件、同一次升级决策，两个体检工具给出互相矛盾的结论。
- **归属**：本轮修复不完整（`6394809` 的 `--check` 复用只做了 2/3 门）。
- **建议**：`checkTarget` 在 `markers===0` 分支追加 `detectUpstreamSelfFix` 判定，输出 `upstream-fixed-retire-patch — apply will refuse (retire the patch)`。

### LP-04 [P3] 宿主 history 行形状耦合未建模：行形状改名后补丁照打，METHOD 静默失效

- **位置**：`apply-rewind-history-truncation.mjs:218-261`（METHOD 依赖 `event.type === "timeline"`、`event.item.type`、`item.messageId`/`item.id`）、`:1581-1609`（门只覆盖三个私有字段）、`:1545-1557`（#7675 只覆盖 `new PluginSessionHistory(` / `this.history.read(`）
- **触发条件**：上游把 history 事件的行形状改名（如 `type` → `kind`，或 `messageId` 挪位置）。锚点与 host-fields 都通过，apply 正常写入；之后 `truncateHistoryFrom()` 找不到行 → 返回 false → CALL 只往 stderr 打一条 `no history row carries this id`，撤回「成功」但时间线不刷新（回到补丁要消灭的那个缺陷），仅日志可见。
- **证据等级**：【实测】`/tmp/lp-probe/probe4.mjs` C3：apply rewind=`patched-on-new-upstream`，执行打好的类（行用 `kind`）→ `historyLen=2`（未截断）+ stderr 警告；C4 对照（行用 `type`）→ `historyLen=0`（截断生效）。
- **归属**：基线已有（#7675 门之外的同族耦合；`6394809` 未涉及）。
- **建议**：把 METHOD 依赖的行形状（`type: "timeline"`、`item.type` 的 user/assistant 分支、`messageId` 赋值点）加入 host-fields 类门禁；或在 apply 时校验宿主 `streamHistory()` 的行样本（可读码静态匹配即可）。

### LP-05 [P3] 备份写入未捕获/非原子，回滚端只校验 marker 与语法：环境失败落 `unhandled`，错误基线会被静默还原

- **位置**：`apply-rewind-history-truncation.mjs:1897`（rewind 干净路径 `copyFileSync(TARGET, backup)`）、`:1747`（stale prestale）、`:2124`、`:2236`（turnId）——四处都未包 `try/catch`；回滚端 `:857`（`backupFromStatus() ?? latestBackup()`）、`:864-889`（只校验 marker==0 + 语法）
- **触发条件**：
  - (a) `copyFileSync` 因 ENOSPC/EACCES 抛错 → 异常穿透到 `recordUnhandled`（`reason: unhandled`，提示文案是「非锚点/上游问题」，把环境错误指错方向），且可能残留半份 `.orig-*`；
  - (b) `--revert` 时 status 不可用（文件缺失/损坏/reason 不在 `usable` 列表）→ 回退 `latestBackup()` 按文件名时间取最新 `.orig-*`，只校验「无 marker + 能解析」，任何语法合法的文件都会被当作干净基线整文件覆盖回去。
- **证据等级**：【实测】(b) `/tmp/lp-probe/probe.mjs` S9：在 patched fixture 上放入一份无关但语法合法的 `.orig-` 备份并清掉 status 的 backup 记录 → `--revert` exit 0、`reason: reverted`、目标被替换成无关内容；(a) 为【源码推断】（未制造 ENOSPC）。
- **归属**：基线已有（回滚逻辑自 `8eae298`；四处 `copyFileSync` 自 `8eae298`/`764ad42`）。
- **建议**：备份写入用「临时文件 + rename」并包 `try/catch` → 独立 reason（`backup-write-failed`）；status 里记录备份 md5，`--revert` 校验备份 md5/大小并与当前文件的上游代次对应，拒绝无来源的 `.orig-*`。

### LP-06 [P3] DEGRADED / exit code 文案与实现漂移（三处）

- **位置**：
  - `check-rewind-patch.mjs:220-224`：stale-body 的 hint 说「跑 apply 重建（**会从最新的干净备份重打**）。若它报 **`stale-patch-no-baseline`** …」——当前 apply 是**原地重建**、不需要干净基线，且全文 grep 无 `stale-patch-no-baseline` 这个 reason（【实测】grep）。
  - `UPGRADE.md:87`：apply exit 3 的原因写「实现体是旧版且**无法自动重建（缺该上游版本的干净基线）**」、后果写「已知后果只有一条：同一会话里的第二次撤回会报 `No provider revert token`」。当前 DEGRADED 的实际原因是 method-missing / method-unterminated / call-unlocatable / call-region-foreign / marker-wrong（`apply:1216-1464`），后果随状态而异（METHOD 缺失而 CALL 仍在时是**每次**撤回 TypeError，不是第二次）。
  - `startup-patch-hook.cjs:319-322`：注释称「Exit 2 = 脚本无法安全 apply（锚点移动、半打补丁）」，但 apply 的 exit code 集合是 {0,1,3}（`reportCombined` 只返回 0/1/3，`die()` exit 1），**永不返回 2**；`PASEO_DSH_PATCH_HOOK_ACTIVE` 注释同理只是说明。
- **证据等级**：【实测】grep + `probe3.mjs` H7（喂 exit 2 时日志走 FAILED 分支）；apply exit 码集合为【源码推断】。
- **归属**：基线已有 + 本轮修复未同步文档（`6394809` 改了行为未改 UPGRADE/checker 文案）。
- **建议**：以 `reason` 为唯一事实源生成 hint/文案；把 exit code 表改为「0 / 1 / 3」并删掉不存在的 reason。

### LP-07 [P3] startup hook 的 exit 1 日志一律断言「rewind will not reset」，姊妹 target 失败时误导

- **位置**：`startup-patch-hook.cjs:319-323`
- **触发条件**：apply exit 1 的四种来源：rewind 真失败；**只有姊妹 `turnId` 失败**（rewind 正常）；`upstream-fixed-retire-patch`（rewind 已被上游修好，该退休）；`target-missing`（paseo 未装）。日志都写 `FAILED (exit 1) — rewind will not reset until this is fixed.`，只有后面的 stderr 尾巴能看出真实 target。
- **证据等级**：【实测】`/tmp/lp-probe/probe3.mjs` H5：假 apply 只让 turnId 失败 → 日志 `FAILED (exit 1) — rewind will not reset until this is fixed. [rewind-patch] FAILED target(s): turnId`。
- **归属**：基线已有（`764ad42` 引入钩子时即如此）。
- **建议**：按 `rewind-patch.status.json` 的 `patches.rewind.reason` 分支，或只贴原 stderr 不加解释性断言。

### LP-08 [P3] `resolvePaseoCliRoot()` 注释声称有 npm 全局根回退，实现没有；启动路径对 PATH 的依赖未文档化

- **位置**：`apply-rewind-history-truncation.mjs:78-91`（注释：「Falls back to `<npm global root>/@getpaseo/cli` when the executable cannot be resolved」）vs `:92-111`（只查 `PASEO_CLI_ROOT` 与 PATH 上的 `paseo`，失败返回 null）。git 历史显示该注释自 `8eae298` 起就存在，实现里从未有过这个回退（【实测】grep 三个版本均无 `npm root`/`npm prefix` 代码）。
- **触发条件**：daemon 由 systemd 启动且 unit 未显式设 PATH、paseo 装在自定义前缀（如 `~/.npm-global/bin`、nvm）时：`TARGET` 变成空串 → `target not found: `（空路径）→ 每次启动补丁都不打，撤回静默降级；README 的装法只给了 `ExecStartPre`/`NODE_OPTIONS` 两条，未说明必须让 `paseo` 在 PATH 上（本机 unit 显式设了 `Environment=PATH=…`，所以当前不触发）。
- **证据等级**：【源码推断】+【实测】grep；本机 unit 只读核对（有 PATH）。
- **归属**：基线已有。
- **建议**：要么实现注释承诺的回退（`npm root -g`/`npm prefix -g` 探测），要么删掉注释并在 README 装法里明确「`paseo` 必须在 daemon 的 PATH 上，或设 `PASEO_CLI_ROOT`」；`target-missing` 文案别打印空路径。

### LP-09 [P3] `staleWarn` 死代码：描述的是已被原地重建取代的旧策略

- **位置**：`apply-rewind-history-truncation.mjs:1705-1721`（定义 + 30 行注释「warn loudly, leave the file alone, report success-with-caveat」、message 里「缺干净基线」「撤回仍可用，但第二次撤回会报…」），全文件仅此一处出现（【实测】grep 只命中定义）。
- **影响**：读者会以为 DEGRADED 仍是「缺干净基线」的旧语义（与 LP-06 的 UPGRADE 漂移互相印证）；真正的拒绝分支在 `:1216-1464`。
- **归属**：基线已有（`764ad42` 原地重建重构后遗留；`6394809` 未清）。
- **建议**：删除；若保留「陈旧体仍可用」的语义说明，移到 DEGRADED 分支的真实注释里。

### LP-10 [P3] UPGRADE 第 1 节引用的自唤醒脚本不在仓库（只在部署目录）

- **位置**：`UPGRADE.md:38-40`（`node ~/.paseo/local-patches/restart-with-wake.mjs …`、`selfwake.mjs --snapshot`）；仓库 `local-patches/` 只有 5 个文件（apply/checker/hook/README/UPGRADE），部署目录 `~/.paseo/local-patches/` 才有 `restart-with-wake.mjs`、`selfwake*.mjs`、`apply-replay-turnid.mjs`（【实测】ls 对比）。
- **影响**：README 声称「本目录是唯一事实源」，但升级手册第一步依赖仓库里不存在、也无法从仓库复现的脚本；换机器/重建部署时该步骤不可执行。
- **归属**：基线已有（`8eae298` 起）。
- **建议**：把这两个脚本收进仓库（或改成通用步骤），或在 UPGRADE 里注明「本机私有、不在仓库」。

## 4. 阴性结论（验证过没问题的部分）

1. **L1 已修（红→绿可复现）**。用 `764ad42` 版脚本对同一 fixture（stale body + `revert()` 尾部无关语句）跑：exit 0、`patched-from-stale`、**无关语句被删除**（`/tmp/lp-probe/probe.mjs` S3b）；HEAD 版对同样 fixture：exit 3、`stale-patch-call-region-foreign`、文件 byte-identical（S3），且 foreign 语句在 marker 之前（S1）、marker 与 `if` 之间（S2）、`if` 之后（S3）三种位置都 fail closed。仓库门禁 `harness/local-patches-check.mjs` 16/16 通过（L1 用例 + 对照用例都在）。
2. **幂等**：干净文件连跑两次 → `patched` → `already-patched`；stale 重建成功后再次 apply → `already-patched`（S10）；turnId apply 幂等（T2a）。
3. **失败关闭面**：半打补丁（markers=1）拒绝且文件不变（T3）；`#7675` 形状在干净与已打文件上都 exit 2（harness 用例 4）；host-fields 缺失在 checker/`apply --check` 都点名（harness 用例 3/5）。
4. **写安全**：`atomicWrite`（同目录 tmp + rename）+ 写后 ESM 语法检查 + 失败回滚（干净内容/预重建内容）顺序正确；`--revert` 先校验备份再覆盖、失败回滚到回滚前内容。没有发现会破坏目标文件的路径（除 LP-05 的窄触发）。
5. **CRLF / 缩进自适配**：CRLF 文件 foreign → fail closed，无 foreign → 重建且整文件保持 CRLF（S11a/S11b）；tab 缩进文件可重建（probe2 T1）。
6. **startup hook 机制**：daemon 入口（`supervisor-entrypoint.js`/`daemon-worker.js`/`node-entrypoint-runner.js`）会跑 apply，非 daemon 入口完全不跑（H2 实测：无 stdout、无日志）；补丁子进程的 `NODE_OPTIONS` 里钩子被剥掉（`--require <path>`、`--require=<path>`、相对路径三种写法实测 H1/H3/H4），`PASEO_DSH_PATCH_HOOK_ACTIVE=1` 只给子进程；日志 500 行上限实测生效（H8）；exit 3 单独记 DEGRADED（H6）。
7. **当前宿主耦合成立**：已安装宿主只读判定 = 2 markers、`body current`、无 #7675 形状、host-fields 通过；对应的干净基线备份 `plugin-provider.js.orig-20261029155808-c763a310`（56226 B、0 markers）上 ANCHOR_A/B 各命中 1 次、`detectUpstreamSelfFix=false` → 该版本可自动打补丁。宿主 `revert()` 的 scope 字面量实测为 `"conversation"|"files"|"both"`，与 CALL 的 `scope !== "files"` 一致；history 行实测为 `{type:"timeline", item, timestamp}`，与 METHOD 假设一致。
8. **`harness/host-contract-sim.mjs` 判据评估**：`patched` 取自宿主文件是否含 `truncateHistoryFrom`（163-168 行），但断言是**双向行为**的（早发 canary 在补丁版被截 + 被撤回复消失；晚发 canary 两版都存活，302-406 行），所以「文件说已打但行为是 no-op」与「文件没补丁但行为仍截断」都会红——这个判据对它要证明的 canary 顺序机制是充分的，不是纯文本门。**但它只跑单会话、单次 `conversation` 撤回**：不覆盖第二次撤回（revertTokens 语义）、`files` scope（CALL 的 scope guard）、行形状失效——不能替代对 METHOD/CALL 运行期语义的门禁（见 LP-02/LP-04）。
9. **`node --check`**：三个脚本（apply/checker/hook）全部通过（`node --check` 实测）。
10. **有意偏差（不算缺陷，但需知边界）**：`foreignTextAroundPatchCall` 把「marker 注释之后的连续 `//` 注释」与「补丁自己的 `if` 块内部」视为补丁自有——块内被塞入的语句会在重建时被静默替换（probe.mjs S13 实测 `inside-if` 语句被删）。这与「CALL 区域外语句 fail closed」不冲突（块内属于补丁自有区域），但属于未写进 README 的所有权边界；只有本补丁自己会写这个块，风险低。

## 5. 未验证项

1. **未运行 `harness/host-contract-sim.mjs`**（任务要求只读判据）：它需要编译插件产物（写 `.dbg-host-contract`）并 import 真实宿主，且原版/补丁版双半需要额外解包包装目录；本轮只做了判据评估，未复验行为。
2. **未跑任何真实 daemon / 真实撤回**（禁止）：`rewind-native-check`、真实 `ExecStartPre`、App 内升级 fork worker 路径均未真机验证；hook 只在 /tmp 沙箱用假 apply 验证机制。
3. **未在真实上游版本差异上验证**：所有「上游改名」场景（LP-01/LP-03/LP-04）都是 fixture 构造的前瞻风险，不是已发生的上游变更；当前安装版本（0.14.0）上耦合成立（见阴性 7）。
4. **断电/fsync 安全未验证**：`atomicWrite` 明确不 fsync（注释自述），rename 的原子性只对进程崩溃成立，掉电窗口未测。
5. **macOS 签名 CLI 场景未验证**：代码里没有任何「签名 app bundle / 只读安装」识别守卫，文档称「根本打不了补丁」依赖文件权限；若用户以可写权限对签名 bundle 运行，可能破坏签名（未验证，也无守卫）。
6. **PATH 解析失败的真实触发未验证**：本机 systemd unit 显式设了 PATH，所以 LP-08 的空路径失败只在代码层确认，未在真实非默认前缀环境复现。
7. **`stale-patch-call-region-foreign` 之后 DEGRADED 的真实后果未验证**：不同拒绝原因下「第二次撤回失败」还是「第一次就不刷新」取决于残留的 CALL 形态，未在真实宿主上构造。

## 6. 跨 lane 提示

1. **部署副本落后于仓库（重要）**：`~/.paseo/local-patches/apply-rewind-history-truncation.mjs` md5 `d77c1a77…`（= `764ad42` 版，122078 B，mtime 10-29 22:26）vs 仓库 HEAD `855264909…`（127356 B）；`check-rewind-patch.mjs` 同样落后。也就是说 **`6394809` 的 L1 修复与 LP-02 门禁尚未部署到本机**，daemon 每次启动跑的是旧脚本（`startup-patch-hook.log` 最新一条 11-02T14:24 `all patches in place` 来自旧脚本）。当前不暴露：已安装宿主补丁体是 `body current`，不会触发 stale 重建。若最终结论写「已修复」，请同时给出「按 README 同步部署副本 + 重启 daemon」的落地动作，否则真机仍带着旧的重建逻辑。
2. **部署目录含仓库外脚本**：`restart-with-wake.mjs`、`selfwake*.mjs`、`apply-replay-turnid.mjs` 只在部署目录（与 README「仓库是唯一事实源」冲突，UPGRADE 第 1 节依赖它们，见 LP-10）。
3. **给 docs / p8-delivery lane**：`UPGRADE.md:87`、`check-rewind-patch.mjs:220-224` 的 DEGRADED/stale 文案与 `apply` 现行为不一致（LP-06）；`docs/FULL-AUDIT-20261102.md` §10.1 p8-delivery 行「L1、LP-02 fixed」应改为 **L1 fixed / LP-02 partial**（LP-02 仍有 LP-02/LP-03 两条残留）。
4. **给 bridge/rewind lane**：CALL 的 `scope !== "files"` 依赖宿主 `revert()` 的 scope 字面量（当前实测 `conversation|files|both`）；若桥侧 `paseo/revert` 的 scope 取值改名，补丁会静默失效（不 fail closed），需要同步。
5. **给测试/harness lane**：`harness/local-patches-check.mjs` 建议补三类回归——(a) `revert()` 参数改名（LP-01）；(b) stale+foreign 时 checker/`apply --check` 的判定（LP-02）；(c) `--revert` 拒绝无来源/错误基线（LP-05）。`host-contract-sim` 若要覆盖「第二次撤回」，需在同一个 session 里做两次 rewind。

## 附：证据复现

```bash
# 仓库自带门禁（纯离线）
node harness/local-patches-check.mjs            # 16/16 passed, exit 0

# 探针（全部 fixture 在 /tmp，绝不碰已安装宿主）
node /tmp/lp-probe/probe.mjs     # S1/S2/S3 foreign 三位置 fail closed；S3b 旧脚本删 tail（L1 红基线）
                                 # S7 --check vs apply 自修判定冲突；S8 stale-unrebuildable 判定冲突
                                 # S9 --revert 接受无关基线；S10 幂等；S11 CRLF
node /tmp/lp-probe/probe2.mjs    # T1 tab 重建；T2 turnId 全路径；T3 半打补丁；T4 checker 合并 exit；T5 死 reason
node /tmp/lp-probe/probe3.mjs    # H1-H8 启动钩子沙箱（白名单/NODE_OPTIONS 剥离/日志上限/失败文案）
node /tmp/lp-probe/probe4.mjs    # C1 messageId 改名 → apply 成功 + 运行期 ReferenceError
                                 # C2 scope 改名 → anchor-mismatch（对照）；C3 行形状改名 → 静默失效
node /tmp/lp-probe/s7.mjs        # 同一 fixture：checker exit 4 vs apply --check NOT patched

# 只读核对（不写、不跑 apply/check）
node -e '…'   # 已安装宿主：markers=2 / body current / hostFields ok / 无 #7675
              # 干净基线备份：anchors 1/1 / hostFields ok / upstreamSelfFix=false
md5sum local-patches/*.mjs ~/.paseo/local-patches/*.mjs   # 部署副本 = 764ad42（落后 HEAD）
for f in local-patches/*.mjs local-patches/*.cjs; do node --check "$f"; done   # 全部 OK
```
