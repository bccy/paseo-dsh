# paseo-dsh 推送前审查 — 总报告

状态: **completed**
范围: `origin/main..HEAD` 27 个提交（+35,002 / −2,544，54 个文件），推送目标 `github.com/bccy/paseo-dsh`
方式: 13 路独立只读审查（A–M，fresh 上下文、互不共享结论）+ Lead 独立验收（tsc、全量离线门禁、资产校验、提交卫生扫描、跨块接线核对）
产物: 本目录 13 份分块报告 + `offline-full.log` + `FOLLOWUPS.md`

## 结论

**暂不建议推送。** 3 个 P1 需先处理：P1-1 是阻断项（推送后 GitHub Actions 的 Offline checks 必红）；P1-2、P1-3 是用户可见数据正确性缺陷（用量双计、自定义单价丢失）。修复 P1 后复跑 `node harness/offline-checks.cjs` 预期达 77/77（当前 76/77）。

P0 = 0。审查未发现可利用漏洞、进程级破坏或协议形状破坏；架构面（RPC 闭环、doctor-core 抽取等价性、timeline 事件形状、harness 判据）经交叉验证成立。

## Lead 验收证据（实跑）

| 检查 | 结果 |
|---|---|
| `cd paseo-plugin && npx tsc --noEmit` | exit 0 全绿 |
| `node harness/offline-checks.cjs --keep-going` | **76/77**，唯一失败 `pill-contribution-check.cjs`（= P1-1），见 `offline-full.log:1400-1417`、`:6187` |
| `node harness/bridge-assets-check.mjs` | 2/2 通过；`dsh-bridge/` 本批 0 改动，无需重生成内嵌桥 |
| 提交卫生（全新增行扫描） | 无本机真实路径/密钥/真实端点；命中项均为脱敏测试夹具与 `.invalid` 域 |
| 跨块接线 | 22 个新模块全部有引用；`index.server.ts` 新增 3 个 dispose 已挂清理函数；`lib/doctor.mjs` 为 `export *` 薄壳，旧导出（`runDoctor`/`BRIDGE_FILES`）兼容 |
| CI 触发面 | `offline-checks.yml` 在 `push`/`pull_request` 均运行该门禁；`process-compatibility.yml` 只跑 typecheck + `test:process`，**不覆盖** `test/*.test.cjs` |

## P0（0）

无。

## P1（3，推送前处理）

| # | 位置 | 问题 | 证据 | 修复 |
|---|---|---|---|---|
| P1-1（阻断） | `paseo-plugin/client/console-theme.ts:54` × `harness/pill-contribution-check.cjs:29` | 新增模块在 **import 期**执行顶层 `Platform.select`，而 CI 内既有 pill 检查的 react-native 桩只有 `Platform:{OS:"web"}` 无 `select` → 该 gate 确定性 `TypeError` exit 1；`offline-checks.yml` 每 push 运行，**推送即 CI 红**（H/M 双方独立确认；基线不 import 该模块，属本次引入） | `offline-full.log` 唯一失败；H 报告含三问答复与其他检查影响面（tool-call-check 有 select 不触发；newest/row-status-icon/thinking 的 stub 虽无 select 但加载闭包不含 console-theme，不触发） | 二选一：① 给 stub 补 `select: (options) => options.web ?? options.default`（先例 `tool-call-check.cjs:4031`）；② 按 H 的 P2 建议拆纯 token 模块、`mono` 惰性求值。修后复跑离线门禁至 77/77 |
| P1-2 | `paseo-plugin/server/usage-stats.ts:287-306` | seeded/fork 子会话日志开头保存父会话事件前缀，引擎只读首行判 `isSubagent`、不跳过继承前缀 → 父会话用量被重复计入（`delegationDepth:0` 的 seeded 还会污染 main 口径），fork 再 fork 叠乘 | E 实测本机 `~/.dsh/sessions`：9/3131 文件为 seeded，继承 432 条带 usage 调用、**78,297,052 tokens 双计**；4 个真实文件副本跑引擎应计 279 条、实计 597 条（**+114%**） | `header.isSeeded:true` 时取最后一个 `session/end-seed{inherited:true}` 的 seq 作切点，只统计 seq>切点；找不到切点按 corrupt 处理；升 `usage-stats.ts:55 CACHE_VERSION` 使旧缓存重算；补 seeded 回归夹具（现夹具全是 `isSeeded:false`，是 P1 漏网原因） |
| P1-3（C 的 P2 复核升级） | `paseo-plugin/server/pricing.ts:725-731,740-749,437` | 配置/同步缓存文件读失败（非 ENOENT）时静默回退默认值、无坏文件备份、无 UI 错误；下一次 `dsh.pricing.update` 用默认值**重写原文件** → 用户自定义单价/汇率丢失。团队定级口径：需前置条件的数据丢失+静默 = P1（低概率，需坏文件/权限/写中断前置条件） | C 报告；代码路径明确，未构造复现 | 非 ENOENT 时先把坏文件 rename 为 `.corrupt-<ts>`，readError 进 state 让 UI 提示；`update` 前若曾回退则明确提示将覆盖 |

