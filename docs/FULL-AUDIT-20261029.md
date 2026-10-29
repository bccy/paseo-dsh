# 2026-10-29 全量审查记录

> 分支 `main`，审查起点 `37a5f87`，修复落在 `37a5f87..HEAD` 的 12 个提交。
> 版本基线（本机实测 `doctor`）：**Paseo 0.14.0-beta.2**、**DSH 0.2.1-rc.2**、**插件 0.2.11**。
> 本文只记本轮发现、裁决与修法；缺陷的现象与教训见
> [FIELD-NOTES.md](./FIELD-NOTES.md) 第十七轮（#67–#71），安装与自举见 [ADOPTION.md](./ADOPTION.md)，
> 撤回的机制见 [REWIND.md](./REWIND.md)。

## 1. 结论

- **6 路只读并行审查**（插件多会话 / 桥 / 会话层 / MCP 注入与协议 / 宿主补丁 / harness），
  每路都带 path:line 与可复现步骤。之后按「写域不重叠」拆成 **8 个修复包 + 1 个补救包**（外加
  2 个文档包），
  另有 1 个独立调研（不打宿主补丁能走多远）和 1 个浏览器自动拉起的可行性调研。
- **每一条都过了一遍裁决**，分四档：`ACCEPT`（成立，按建议修）、`ACCEPT*`（成立，但修法改成
  主编排给的——多数是因为原建议会引入新的静默降级）、`REJECT`（误报或有意偏差）、`DEFER`
  （需用户决定或另立项）。裁决逐条记录在审查工作区，最终状态汇总在本文 §3。
- **12 个提交**：桥侧 5（分帧线性化、MCP 两处失败当成功、usage 复活已关会话、server 只读路径、
  恢复被误删的 `setPermission`）、插件侧 3（进程层健壮性、会话层终态、provider 的 canary 与
  env 告警）、补丁与构建 2（退役 childRunning、doctor/构建新鲜度/CI）、内嵌桥重生成 2。
- **离线验收**：全部编译型与假桥脚本通过（明细见 §5）；`tsc --noEmit` exit 0；
  `bridge-assets-check` 逐字节一致（内嵌桥已重生成）。
- **本轮最重要的产出不是某一条修复，而是三条判据**：①不装宿主补丁的三种结局要分开写清
  （能自证 / 等上游 / 不可解）；②文本锚点匹配 ≠ 运行时生效，注入型补丁必须断言宿主数据结构
  形状并 fail closed；③一进程多会话之后，每个"每进程一次"的资源都要重新问一遍"这里失败会不会
  把别人带走"。

## 2. 审查流程本身出了一个问题（如实记录）

**主编排在审核修复 diff 时漏看了一处删除，把 `setPermission` 弄丢了。**

- 提交 `3047948` 要把 `usage()` 的 JSDoc 挪到正确位置。那段注释与 `async setPermission(params)`
  的方法体**相邻**，移动时多选了 24 行——方法连同注释一起被删。
- `handleRequest` 里的 `case 'paseo/permission/set': return this.setPermission(params);` 还在，
  于是调用点完好、被调方法不存在：打开会话时 Paseo 选的权限预设**永远不生效**，会话按 profile
  默认权限跑（可能比用户选的更宽，安全相关）。
- **为什么漏**：那一大块在 diff 里是连续的删除行，跳读时的印象是"注释挪了个位置"，没有逐行看
  删除内容。同轮的独立审查也没报——它审的是新增/修改的逻辑，"删除"在它的视野之外。
- **怎么发现的**：另一个修复包（provider 层）跑 `revert-check` 时，一条既有断言
  `the bridge serves the non-command permission write` 变红。当时把它当成"既有回归"记进报告
  并标注"不在本包写域"，是后来专门派了一个包（R）去恢复，才变成一次独立修复。
- **补的防线**：`harness/bridge-server-check.mjs` 新增一节，扫 `handleRequest` 里每个
  `case '…': return this.X(`，断言 `X` 在原型上存在。这条断言在出问题的提交上必红，而**任何行为
  断言都抓不到它**——除了那个 dispatch 之外没有任何代码路径会走到这个方法。
