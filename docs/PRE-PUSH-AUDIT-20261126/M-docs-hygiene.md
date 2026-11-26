# M 文档/CI/提交卫生 审查报告
状态: completed
范围: 27 提交 `origin/main..HEAD`：README.md / paseo-plugin/README.md / README.en.md / docs/HARNESS.md、harness/offline-checks.cjs 注册、.github/ workflow 触发面、提交卫生、files/runtimeAssets/prepack 资产完整性。方法：git diff/grep 静态分析（只读），并复用 Lead 的 `--keep-going` 全量日志 `docs/PRE-PUSH-AUDIT-20261126/offline-full.log`（76/77 gates passed，唯一失败见 P1）。

## 摘要
- **P1（最高，建议作推送阻塞）**：`node harness/offline-checks.cjs` 确定性红，唯一失败 gate = `pill-contribution-check.cjs`。`Offline checks` workflow 在 push / pull_request 触发且无路径过滤（offline-checks.yml:3-5,28），所以**推送会让远端 GitHub Actions 变红**，不是本地问题；upstream 自动同步复用同一 gate（sync-upstream.yml:61-62）。另一个 push 触发的 `process-compatibility` 只跑 typecheck+test:process（process-compatibility.yml:8,41-42），预计不红（本机 tsc exit 0、日志中 process 测试通过）。
- Lead 问询：需要同步更新但本次 diff 未改的既有检查**只有** `harness/pill-contribution-check.cjs`（缺 `Platform.select` 桩）；`newest-check` / `row-status-icon-check` / `thinking-check` 不需要——全量日志 0 失败，且它们加载的 newest.js / row-status-icon.js / inline-thinking.js / settings-screen.js 均不引 console-theme。被违反的约束：docs/HARNESS.md:15（offline-checks 是 push/PR 与 upstream sync 的唯一清单）与 :119（改了运行时代码也必须保证本 runner 全绿）。
- **P2×1**：新增 `test/popover-prose.test.cjs`（7 用例）未登记进 pluginTests，CI 永不执行。
- **P3×2**：HARNESS 三处用例/断言计数过期；README.en.md 未随本包更新（仍指向已不存在的 DSH Plugins 侧栏页）。
- 通过项：offline-checks.cjs 仅 +4 行纯注册（无判据放宽、无删除）；74 个注册路径全部存在、无跳过（新测试中仅 diagnostics 有 2 条 win32-only skip，ubuntu CI 照跑）；dsh-bridge/ 0 改动且 bridge-assets 新鲜（PASS，24 files）；package.json files 含 `server/`（doctor-core.mjs / .d.mts 随包），plugin-build 的 runtimeAssets 以 `server/*.mjs` 通配复制、构建树内已有 doctor-core.mjs，prepack 无需覆盖；27 提交同一作者、无 WIP/fixup、无二进制/`.dbg-*` 产物；diff 无新增密钥/本机真实路径（provider 名与模型族只出现在通用公开定价 catalog；`models.dev` 为公开 API 且可用 `options` 覆盖，不是路由硬编码 base URL）；tools/ 未改，无待注册新检查。

## 问题
| 级别 | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| P1（阻塞推送） | paseo-plugin/client/console-theme.ts:54；harness/pill-contribution-check.cjs:29 | 新模块在 import 期执行 `Platform.select`，而 CI 内既有 pill 检查的 react-native 桩无 `select` → 该 gate 确定性 `TypeError` exit 1，push 后远端 CI 必红 | console-theme.ts:54 `export const mono: string = Platform.select({...})`；pill-contribution-check.cjs:29 桩只有 `Platform: { OS: "web" }`，:36-38 require goal/team/jobs-pill，而 goal-popover.tsx:60、jobs-pill.tsx:48 import console-theme；offline-full.log:1400-1417 `Platform.select is not a function` + `FAILED ... exit 1`，:6187-6188 `76/77 gates passed`；offline-checks.cjs:84 默认首败即 exit 1 | 给桩补 `select: (options) => options.web ?? options.default`（先例 tool-call-check.cjs:4031）；或把 `mono` 改惰性求值。修后复跑 `node harness/offline-checks.cjs` 到 77/77 再推 |
| P2 | harness/offline-checks.cjs:48-60（pluginTests 缺项）；docs/HARNESS.md:115 | 新增 `test/popover-prose.test.cjs`（305 行 / 7 用例，95398a5 加入）未登记，portable CI 不会跑；而 HARNESS:115 声明所有 `test/*.test.cjs` 已登记（该通配在基线对 catalog-cache.test.cjs、plugin-id.test.cjs 已不成立，属既有偏差，本次再增一例） | pluginTests 11 项中无 popover-prose；`grep -rn popover-prose harness/` 为空；`npm test`（test/*.test.cjs 通配）才会跑到它，CI 只跑 pluginTests | 在 pluginTests 加 `'test/popover-prose.test.cjs'`；HARNESS 补该文件条目（动 client/popover-prose.ts、popover-ui.tsx 必跑） |
| P3 | docs/HARNESS.md:74 / :87 / :314 | 用例/断言计数与实际不符 | :74 pricing 写「16 条」，实际 `ℹ tests 22`（offline-full.log:6084）；:87 usage-stats 写「5 条」，实际 6（:6101）；:314 tool-call 写「总计 988 条」，实际 `994 passed, 0 failed`（:4418） | 分别改为 22 / 6 / 994 |
| P3 | README.en.md:30,572-574 | 英文 README 未随本包更新：仍宣称侧栏有 "DSH Plugins page" 入口，实际入口已改为 DSH Console（旧页成为 Console 的 Plugins Tab） | index.client.tsx:502-514 注册 `CONSOLE_SCREEN_ID` + `addSidebarHeaderItem`，无独立 Plugins 页；README.en.md:30 能力表、:572 小节、:574「The sidebar has a **DSH Plugins** entry」；中文 README.md:573 已重写为「DSH 控制台与时间线升级」 | 同步英文 README 能力表与该节，或标注英文版滞后 |

## 未验证项
- 未 push，GitHub Actions 未实跑；「推送即 CI 红」由 workflow 定义（offline-checks.yml:3-5,28）+ 本机同命令全量结果推定（高置信，76/77，唯一失败点已定位到源码）。
- CI 的 Node 22 与本机 Node 24 差异未复跑；日志中 typecheck 无输出=通过（高置信）。
- README 的 6 项 KPI / 8 列表格等 UI 明细未逐项核对（归 UI 审查块）。
- popover-prose.test.cjs 未实际运行（受只读约束），静态检查无 skip、`register-typescript.cjs` 存在（中置信）。
- 全量日志为 Lead 生成、我未运行任何写仓库的构建/测试（只读约束）。
