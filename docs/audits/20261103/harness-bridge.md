# harness-bridge lane — 桥侧 harness 判据质量审查（2026-11-03）

基线：`0c82df5`（工作区仅未跟踪的 `V1.txt` / `v1.txt`，未触碰）。
性质：只读审查 + 纯离线/假桥执行；未跑真实 daemon、真实 `~/.dsh` profile、真实模型，未改产品代码/文档/harness。
本轮重点：`13951ad`/`aa72484`/`8091777`/`0c82df5` 引入的撤回提示判据（`rewind-notice-check.cjs`、`rewind-notice-delivery-check.mjs`）与同轮改动的桥侧判据。

---

## 1. 范围与方法

### 1.1 逐文件通读（不是抽样）

| 文件 | 行数 | 本轮变化 |
|---|---|---|
| `harness/rewind-notice-check.cjs` | 475 | 新增（13951ad；8091777 大改；0c82df5 修 before-hook 判据） |
| `harness/rewind-notice-delivery-check.mjs` | 717 | 新增（aa72484；8091777 大改） |
| `harness/session-request-check.cjs` | 924 | 同轮大改（撤回回执/canary/完成提示/失败形状） |
| `harness/revert-check.mjs` | 1118 | 同轮改（canary/失败行/300ms 延迟删除） |
| `harness/rewind-transaction-check.mjs` | 793 | 同轮改（files-only） |
| `harness/file-snapshot-check.mjs` | 697 | 同轮改（BF-02/03、BR-04/H-02） |
| `harness/rewind-merge-check.mjs` | 351 | 同轮改（BR-03 继承锚点） |
| `harness/host-contract-sim.mjs` | 412 | 桥侧宿主契约 |
| `harness/local-patches-check.mjs` | 322 | 补丁门禁 |
| `harness/harness-gates-check.mjs` | 472 | T01–T04 / HP-05 / HP-08 判据回归 |
| `harness/snapshot-lifecycle-check.mjs` | 231 | 捕获序号/旧 journal |
| `harness/file-mutation-gate-check.mjs` | 196 | 写入闸门 |
| `harness/bridge-assets-check.mjs` | 149 | 内嵌桥逐字节 |
| `harness/dsh-api-contract-check.mjs` | 305 | DSH 内部 API 契约 |

另读产品侧被判据钉住的实现：`paseo-plugin/server/rewind-notice-append.ts`、`server/provider.ts` 的 `session.revert` 分支、`shared/rewind-notice.ts`、`client/rewind-notice-{data,live,tsx}.ts`、`index.client.tsx`/`index.server.ts`、`harness/fake-dsh-bridge.mjs` 的 `paseo/revert` 分支、`dsh-bridge/lib/server.js` 的 `revert()` 与文件层，以及宿主安装里的 `agent-manager.js` / `session.js` / `plugin-provider.js` 相关段。
对照文档：`docs/HARNESS.md`（逐脚本清单）、根 `AGENTS.md`（215-218 清单规则、231-252 撤回段/237-251 顺序清单）、`docs/FULL-AUDIT-20261102.md` §5.2 / §10.1（p9-harness）、`.github/workflows/sync-upstream.yml`（唯一 CI 门）。

### 1.2 实跑（纯离线 / 假桥 / 一次性 `DSH_HOME`；本机 DSH 0.2.1-rc.5、已装 Paseo CLI）

全部 exit 0（除注明）：

| 脚本 | 结果 |
|---|---|
| `rewind-notice-check.cjs` | 63/63，exit 0 |
| `rewind-notice-delivery-check.mjs` | 30/30（含降级子进程 4/4），exit 0 |
| `session-request-check.cjs` | 按头部注释手工编译到私有目录后 **52/52**；按清单原位跑则 `MODULE_NOT_FOUND` exit 1（见 HB-06） |
| `revert-check.mjs` | 120 passed / 0 failed |
| `surface-check.mjs` | 18/18 |
| `file-snapshot-check.mjs` | 69/69 |
| `snapshot-lifecycle-check.mjs` | 8/8 |
| `file-mutation-gate-check.mjs` | 6/6 |
| `rewind-merge-check.mjs` | 54/54 |
| `harness-gates-check.mjs` | 41/41 |
| `local-patches-check.mjs` | 16/16 |
| `dsh-api-contract-check.mjs` | 12/12 |
| `rewind-transaction-check.mjs` | 17/17 |
| `revert-shape-probe.mjs` | 10 passed |
| `host-contract-sim.mjs` | 7/7（仅 patched 半场，见 §5） |
| `bridge-assets-check.mjs` | 2/2 |