- **教训写进 FIELD-NOTES #69**：删除比新增更容易被放过，diff 审核要按删除块再走一遍，尤其是
  那些"只是挪注释/挪位置"的提交（移动 = 删除 + 新增）。

## 3. 逐 lane 的发现与裁决

标注约定：**A** = 成立按建议修，**A\*** = 成立但修法改为主编排给的，**R** = 驳回/误报，
**D** = 暂缓。P 级沿用审查报告里的定级；括号里是裁决后实际执行的级别。

### 3.1 插件多会话（L1）

| # | 级别 | 发现 | 裁决 | 修复 |
|---|---|---|---|---|
| 1 | P1 | 共享子进程 `stdin` 无 `'error'` 监听：大帧写入时子进程死亡 → 异步 EPIPE 未捕获 → **插件进程退出，该连接所有会话一起断** | A | `dsh-process.ts` 加监听 → `onProtocolError` + `#failAll`；新增 `process-crash-check` |
| 2 | P2 | 子进程崩溃时 `DshChildSession` 回合永久 running、提问卡不结算（`#exitAll` 只覆盖根会话） | A | 子会话加 `fail()`，先子后根发 `session.runtime_failed`；新增 `child-crash-check` |
| 3 | P2 | 共享进程 env 由首个会话决定，后续会话的 env 只进 stderr；`PASEO_AGENT_CWD` 未豁免造成噪音 | A\* | 豁免两个 per-agent 注入键，其余差异**只列键名**进时间线 warning；按 env 分池 → **D**（改动大、并发敏感） |
| 4 | P3 | `parked-sessions.ts` 是空壳，`hold`/`release` 只为 harness 插桩存在 | A | 删文件，`RELEASE_TIMEOUT_MS` 移入 `provider.ts`，暴露只读 `poolClaimCount`；`multi-session-check` 改断言计数 |
| 5 | P3 | `frame-reader` 未完成帧无上限 | A | 默认 256 MiB 上限，超限整帧丢弃并报告一次、跳到下一个换行 |
| 6 | P3 | `detachSession` 不清孤儿帧桶/计时器 → 5 s 后打出误导的 "no ancestor announced" | A | 先算后代集合再忘边，逐 producer 清计时器与桶 |

### 3.2 桥（L2）

| # | 级别 | 发现 | 裁决 | 修复 |
|---|---|---|---|---|
| 1 | P2 | `transport.js` 入站分帧 O(n²)：13 MiB 图片帧阻塞事件循环 2.2 s，**共享进程卡住所有会话** | A | 照搬 `frame-reader.ts` 的两条机制（只扫新增区间、残行数组），行为逐字保持；新增 `transport-frame-check`（20 MiB 5311 ms → 22 ms，旧实现当 oracle） |
| 2 | P2 | `usage()` 经 `getOrCreateSession` 可在 `session/close` 之后复活 agent（重新持有写租约、泄漏监听器） | A | `closedSessions` 闸门返回 `{available:false}` 且不创建；保留"恢复会话首次查询仍创建"；`bridge-server-check` 覆盖 |
| 3 | P3 | 两处归档状态读取的 `catch {}` 完全静默 | A | 区分「服务缺失（每进程一行）」与「读取抛错（每次一行）」，策略不变 |
| 4 | P3 | `history` 投影白名单与 `withoutAssistantStream` 零断言（逐项变异全绿） | A | `image-host-path-check` 加三组断言：精确白名单、非白名单丢弃、只剥 `stream`；逐项变异均能变红 |
| 5 | P3 | `usage()` 的 JSDoc 挂在 `setPermission` 上 | A | 挪回 `usage()` 之上 —— **这一挪就是 §2 那个事故**，恢复见 3.5 |

### 3.3 会话层（L3）