## P2（15，去重合并后；不阻塞推送，建议跟随修复）

| # | 位置 | 问题 | 块 |
|---|---|---|---|
| 1 | `index.server.ts:130-158`；`server/pricing.ts:793-809` | `getConfiguredModels`/seen/configured 注入失败被全包 catch 吞成空 Map，定价表静默缺「已配置/本地已用模型」行，无日志无错误态（A、C 重复发现，合并） | A/C |
| 2 | `shared/pricing.ts:556-565` | 同步 catalog 不可用时内置参考表无 distinct-qualifier 守卫，把 `-pro`/tts/realtime 变体折成基础档（gpt-5-pro 低估 12×、gpt-4o-mini-tts 低估 16.8×），`node -e` 实测 | B |
| 3 | `client/console-pricing.tsx:1956-1959,1251-1254` | 未保存草稿被无关的成功更新静默覆盖（保存模型/切币种/开关同步都会回写汇率输入、重置行内 draft） | D |
| 4 | `client/console-pricing.tsx:919-933` | 长上下文阶梯按基础价 ×2/×1.5 本地揣测并填入，无「估算」标注，直接保存即持久化猜测值 | D |
| 5 | `server/usage-stats.ts:564-570,938-945,979-984` | readdir 失败被当「全部文件已删除」，清空并落盘空缓存；瞬时 EACCES/EIO/挂载点丢失即命中 | E |
| 6 | `server/usage-stats.ts:875-892,962-963` | 损坏/不可读会话文件静默计 0、无日志、RPC `indexing` 无 corrupt 信号 | E |
| 7 | `client/console-usage.tsx:1774-1784` | 币种切换自行发 `dsh.pricing.update` 且 `.catch(()=>{})` 静默吞错，失败时本地/父级已乐观改值，用户设置静默丢失/回弹 | F |
| 8 | `server/diagnostics.ts:822-826,876-885`；`client/console-diagnostics.tsx:1146-1147` | dsh 存在但版本无法确定时 overview 仍 `hasIssues=false`，把「探测失败/未检查」渲染成「健康」（`/tmp` 假 dsh 实测复现） | G |
| 9 | `client/console-theme.ts:12,54-58` | 「纯 token + 图标字体」模块混入 RN 运行时依赖，任何只需 `tabular`/`font` 的模块在加载期被迫依赖 RN Platform（P1-1 的复发面）；仓库既有反向约定见 `settings-screen.tsx:163-165` | H |
| 10 | `client/console-ui.tsx:387-481`；`console-format.ts:385-390` | 确定性死代码 ~110 行（`TokenBar`/`hueFor`/`monthDay` 全仓无调用，`TokenBar` 默认 labels 还是英文） | H |
| 11 | `client/console-screen.tsx:226-240`；`console-settings.tsx:36-37,419-421` | `dsh.pricing.get` 失败静默回退默认 USD/7.2 并允许编辑，与已持久化币种/汇率不一致且无错误提示 | I |
| 12 | `console-settings.tsx:142-394` 等 | 并行分支合并后遗留未接线槽位与死分支 ~250 行（`environment` 槽、`renderUsage/renderPlugins`、`DshPluginsPage` 独立壳），注释仍写已完成的合并计划 | I |
| 13 | `client/subagent-live.ts:113-134,232-235` | live 订阅关闭/ready 拒绝后只清空 controller，不重建不降级 → 运行中卡片可能永久显示「运行中」；依赖宿主重连语义（已标未验证） | J |
| 14 | `server/session.ts:4457-4458` | 从 `subagent/descriptor` 读上游不存在的 `agentPreset` 字段（DSH 0.2.2-rc.5 实际写在子会话 `agent-preset/selected`），默认预设子代理卡「预设」副标题静默缺失 | K |
| 15 | `harness/offline-checks.cjs:48-60` | 新增 `test/popover-prose.test.cjs`（7 用例）未登记进唯一 CI 清单；`npm test` 不在任何 workflow 中 → 该测试 CI 永不运行（维护者交叉确认，process-compatibility 只跑 test:process） | L/M |