**红基线探针**（把已编译产物复制到 `paseo-plugin/.dbg-hb-red*` 后注入单一回退，跑同一个检查；不改产品源码）：

- 探针 A（交付顺序）：删掉 `RewindReportDelivery` 对 replacement 的等待后，`rewind-notice-delivery-check.mjs` **19/30，11 FAIL**（"the conversation report reached the timeline"、两处 ordering 断言、慢宿主等），说明核心顺序断言真能红。
- 探针 C（胶囊一次性）：去掉 `take()` 的记录删除后，`rewind-notice-check.cjs` **61/63，2 FAIL**（"a remount does not raise a second capsule"、"the duplicate is not a second one"），说明客户端一次性断言真能红。
- 探针 B（降级重投）：见 HB-01，删除 `verifyAfterTimeout` 调用后降级子进程仍 **4/4 全绿**，说明该分支零覆盖。

证据等级按【实测】（有命令/输出）、【源码推断】（只读代码）、【文档】标注。

---

## 2. 健康度评分

| 维度 | 分 | 理由 |
|---|---|---|
| 正确性 | 4 | 撤回交付顺序、文案/计数、事务、文件层都是行为级断言，红基线可归因（探针 A/C）；扣分在降级重投分支零覆盖（HB-01）与生产 warning 行仅源码 regex（HB-07） |
| 健壮性 | 4 | 负向/正向对照充足（快照 69、事务 17、gate 6 均带正反例；假桥 `initialize` 默认严格）；扣分在假 Paseo API 的保真边界未断言（HB-02） |
| 可维护性 | 3 | 接线段仍是源文本匹配（HB-03）、清单两套且 CI/AGENTS 未同步（HB-05/09）、手工编译脚本按清单跑不起来（HB-06） |
| 契约一致性 | 4 | `host-contract-sim` 双向设计、`dsh-api-contract-check` 双向覆盖、`bridge-assets` 逐字节都做得对；扣分在动态 import 盲区（HB-08） |
| 性能 | 4 | 最慢新脚本 12s（含 5s 慢宿主场景），其余秒级；无 O(n²) 类问题 |
| 安全 | 4 | 文件层已行为级覆盖祖先 symlink / 目录替换 / 符号链接目标 / journal 逃逸（H-02 已补），未发现新的静默降级面 |
| 测试覆盖 | 3 | 新增脚本整体强，但降级重投、live 投递、生产 warning 行、客户端接线四处只有文本或没有断言 |

**综合 3.7 / 5**（上轮 harness-bridge 3.4；提升来自 T01–T04 真红化、H-01/H-02 的行为覆盖、两条新撤回提示判据）。**无 P0/P1，不构成阻断**；P2 一条（HB-01）属"修复的安全网没被测到"，范围窄。

---

## 3. 发现列表

格式：`ID | 级别 | file:line | 触发条件 | 证据等级 | 归属`，后附摘要。

### HB-01 | P2 | `harness/rewind-notice-delivery-check.mjs:639-668`（断言 662-667）；产品分支 `paseo-plugin/server/rewind-notice-append.ts:225-246`（调用点 :394） | 宿主在 replacement 超时后仍重建并吃掉行，或该重投分支被改坏 | 【实测】 | 本轮新引入（aa72484/8091777）

降级路径唯一能驱动 `verifyAfterTimeout` 的场景并没有真正制造"行被重建吃掉"：降级子进程的 timeline 重建远快于 300ms 超时，append 落在重建之后，重投分支从未触发（正常构建日志里也没有 `was wiped ... appending it again` 行）。
实测：把 `.dbg-p17-delivery` 复制为 `.dbg-hb-redB`，在编译产物里删掉 `if (!replaced) await verifyAfterTimeout(...)`，再按父进程的同一条件跑
`DSH_PASEO_REWIND_REPLACEMENT_TIMEOUT_MS=300 node harness/rewind-notice-delivery-check.mjs --degraded paseo-plugin/.dbg-hb-redB`
→ 仍然 4/4 通过。断言 `…and exactly one report row remains after the verification pass` 对该分支被删除无感。
后果与它要防的缺陷同形：极慢宿主上报告静默丢失，而回归检查全绿。建议在降级场景里人为让一次 `streamHistory`/快照写入晚于超时（或直接构造"append 后被 delete"），再断言第二行仍在。