| # | 级别 | 发现 | 裁决 | 修复 |
|---|---|---|---|---|
| 1 | P2 | `client/tool-call-data.ts` 仍有 `@getpaseo/protocol` 的 type-only 导入 → `requirements.paseo ">=0.9.2"` 不成立（0.12 前的安装器会拒） | A | 本地声明 `AgentMessage` 形状（`client/agent-message.ts`），做法同 `server/json-value.ts` |
| 2 | P2 | 同 `turn/step` 重试时，新 attempt 的文本被追加到旧 attempt 后面（宿主对"非前缀快照"是整段追加） | A\* | 不采用"durable 保留原 id"（会让最终回答出现两次）：桥把 attempt 带进 `paseo/assistant-delta`，插件按 turn:step 给后缀 `:2`/`:3`，durable 合并进最后一次 attempt 的行；新增 `assistant-retry-check` |
| 3 | P3 | 撤回后重放多出一对无行的回合边界 | A | `started` 延迟到该回合第一条行发出时；无行则不发任何 `session.turn`；`replay-turn-check` 加断言 |
| 4 | P3 | `session.ts` 死类型导入 `ProviderTimelineItem` | A | 删一行 |

### 3.4 MCP（L4）

| # | 级别 | 发现 | 裁决 | 修复 |
|---|---|---|---|---|
| A | P1→P2 | 图片文件名拼接**模型可控的 tool 名** → 目录穿越写；`isError` 时仍先写盘 | A | 名字只留清洗后的 `[A-Za-z0-9_-]`（≤64），server 名同样清洗；`isError` 判断提到落盘之前 |
| B | P1→P2 | http server 名不合 `MCP_SERVER_NAME` 会让整个 `session.open` 失败 | A | 正则只约束**原生挂载**分支（那条路径把名字当工具命名空间）；http 与网关承载的放行 |
| C | P1→P2 | `mcp-injection-check` 的"被拒不 spawn"在热池下恒绿 | A\* | 加冷池用例（被拒 open 放第一个）；产品侧把 `validateMcpServers` 挪到 `acquire`/spawn 之前，让冷池也不 spawn |
| D | P2 | server→client 请求（带 id）被当成我方在途请求的响应 → `tools/call` 报"成功但空内容"、`tools/list` 缓存空目录 | A | 只接受 `method === undefined` 的帧当响应；stdio 对 server 请求回 `-32601`；gateway 对 `undefined` result 抛错 |
| E | P2 | 浏览器探测：中文 `isError` 认不出（死探测）+ 用 `{}` 调 `browser_tabs` **等于每次 `mcp_list_tools` 申请一次写锁** | A | 探测表改 `{name,args}`，`browser_tabs` 用 `{action:'list'}`；`isError===true` → 不可用；保留"探测成功 → unavailable 为空"的对照 |
| F | P2 | stdio 子进程全量继承 env（凭据会传给第三方 MCP server） | A\* | 复用上游 `scrubbedParentEnv`（`@deepseek-ai/dsh-subprocess`），显式 `env` 仍叠加在后；执行者先核实了该导出在声明的 DSH 最低版本里存在 |
| G | P2 | 网关 stdio 白名单只按名字 → 用户自配的同名 `server_browser` 被误代理（能力回归） | A | 判定改成「在白名单**且**是本插件自注入」，源头才决定身份；用户同名 server 走原生挂载 |
| H | P3 | 守卫归一化漏不可见字符 | A | 比较用 NFKC → NFD → 去组合符 → 白名单 → 小写（任务书给的字面顺序对组合符不成立，执行者实测后补了 NFD 一步） |
| I | P3 | `tools/list` 不处理 `nextCursor` | A | 循环取页，上界 100 页（超限抛错而非缓存半份） |
| J | P3 | 空/畸形 `tools/list` 被缓存为 0 工具且不再重试；`202` 空体当成功 | A | 不合法就抛、不缓存；只有 notification 允许空体 |
| K | P3 | SSE 等 EOF 才解析 | **D** | 当前两个真实 server 都不触发、改动较大；J 已让症状变响亮。登记在 §6 |
| L | P3 | `mcpEntries`：未知 type 被当 http、stdio 形状丢 `command`、`__proto__` 名静默消失、Config 错误回显 headers | A | 未知 type 点名拒绝（消息不含 headers/env 值）；`proxied` 用无原型对象；`__proto__` 显式拒绝 |
| M | P3 | `browserMcpServer` fail-open 无界面提示；文档里 `mcp-injection` 的计数漂移 | A | 发时间线 warning（**只在"装了插件但本会话挂不上"时发**，没装插件不告警，否则每次 open 都是噪音）；文档计数改成不写死 |

### 3.5 宿主补丁（L5）