## P3（约 55–59，去重合并后；不阻塞）

分块报告中均有 file:line 与未验证标注，主要类别：
- **数据/口径**：models.dev 非法数值静默回退（B）、多上下文阶梯只取最低档（B）、长阶梯字段回退方向不一致（B）、assistant/attempt 与 compaction 用量口径遗漏（E）、retry/attempt 去重（E）。
- **交互/状态**：pricing Refresh 被顶替后 loading 永不复位（D）、行内币种切换不换算（D）、Tab 切换丢已完成任务/Doctor 结果（I）、Quick Presets 静默丢弃草稿（I，既有）、popover 读屏合并名丢失（L）、jobs 头部把 stopping 计入 running（L）。
- **格式化/i18n**：`duration()` 分派残留歧义（H）、`tokens(999999)="1000K"` 等进位边界（H）、非有限值静默显示 0（H）、cache 写入摘要中英混排（D）、HARNESS 计数 3 处过期、README.en.md 未同步（M）。
- **性能/资源**：大目录冷扫与缓存全量重写（E，本机 3131 文件/1.22GB 实测 walk 80ms）、agent 预取与 replaySubagents 重复 history（K）、无界 UI 渲染/跨时区刻度（F）。
- **测试缺口**：H 四文件零测试、J live 关闭路径无断言、failed 卡片无渲染回归（H/J）、`inferModelFamily` 等新导出无断言（B）。
- **死代码/小项**：A 的 `safePushSubagentEvent` 未接 Promise 拒绝、`client.i18n` 只采样一次不订阅、shared/usage 与 shared/pricing 汇率/枚举三处重复（A）、G 的 `doctor-core.d.mts` 手工维护无新鲜度校验、`timeoutMs` 上限 60s 与宿主 30s 不一致、诊断模块保留测试专用动态回退与重复实现（G）、pricing 周期 re-arm 与 README 措辞不一致、跨进程写无文件锁、未来 `syncedAt` 永不 stale、未用方法（C）。

## 未验证项（推送前建议真机确认，按影响排序）

1. **react-native-web 是否有 `Platform.select`**（H）：仓库未安装该包；若宿主 Web 端缺失，加载 `console-theme` 即抛错（H 标 P0 级风险）。但 P1-1 无论如何都该修（stub 与顶层副作用两处）。
2. **宿主 onClosed/重连语义**（J P2 前提）：daemon restart / 插件 reload 后运行中子代理卡片是否自动收尾。
3. **models.dev 真实 payload 形态**（B/C）：数值是否可能为字符串、是否出现 ≥2 context tier、Anthropic id 用点还是连字符（影响参考族行是否永不叠加官方价）。
4. **真机 UI 走查**（D/F/G/H/I/L）：图标名是否存在、HostModal 键盘遮挡、双主题对比度、跨时区图表刻度、371 格热力图低端机帧率、Paseo 0.16 主题字段完整性。
5. **客户端 RPC 超时**（I）：若宿主 RPC 无超时，overview/doctor 挂起时按钮永久禁用。
6. **Paseo 0.16/0.17 真机加载**：本批未安装进运行中的 Paseo 复验（G 已用 0.17.4 宿主编译器离线验证 server 打包内联）。