### HB-02 | P3 | `harness/rewind-notice-delivery-check.mjs:227-291`（假 Paseo；append 262-267、subscribe 275-285）；`harness/rewind-notice-check.cjs:147-171` | 宿主不再把 plugin 行 dispatch 给 timeline 订阅者、或不再支持 `pluginTimelineItems` 能力位；插件行 data 超限/非 plugin session | 【源码推断】 | 本轮新引入

两条新检查都没断言"报告行被 live 订阅者收到"：
- delivery check 用假 Paseo API 直接调 `manager.appendTimelineItem`，断言的是"行进了 timeline store"；假订阅只被用来观察 `replacement`，报告行是否被 `dispatchStream` 投给订阅者没有断言。
- rewind-notice-check 的 live 路径由测试手工 `deliver()` 一个合成事件，不经过宿主/桥。

而胶囊完全依赖这条 live 投递链（`appendTimelineItem → dispatchStream → 插件 timeline.subscribe`）。真实宿主还有 `pluginTimelineItems` 能力位门（宿主 `session.js` 的 `forwardAgentStream`/`supportsTimelineItem`），假 API 绕过了；daemon 侧 `handleAgentTimelineAppendRequest` 的 plugin client id 校验与 `assertPluginTimelineDataSize` 也被绕过。
若宿主侧这条链坏了，用户看不到胶囊、而 63+30 条断言全绿。建议在 delivery check 里加一个"订阅者收到这条 plugin 行"的断言（假 Paseo 已经在转发 `agent_stream`，成本很低）。

### HB-03 | P3 | `harness/rewind-notice-check.cjs:416-461`（419-423/424-428/429-433/434-439/440-444/445-461）；同类 `harness/harness-gates-check.mjs:447-468` | 调用被注释掉、移进不执行分支、或改名后只留文本；before 钩子用变量/模板串注册（:459 只匹配字面量参数） | 【源码推断】 | rewind-notice-check 本轮新引入；harness-gates 基线已有

客户端接线（transformer、renderer 注册、monitor 启动 + arm RPC、capsule 走 monitor）全部是 `String.includes` / 源文本正则，注释掉的调用同样通过；与文件头 :43-47 "Everything is the compiled client/shared code … not a regex over the sources" 自述矛盾。`0c82df5` 只把 before-hook 一条从"文本出现"改成"调用形态"，其余六条没跟上。
`harness-gates-check.mjs` 的 wiring 段（route-test 用共享判据、plugin-check 用完整时间线/结构图片判据）同样是 `source.includes(...)`，一个被注释掉的调用仍绿。
现有缓解：server 侧 arm RPC/钩子已被 delivery check 行为覆盖；但客户端三条（transformer 删旧行、renderer 注册、monitor 启动）没有行为覆盖，唯一判据就是文本。建议至少用 `source-shape.cjs` 的调用读取或把注册放进可 require 的模块再断言。

### HB-04 | P3 | `harness/rewind-notice-check.cjs:256-266`；实现 `paseo-plugin/shared/rewind-notice.ts:230-244`；反例纪律见 `harness/session-request-check.cjs:198-205` | 任一 locale 的撤回文案被修改后，旧版本写入 provider history 的行不再被识别/隐藏，历史会话重新出现陈旧"已撤回"行 | 【源码推断】 | 本轮新引入

`isLegacyRewindNotice` 的输入与期望都取自当前 `REWIND_COPY`（`isLegacyRewindNotice(REWIND_COPY["zh-CN"].conversation) === true`），而实现只匹配当前文案表。文案一改，旧行（用旧文案写入）就识别不到，但检查仍绿——因为它用新表当期望。
`git log -S '已撤回到这条消息'` 显示当前文案自 13951ad 未变，所以**今天的行为是对的**；这是未来回归盲区。同仓 `session-request-check.cjs:198-205` 明确写了这条纪律（"deriving the expectation from the module under test would only prove the module equals itself"），legacy 识别正需要一份冻结的历史字面量。

### HB-05 | P3 | `.github/workflows/sync-upstream.yml:60-108`；`AGENTS.md:237-251`；已登记：`docs/HARNESS.md:21-43` | 只按 CI / AGENTS 撤回清单验证时，两条新检查不跑 | 【实测】 | 本轮新引入（脚本新，两个入口未同步）