前提：`local-patches/` 去留取决于"不打补丁能走多远"的调研（§4）。结论是**保留，但退役
childRunning**，所以下面的条目全部执行。

| # | 级别 | 发现 | 裁决 | 修复 |
|---|---|---|---|---|
| 1 | P1 | 启动钩子随 `NODE_OPTIONS` 进入**每个** node 子进程并无条件跑 apply → 只读体检恒绿、每进程 +60~160 ms、日志两天 1584 行 | A\* | 按 `argv[1]` basename 白名单只在 daemon 进程链触发（supervisor / worker / 打包版 runner），其它进程直接 return；日志上限 500 行 |
| 2 | P1 | = X0-1：撤回刷新依赖未文档化的宿主补丁，未装补丁时能力照常声明 → 静默降级 | 交调研 | 见 §4：canary 自证 + 文档写清两种宿主的表现；Phase 3（自动 reload）暂不做 |
| 3 | P2 | `check-rewind-patch` 不查 `turnId` | A | 纳入姊妹 target，退出码合并（rewind 自身非零优先，`4` = 该退休是**指令**不是失败，不能被覆盖） |
| 4 | P2 | rewind 的 stale 判据不比对 `revert()` 里的 CALL | A | 两层判据（方法体 + CALL 区域），并把重建也补上——只加比对会**永不收敛**（`apply` 报 stale、重建后 CALL 仍降级、下次 `--check` 又红） |
| 5 | P2 | 注入体依赖宿主私有字段但锚点不校验 | A | 打补丁前断言宿主字段真实形状（`this.history = []`+`push(`、`timelineSnapshots`/`revertTokens` 作为 `Map` 被读取），fail closed |
| 6 | P2 | `childRunning`/`turnId` 的备份写在 npm 全局包目录（`npm i -g` 会整树覆盖） | A | 备份移入 `REWIND_PATCH_HOME`，**文件名前缀一字不动**（跨 target 误恢复靠前缀不相交，不是靠目录隔离） |
| 7 | P2 | `UPGRADE.md` 的"临时副本验证"命令会打**真机** `agent-manager.js` | A | 补齐 `REWIND_PATCH_TURNID_TARGET` / `REWIND_PATCH_HOME`，并加一段警告说明这个坑 |
| 8 | P2→P3 | `docs/REWIND.md` 的 md5 守卫描述过时 | A | 文档（由另一个包改）：md5 只记录不判定 |
| 9 | P3 | `already-patched` 分支不写 backup | A | 记录 backup。**不只是整洁问题**：daemon 每次启动都走幂等路径，它会覆盖上次真正 apply 写的那份状态文件，于是 `--revert` 恒回退到"按文件名排序最后一个"——那正是防降级的守卫要防的 |
| 10 | P3 | `AGENTS.md` 未交代 `local-patches` 例外 | A | 架构段补一段：改写已安装 dist、不是发布产物、装不装都不影响插件本体 |
| 11 | P3 | 仓库与 `~/.paseo/local-patches` 两份手工同步 | A | README 加部署步骤，声明仓库为唯一事实源 |
| 12 | — | "3185 行非内嵌宿主副本" | **R** | 被证伪，不是问题 |

另外：`childRunning` 补丁**退役**（用户决定，上游 #8080 已修、未发版）。执行者实测**推翻了
一处文档说法**——"用新版 `--revert` 一次就能清掉旧 childRunning 标记"不成立（rewind 的
`--revert` 从整文件备份还原，那份备份里可能已经带着标记，取决于当年 apply 顺序与备份代次）。
两份文档已改成准确描述：要清就用旧版脚本 `--revert`，或重装 CLI。

### 3.6 harness（L6）