## 修复顺序建议

1. **P1-1**（1 行 stub 或去掉顶层 select）→ 复跑 `node harness/offline-checks.cjs` 到 77/77，这是推送的硬前提。
2. **P1-2**（seeded 切点 + `CACHE_VERSION` + 夹具）与 **P1-3**（坏文件备份 + 错误态）——数据正确性，建议随本轮一起修。
3. P2 中优先数据正确性：B 参考表折叠、F/I 币种持久化与读取失败、E readdir/损坏文件、D 草稿覆盖。
4. 其余 P2/P3 可在推送后迭代；P3 清理时一并补 H/J 的测试缺口。

## 修复轮（2026-11-26，范围经用户收敛为「P1 + goal pill 动画」，P2/P3 只记录不修）

| P1 | 修复 | 独立复审 | 验证 |
|---|---|---|---|
| P1-1 CI 门禁红 | `client/console-theme.ts` +13/−5：`mono` 改为 `Platform.OS` 三分支，去掉加载期 `Platform.select`（注释记录原因）；未改 harness 桩以保留「最小 headless 桩」约定为 canary | **pass**（0 问题；独立跑 135 contribution checks + tsc；反向验证旧构建产物仍复现原失败） | 全量门禁 77/77 |
| P1-2 seeded 用量双计 | `server/usage-stats.ts` +74/−4：`CACHE_VERSION` 1→2、新增 `findInheritedSeedCut()` 取最后一个 `data.inherited===true` 的 `session/end-seed` seq、只统计 `seq > 切点`、缺标记走既有 corrupt 路径；`test/usage-stats.test.cjs` +219（parse/引擎两级夹具） | **pass**（0 P0/P1/P2，1 P3 观察；真实 9 个 seeded 文件 A/B：702 条/128,428,574 → 273 条/50,131,522 tokens，剔除 429 条/78,297,052，与审查实测完全吻合；40 个非 seeded 文件旧/新逐字段一致；三处变异均使新用例变红） | `usage-stats.test.cjs` 8/8；全量门禁 77/77 |
| P1-3 定价损坏静默覆盖 | `server/pricing.ts` +95、`shared/pricing.ts` +16：不可读 config/catalog 先 rename 为同目录 `.corrupt-<ts>`（内容逐字节保留）、`readError`/`recoveredFromCorruption`/`corruptBackupPath` 经 state 暴露、无备份时 `update()` 拒写、`writeAtomicFile` 仍原子；`test/pricing.test.cjs` +150（3 新用例） | **pass**（0 P0/P1/P2，2 P3；损坏文件逐字节保留、旧持久化文件可解析、两处变异有效；25/25 测试、tsc exit 0） | `pricing.test.cjs` 25/25；全量门禁 77/77 |

**Lead 最终验收（实跑）**：`node harness/offline-checks.cjs --keep-going` → **77/77 gates passed，exit 0**（`offline-postfix.log`）；`check` 含 typecheck 与全部 pluginTests。

修复轮工作区 diff：6 个源文件，+555/−17（未提交）。复审报告：`R-fix-p1-theme.md`、`R-fix-p1-usage.md`、`R-fix-p1-pricing.md`。

## F-01 goal pill 运行动画（同轮修复，用户追加要求）

- **根因**（院外只读调查，`F01-investigation.md`）：pill 运行位靠 `useAgent` 在图标组件里旁路读宿主瞬时状态，而 pill 自己的 `agents.list` upsert 已携带 agent status 却被 `updateAgent` 丢弃；`registration.update` 也不比 icon → 状态变化没有换图标的通道；而 popover 直接按 `active+armed` 显示「目标进行中」。既有缺陷（非 27 提交引入）。
- **修复**（照 team pill 的既有模式）：store 携带 `agents.list` 的 status → hold 状态机 → store.running → `registration.update({icon})` 换模块级稳定图标；删除 `makeGoalIcon`/`useAgent` 旁路读；popover 鲸鱼与 pill 同源；真值表与 1.5s hold 保留；`docs/GOAL.md`/`docs/HARNESS.md` 同步。
- **复审**：**pass**（3 处独立变异使对应断言变红；2 个非阻塞 P3；源码零改动，sha256 一致）。
- **验收**：`goal-pill-check` 323/323、`goal-popover-render-check` 269/269、tsc exit 0；最终全量门禁 **77/77**（`offline-final.log`）。
- 未验证（高）：宿主在 DSH goal 后台轮次是否真推 `status="running"` 帧；离线已消除 `useAgent` 旁路断点，真机需 reload 插件后观察 pill 环实时转、pause 停、重开不转。
- **真机实测**（2026-11-26，用户确认「我实测好了」）：修复在真机验证通过，无需重启；F-01 关闭。