- CI 最小可信门（:60-108）与冲突提示里的命令清单（:127-144）都没有 `rewind-notice-check.cjs` / `rewind-notice-delivery-check.mjs`。前者纯离线（`plugin-build.cjs` 自编译、CI 有 `paseo-plugin/node_modules`），本可加进 CI；后者依赖本机 `@getpaseo/server`，不进 CI 合理。
- `AGENTS.md` 的撤回顺序清单（:237-259）也没加这两条；delivery check 的 HARNESS 条目没有像 `bridge-server-check`/`rewind-transaction-check` 那样写明"依赖本机宿主，不进 CI"。
实测：`grep -n 'rewind-notice' .github/workflows/sync-upstream.yml AGENTS.md` 均无匹配；`docs/HARNESS.md:21-43` 有完整条目（这部分合规）。

### HB-06 | P3 | `harness/session-request-check.cjs:74-84`（头注释手工编译步骤）、`:118`（`require("./index.server.js")`）；`docs/HARNESS.md:166-182`（无运行步骤） | 按清单直接 `node harness/session-request-check.cjs` | 【实测】 | 基线已有（脚本 2026-10-20 创建；清单条目未标运行方式）

实测原位运行：`Cannot find module './index.server.js'`，exit 1；按头注释编译到私有目录并复制后 52/52 通过。清单里其他手工编译脚本（如 `thinking-check`）会写明"运行步骤见文件头/需要额外编译"，这一条没有。
它是本轮撤回回执/canary 顺序/完成提示/失败形状的主要行为判据（52 条），照清单直接跑会得到假红，容易被误判成"检查坏了"。

### HB-07 | P3 | `paseo-plugin/server/provider.ts:1163-1166`（`deliver(..., "warning")`）；`harness/revert-check.mjs:325-329`、`:429-432` | 部分文件恢复失败时 warning 行的 append 实际没送达，而源码文本仍匹配 | 【源码推断】 | 本轮新引入（warning 行机制 8091777）

生产路径（有 `PASEO_AGENT_ID`）里"文件回退未完成"是 `deliver(msg, "warning")` → `timeline.append`；`rewind-notice-delivery-check.mjs` 只覆盖 success 的三种 scope（无 skipped/failed 场景），`session-request-check.cjs` 只覆盖无 agent id 时的 provider notice 降级路径。唯一断言是 `revert-check.mjs` 的源文本正则 `/文件回退未完成[\s\S]{0,400}?"warning",?\s*\)/`——它抓得住"改成 success/删掉调用"，抓不住"调用了但 append 没落地/行被重建吃掉"。
建议给 delivery check 的假桥加一个 `skipped`/`failed` 收据场景，断言 warning 行进 timeline 且没有 success 行。

### HB-08 | P3 | `harness/dsh-api-contract-check.mjs:82-94`（只匹配静态 import，注释称"桥没有动态 import"）、`:106`；`dsh-bridge/lib/server.js:1096`、`:3805` | 动态 import 的 DSH 包改名/改形状 | 【实测】+【源码】 | 基线已有（动态 import 2026-10-24，检查 2026-10-31；注释从写下起就不准确）

实测 `grep -n 'await import' dsh-bridge/lib/server.js` 命中两处，其中 :3805 的 `await import(entry.name)` 注释明确说可能是 `@deepseek-ai/dsh-mcp-client`。扫描器只收 `import … from '@deepseek-ai/…'` 与 side-effect import，注释却承诺"动态 import 出现时下面的覆盖断言会发现"——不会：未登记的动态 import 既不进 `found` 也不进 manifest，检查保持绿。升级 DSH 时这条契约门覆盖不到该类依赖。
建议：把已知的动态包名显式列进 `EXPECTED`/注释承认盲区，或扫描 `import(` 调用并列出。

### HB-09 | P3 | `docs/HARNESS.md:1-9`（自称逐脚本清单）；`AGENTS.md:215-218`（规则：清单在 HARNESS.md、新增也登记到那里、不要加回本文件）；`AGENTS.md:231-252`（撤回段仍是逐脚本必跑清单） | 按 HARNESS.md 找"动了这块该跑什么"时漏掉撤回链/p003 链 | 【文档】+【实测差集】 | 基线已有（8c3f98d 拆分时撤回段已在 AGENTS.md；p003-* 从未登记）