| # | 级别 | 发现 | 裁决 | 修复 |
|---|---|---|---|---|
| 1 | P2 | 假桥不校验 per-session `initialize` → 插件漏发也全绿 | A\* | 假桥默认严格（与真桥同文案拒绝）；只有纯协议层脚本显式 opt-out；验收时删掉插件侧的 `sessionId` → `multi-session-check` 9 条红、`concurrent-open-check` 1 条红 |
| 2 | P2 | doctor 的 YAML 校验在**发布安装**里不生效（插件不带 node_modules） | A\* | 不改成 fail（会让所有真实安装失败）：从 DSH 安装包目录加载它自带的解析器，两处都没有才 warn |
| 3 | P2 | `plugin-build-check` 缺 source-removed / stamp.version / tsc 版本三场景 | A | 补齐并**双向断言**（构造状态断言判据、还原后断言回到 fresh）；三条变异在审查报告里都保持全绿（零覆盖），现在各自变红 |
| 4 | P2 | `AGENTS.md` 撤回清单缺 `rewind-native-check` | A | 补进清单并注明「需打过补丁且在跑的 daemon、耗 token」 |
| 5 | P2 | `tsconfig.json` / `package.json` 不入构建戳（改编译选项后旧树仍被判 fresh） | A | 两者进戳，`STAMP_VERSION` 1→2（旧戳对编译器输入一无所知，fail closed） |
| 6 | P3 | 假桥 `mcp/set` 晚到恒回 `mounted:false`，真桥是 throw | A | 加 `mcp-late` 场景（照真桥文案 throw），插件侧不用改——这条修复的实际内容是"把假桥改诚实" |
| 7 | P3 | CI 门缺新增离线脚本 | A | 加 `plugin-build-check` / `frame-reader-check` / `replay-turn-check`；两个 gateway 检查**加不进**（依赖本机 DSH 安装），已在 workflow 与脚本头部注明 |

### 3.7 主编排自查（X0）

| # | 级别 | 发现 | 裁决 |
|---|---|---|---|
| 1 | P1 | 撤回界面刷新依赖本机宿主补丁（`b0c4579` 删除 reload 旁路），安装文档未提及，未装补丁时能力照常声明 → 静默降级 | 交调研 → §4 |
| 2 | P3 | `paseo-plugin/OVERVIEW.md`（发布物）写着 "one dsh process per session"，与本 fork 一进程多会话不符 | A（文档，由另一个包改） |

### 3.8 无补丁调研（NOPATCH）

见 §4。它是本轮**唯一一个"结论改变了计划"的调研**：原计划是"插件侧重宣告 + 语义探测 + 告警"，
调研把三件事分别定了性，于是 Phase 1 被取消、Phase 2 收缩成 canary、Phase 3 暂缓。

### 3.9 浏览器自动拉起（只读调研，未改代码）

**结论：不改。** 技术上可行，但卡点不在凭据也不在接口，而在 Server Browser 插件自己的策略——
它把"是否启动"完全交给用户的面板点击（`desiredRunning`），所有自动恢复路径都只对**已经被用户
启动过**的会话生效。桥在 `notRunning` 时拿不到任何可用凭据（浏览器停着时 `session.json` 被删、
token 为 null），所以桥侧无法自启。

真正的痛点只存在于「从未启动过的工作区」——用户点过一次之后，`desiredRunning` 会落盘，
之后 daemon 重启 / 插件 reload 都会自动恢复，桥也会等 20 s。**用户决定：每个工作区第一次在
面板手动启动一次，之后自动恢复**（方案 E，零改动）。两条不做的理由记在这里：

- 让 paseo-dsh 去自启（方案 C）把耦合方向搞反了：provider 反向依赖另一个插件的内部 RPC、
  还要自带 ws 连接与 `@getpaseo/client` 版本绑定，将来那个插件一改 RPC 名，坏的是 paseo-dsh。
- 改 Server Browser 插件自己（方案 B）是正确位置，但那是第三方插件的本地 patch，插件更新会覆盖；
  而且它有一个必须先补的前提——`desiredRunning` 要在 `boot()` 之前落盘，否则桥读到的仍是
  `false`，20 s 等待不生效，"后台起了但模型第一次调用照样立刻失败"，是典型的假修复。

顺带澄清一个容易误判的点：`panelManaged` 那条文案（"不能由 Agent 关闭共享浏览器"）**只拦
`browser_close` / `browser_install` 两个工具**，启动没有入口是**架构结果**（桥在停着时拿不到
token），不是安全策略拒绝——所以"加个开关允许 Agent 启动"没有策略障碍，要决定的只是产品取向。

## 4. 不打宿主补丁能走多远（本轮最重要的结论）