## 推送（2026-11-26）

- 提交：`365eb9b`（console）、`c4534e9`（usage）、`e4f2fb6`（pricing）、`0bbe56f`（goal）；连同既有 27 个提交共 **31 个**推送到 `github.com/bccy/paseo-dsh` `main`（`15cb219..0bbe56f`，push exit 0）。
- 推送前最终门禁：**77/77 gates passed**。工作区剩余仅本审查产物目录（未跟踪、不入库）。
- CI 预期：`Offline checks`（push/PR 触发）应绿；`Process compatibility` 仅跑 typecheck + `test:process`，不受本批影响。
- 未修（按用户收敛范围）：审查报告中的 P2×15、P3×约 55 仅记录在份报告中，留待后续迭代。

## 推送后 CI 修复（2026-11-26 07:38–07:57）

- **现象**：首次推送（`0bbe56f`）后 GitHub Actions `Offline checks` 红，`Process compatibility` 绿；本机 Node 24 全绿。
- **根因**（已在本机用 CI 同版本 Node 22 v22.23.5 精确复现，`pass 7/cancelled 6` 与 `pass 16/cancelled 9` 与 CI 逐字一致）：两处测试的挂起场景依赖生产侧**有意 unref** 的超时 timer（`server/diagnostics.ts:1029-1035`、`server/pricing.ts:643-647`），而测试里等待的 promise 不产生活动句柄 → Node 22 的 `node:test` 判定事件循环清空，取消该测试并连锁取消后续（Node 24 行为更宽容故本地绿）。属首次推送的既有提交自带问题（非 P1 修复引入），也是审查盲区：G 块在本地 Node 24 跑 13/13 绿，未覆盖 CI 的 Node 22。
- **修复**：`test/diagnostics.test.cjs`（test 8）与 `test/pricing.test.cjs`（test 17）各加 `setInterval` 活动句柄 + `t.after` 清理（共 +18 行），模拟真实 daemon/子进程环境；**未改生产 `unref` 语义**、未降断言（166=166 / 416=416）、未 skip。
- **独立复审**：两件均 **pass**（0 个 P0–P2；各 1 个 P3 建议「加 `{ timeout }` 兜底防回归」；各自独立变异精确复现 CI 红，逐测试隔离验证）。
- **验收**：CI 同版本 Node 22 全量门禁 **77/77**；本地 Node 24 全量门禁 **77/77**。
- **推送**：`8e3a509 test: stabilize diagnostics and pricing tests on Node 22`（2 文件 +18 行）→ 远端 CI 两个 workflow **全绿**（Offline checks ✓ / Process compatibility ✓）。
- **最终 HEAD**：`8e3a509`，与 `origin/main` 同步；工作区仅剩本审查产物目录（未跟踪）。
- **教训（后续门禁建议）**：本地 Node 24 与 CI Node 22 行为差异需在测试层消除；含 unref timer 的异步测试应在 CI 同版本下验证（或在 CI 增加 Node 版本矩阵）。

## 附：本次审查新增/改动的文件（均为未提交产物）

`docs/PRE-PUSH-AUDIT-20261126/` 下：`A-contract.md` ~ `M-docs-hygiene.md`（13 份）、`offline-full.log`、`offline-postfix.log`、`FOLLOWUPS.md`（用户报的 goal pill 实时动画待修项 F-01）、`R-fix-p1-*.md`（3 份复审）、本 `SUMMARY.md`。审查阶段未修改源码；修复轮改动见上节，**尚未 commit/push**。