目录遍历差集（`for f in harness/*.cjs harness/*.mjs; do … grep docs/HARNESS.md / AGENTS.md …`）：45 个只在 `docs/HARNESS.md`，19 个只在 `AGENTS.md`（`revert-check`、`surface-check`、`file-snapshot-check`、`snapshot-lifecycle-check`、`file-mutation-gate-check`、`rewind-merge-check`、`host-contract-sim`、`rewind-e2e` 系列等整条撤回链），5 个 `p003-*` 两处都没有（只在 `docs/plantree/plans/003-capability-gap/evidence.md` 与审计报告里）。合计 24 个不在 HARNESS.md。
本轮两条新脚本登记在 HARNESS.md（合规），但 AGENTS 撤回清单没同步（HB-05），分裂继续扩大。建议把撤回段收敛成 HARNESS.md 条目 + 在 AGENTS 留一行指针，或反过来在 HARNESS 顶部声明"撤回链以 AGENTS 为准"，二选一，别维持两套。

### HB-10 | P3 | `harness/rewind-notice-delivery-check.mjs:507-516`；`:596-601`（头注释 :35-36） | 读者以为有独立断言；单独回退"步骤 0 的排队补发"时 | 【实测】+【源码】 | 本轮新引入

- `…and a second files rewind replaces it instead of stacking`（:512-516）与前一条（:507-511）是**同一个条件、同一组行**：501-516 之间没有第二次 files 撤回，实际被替换的是步骤 0 里排队补发的那份 files 报告。replacement 语义确实被覆盖了，但断言名与事实不符，日志里两条描述完全相同。
- `the rewind canary is still emitted`（:598-601）只断言 `canaryEvents.length > 0`；头注释 :35-36 声称"canary is unchanged: still emitted before the receipt"，顺序在本文件没有断言（由 `session-request-check.cjs:411-437` 与 `host-contract-sim.mjs` 覆盖，所以不是覆盖漏洞，是注释夸大）。

### HB-11 | P3 | `harness/rewind-notice-delivery-check.mjs:704-707` | 调用时显式传编译目录（开发者在验证自定义构建） | 【实测】+【源码】 | 本轮新引入

父进程把 `[compiled-plugin-dir]` 用于正常场景，但降级子进程的 `spawnSync` 只传 `--degraded`，不传 build 目录 → 子进程回落到默认 `.dbg-p17-delivery`（按当前源码重新编译），于是**同一次运行测了两棵不同的构建树**。实测探针 A 时正好暴露：父进程用被改坏的 `.dbg-hb-redA` 报 11 FAIL，而子进程仍用默认构建 4/4 通过。默认无参数运行时两棵树内容一致，问题只在"显式传目录验证本地构建"这条用法上；建议把 `buildArg` 一并传给子进程。

---

## 4. 阴性结论（已核查，避免重复怀疑）

- **T01–T04 / HP-08 / H-01 / HP-05 的修复本轮仍有效**（对照 FULL-AUDIT §5.2 与 §10.1 p9-harness）：
  `harness-gates-check.mjs` 41/41；T01 跑真实 `route-test.mjs` 对脚本化 peer（部分文本 + fatal error → FAILS、无 turn/end → TIMEOUT、全失败 exit 1、全干净 exit 0）；T02 跑真实 `tools.mjs` 断言 initialize/prompt 同 sessionId 且不挂 180s；T03/T04 都有"旧谓词在失败用例上是绿的"回归见证；HP-08 的 `session-calls` 无 schema → exit 2。
- **上轮 H-02（祖先 symlink 无覆盖）已补且是行为级**：`file-snapshot-check.mjs:349-413` 用真实临时目录搬走父目录再放 symlink，断言 restore 跳过且符号链接目标不被写；还带"新建子目录仍可删除"的正对照。69/69。
- **上轮 H-01（桥入口钩子无双证）已补**：`bridge-entry-check.mjs` 加载真实 `dsh-bridge/lib/index.js`，驱动 `tools/execute|post-execute|result` 断言 ticket/捕获/commit 顺序（该脚本在 CI 门里；本轮未跑，仅读头注释确认形态）。
- **两条新脚本的核心断言真能红**：探针 A（不等 replacement）11 红、探针 C（胶囊一次性）2 红，失败信息带 file/行为描述，可归因。
- **假桥没有"更宽松"**：`fake-dsh-bridge.mjs` 的 `paseo/revert` 收据字段与真实桥 `server.js revert()` 的 `files` 形状（restored/deleted/skipped/alreadyAbsent/failed/rescue/rescueDir/error、`unrecoverable` 折叠进 `skipped`）逐项对得上；`session/prompt` 默认按会话校验 `initialize`，只有 `fake-bridge-multi-check` 显式 opt-out。
- **`rewind-notice-delivery-check` 的交付顺序断言有真实宿主支撑**：它 import 真实 `PluginAgentClientRegistry`/`AgentManager`，`timeline.append` 走 `appendTimelineItem`（与 daemon 的 `handleAgentTimelineAppendRequest` 一致地把 `pluginId` 补上），replacement 事件形状 `{agentId, event:{type:"replacement"}}` 与 `@getpaseo/client` 的实现一致；慢宿主（2s 快照 + 5s 重建）与降级子进程都真跑。
- **`rewind-transaction-check` / `file-snapshot-check` / `snapshot-lifecycle-check` / `file-mutation-gate-check` / `rewind-merge-check` 判据质量高**：真实模块/真实临时目录、正反例成对、有"实测时延/计数"而非 sleep 断言、有 mutation 注记（如"单 tick 会让 gate 断言假绿，已改宏任务"）。
- 本轮未发现 P0/P1；未发现"注释/文本匹配"式假绿出现在这些脚本的**主判据**上（只出现在接线/覆盖声明处，见 HB-03/04/07/08）。