三件事分开定性，**不要合成一个"能不能不打补丁"的答案**：

| 能力 | 结论 | 做法 |
|---|---|---|
| 撤回后时间线刷新 | **半可行** | **canary 自证**：撤回成功后、回执**之前**发一条通知。打过截断补丁的宿主会把它连同被撤行一起截掉；原版宿主留下它并告诉用户执行 Reload agent 或重开会话。**顺序就是机制本身**（放到回执之后，补丁宿主上也会存活 = 误报），在宿主真代码上复现过两种宿主 × 两种顺序 |
| 子代理二次派发显示 running | **可行，但上游已修** | 上游 #8080 与本地补丁是同一处两行，已合 main、**未发版**（0.14.0-beta.2 不含）。所以补丁**退役**，过渡期接受降级 |
| 重开会话后的回合折叠（`turnId`） | **不可解** | 宿主**有意**不给历史行 turnId；把历史当实时重放会打出自主回合等副作用。等上游 #8053 / PR #8054。降级范围实测：单触发回合不受影响，系统触发回合并入上一回合、插话回合被拆开 |

**为什么不能"检测到补丁再决定行为"**：插件不在 daemon 进程里（宿主 `fork()` 起独立
`plugin-process`），看不到宿主内存；读磁盘文件判"改没改过"不可靠（文件 ≠ 已加载代码，升级、
回滚、多份安装都能让它说谎；macOS 桌面版自带签名 CLI 根本改不了）。所以只能走行为自证。

**Phase 3（canary 存活时自动 reload）暂不做。** 技术上有一条可行路径（在 hook / RPC 的回调上下文
里捕获 `paseo` 句柄存进闭包，`reload()` **绝不 await**——宿主撤回持有 pending run，reload 会取消
在飞回合，两者互相等待就是死锁），但它换回的是"用户少点一次"，代价是新增一条跨插件调用链与门禁。
**明确不用的那条**：`before("agent.session_open")`——宿主对带这个 hook 的插件每次起停都会
`invalidatePluginSessions()`，**所有 agent（任何 provider）下一次提问前都会被 reload**。

## 5. 对应修复提交

| 提交 | 内容 |
|---|---|
| `764ad42` | 退役 childRunning；钩子只在 daemon 进程链触发；check 查 turnId；stale 比对 CALL；私有字段前置断言；#7675 fail closed；备份移出 npm 目录 |
| `048289b` | doctor 在发布安装里真正校验 YAML；构建新鲜度补齐判据与用例；CI 加离线检查 |
| `79aa8a6` | MCP：图片路径不再由模型控制；server→client 请求正确处理；浏览器探测不拿写锁；stdio env 复用上游清洗；守卫归一化；翻页；空目录不缓存 |
| `7b48a74` | 桥入站分帧线性化；重试的 attempt 不再拼进同一行；history 投影补断言 |
| `3047948` | `usage()` 不复活已关闭会话；归档状态读取失败要响亮；桥带出 attempt（**这一提交误删了 `setPermission`**，见 §2） |
| `06091e8` / `90c01e9` | 内嵌桥重生成（两批桥改动各一次） |
| `d3cbebf` | 子进程 stdin 出错不再带走插件进程；分帧上限；关会话清孤儿帧；假桥严格校验 `initialize` |
| `5a18e1a` | 挂载校验前移；白名单只认自注入；未知传输点名拒绝；浏览器挂不上时告警 |
| `0cbf0f5` | 子进程崩溃时子代理一并收尾；撤回后重放不再多出空回合；client 去掉 protocol 类型导入 |
| `bf093a7` | 撤回后发 canary；env 差异上时间线；删 `parked-sessions.ts` 空壳 |
| `8383eed` | 恢复被误删的 `setPermission`，补 `handleRequest` 分派完整性断言 |

## 6. 有意偏差与暂缓项

**有意偏差（明确记录，不当作缺陷）**

1. **撤回提示在补丁宿主上会一闪而过**（小会话 14–30 ms 不可见，大会话最多约 2 s）。这是设计的
   一半：它本来就要随被撤行一起消失，剩下一段可见时间恰好充当进度提示。canary 不进 DSH 日志，
   重开会话后不存在。
2. **`scope: "files"` 的撤回不发 canary。** 文件撤回只还原工作树、对话被有意留着不动，没有
   时间线要刷新；那种情况下的「Reload agent」是针对不存在的问题给建议。
3. **`turnId` 降级保留**（§4）。这是数据缺口，不是算法 bug。
4. **子代理二次派发不显示 running**，直到用户升级到含 #8080 的 Paseo。
5. **`mcp-injection` 等文档不再写死断言数量。** 这一轮里它的用例数从个位数长到四十（中途还
   在别的文档里留下了 8 / 10 / 13 三种互相矛盾的数字），任何写死的数字都在下一次加用例时变成
   新的漂移源。
6. **HTTP 侧无法回复 server→client 请求**（一个 POST 一条消息，没有回写通道），只记 stderr。
   已写进 `pickResult` 的 JSDoc，避免后来人当成漏做。

**暂缓项（登记，不在本轮范围）**

| 项 | 理由 |
|---|---|
| L4-K：SSE 流式读 | 当前两个真实 server 都不触发；改动较大；L4-J 已让症状变响亮 |
| Phase 3：撤回后自动 reload | 收益是"用户少点一次"，代价是新增跨插件调用链与门禁（§4） |
| 按 env 分进程池 | 恢复"不同 env 的会话各用各的进程"，但改动大、并发敏感；当前只做告警（只列键名） |
| 浏览器自动拉起 | 用户决定用方案 E：每个工作区首次手动启动一次，之后自动恢复（§3.9） |
| `childRunning` 补丁 | 退役（上游 #8080 已修未发版）；新版脚本不主动清旧标记，见 §3.5 |

## 7. 验证方式

**离线（每包自测 + 主编排复跑）**

- 全部编译型与假桥脚本通过，其中本轮新增 6 个：`transport-frame-check`、
  `assistant-retry-check`、`bridge-server-check`、`process-crash-check`、`child-crash-check`、
  `host-contract-sim`。
- 每个修复包都做了**先红后绿**：在未改的代码上确认新断言变红（多数还做了单点变异，逐个确认
  "删掉这条判据就精确红这几条"）。审查报告里"零覆盖"的几处（`plugin-build` 的三个判据、
  `image-host-path` 的白名单、`mcp-injection` 的冷池）都补了变异证明。
- `tsc --noEmit` exit 0；`bridge-assets-check` 逐字节一致；`git diff --check` 干净。

**真机项（未在本轮跑，需用户执行）**

| 项 | 为什么必须真机 |
|---|---|
| canary 两种宿主的表现 | 补丁版一闪而过、原版常驻并提示 Reload —— 需重启 daemon、需在真宿主上撤一次 |
| `rewind-native-check` | 走 `agent-manager.rewind()`，需要打过补丁且在跑的 daemon；**耗 token**；前 8 条离线断言到不了宿主的 `revert()` |
| `plugin-check` | 加载插件会把内嵌桥写进 live profile，且不设 `DSH_BINARY` 时会跑真实模型回合 |
| 子代理二次派发 running | 需真实派发两次并观察卡片状态 |
| 浏览器工具仍可用（env 清洗之后） | 需要共享浏览器 + 真实会话；机制已证（上游同一函数、`PATH`/`HOME` 保留），真机未验 |
| MCP 浏览器告警在界面上的渲染 | 证据是 `session.notice` 协议形状 + 假桥驱动的真实插件 |

## 8. 待用户决定

1. **本机部署新补丁**：顺序是 ①用**旧版**脚本 `--revert`（它认识 childRunning），或重装 CLI 拿
   干净文件 → ②同步仓库的 `local-patches/` → ③`check-rewind-patch`（预期 exit 1 / patchable）
   → ④`apply`（预期 exit 0，只剩 rewind + turnId）→ ⑤挑时间重启 daemon，重启后核对钩子日志
   只剩 daemon 链的 pid。**需用户确认后执行。**
2. **是否做 Phase 3（自动 reload）**：建议不做（§4）。
3. **`turnId` 降级**：接受现状等上游，还是投入推进 PR #8054。
4. **发布**：按硬性流程，`npm publish` 等用户真机测试通过并明确确认。本轮**未** push、未发布。