---

## 5. 未验证项

1. **host-contract-sim 的 stock 半场没跑**：默认按已装宿主判为 patched，只断言"canary 被截 + 撤回行消失"；"原版宿主 canary 存活"方向需要按头注释手工搭 wrapper 目录（上轮 §5.1 已记录同一限制）。本轮 7/7 只代表 patched 半场。
2. **真实 Paseo App 里的胶囊端到端未验**：live 投递 + `pluginTimelineItems` 能力位 + React 挂载/去重没有真机或客户端集成验证；本轮只证明了 monitor 单元行为（HB-02）。
3. **`client/rewind-notice-live.ts` 的部分分支无覆盖**：`agents.list` 抛错、`subscription.ready` reject 后释放并重试、`MAX_LIVE_RECORDS` 淘汰、`signal` abort 自动 dispose、`startRewindLiveMonitor` 的 arm 失败上报——新检查都没驱动。
4. **队列补发的 conversation scope 未验**：`rewind-notice-append.ts` 的 `flushPending` 明确不等待 replacement（日志说"撤回已完成"）；检查只测了 `files` scope 的排队。若 hook 恰在重建窗口内触发，行可能被重建吃掉且不重投。
5. **delivery check 只在已装（patched）宿主上跑过**：未在 stock 宿主上跑；断言本身不依赖截断补丁，但未实测。
6. **假 Paseo API 的保真边界**：绕过 daemon 的 plugin client id / 行数据大小校验（HB-02），本轮无法在无 daemon 条件下验证。
7. **未跑**：真实 daemon/真实 `~/.dsh` profile/真实模型类脚本（`plugin-check`、`route-test`、`probe`、`tools`、`stream-probe`、`rewind-e2e`/`merge-e2e`/`native`、`archive-registry`、`subagent-live`、`p003-live*`）——按任务约束不跑。

---

## 6. 跨 lane 提示

1. **产品侧（rewind/文件层）**：`paseo-plugin/server/rewind-notice-append.ts:225-246` 的"超时后重投一次"没有任何回归保护（HB-01），建议产品 lane 复核该分支在极慢宿主上的语义，并由 harness lane 补一个能真正触发重投的场景。
2. **产品侧（warning 行）**：部分文件恢复失败的 `deliver(..., "warning")` 生产路径只有源码 regex（HB-07）；如果本轮的"文件回退未完成"改动还动过文案，请确认 HARNESS 的 regex 没有跟着漂。
3. **桥 lane**：`dsh-bridge/lib/server.js:3805` 的动态 `@deepseek-ai/dsh-mcp-client` 导入自述"未在真机验证"，而 `dsh-api-contract-check` 不覆盖动态导入（HB-08）；跟版时应把该依赖当作软契约单列。
4. **文档 lane**：`docs/HARNESS.md` 与 `AGENTS.md` 撤回段两套清单（HB-09），以及本轮两条新脚本未进 CI/撤回顺序清单（HB-05），属文档一致性/可维护性范畴，建议一并收敛。
5. **CI lane**：`rewind-notice-check.cjs` 纯离线、CI 环境具备编译依赖，可直接加入 `sync-upstream.yml` 最小可信门；`rewind-notice-delivery-check.mjs` 依赖本机宿主，不进 CI，但应在条目里写明（HB-05）。
