# H Console 基础库 审查报告

状态: completed

范围: `paseo-plugin/client/console-ui.tsx`(764)、`console-theme.ts`(157)、`console-format.ts`(395) 全文；`locale.ts` 相对 origin/main 的 +276 行（`git diff origin/main..HEAD -- paseo-plugin/client/locale.ts`）；提交 `119d6ec`（duration 重载修复）。只读：未运行会写仓库的构建/测试；`node` 侧用 `paseo-plugin/test/register-typescript.cjs` 直接加载真实 TS 源做边界实测。

## 摘要

- 功能面结论：H 块核心正确。Hermes 兜底完整——删除 `globalThis.Intl` 后 `percent/integer/relative/clockTime/monthShort/dayLabel/longDate/money` 全部走 ASCII 或枚举回退（实测输出正常）；`Intl` 构造全部 try/catch 且 `RelativeTimeFormat` 先做类型探测；日期 Formatter 按 locale+options 缓存。主题全部取宿主 `PluginTheme.colors` token，无浅/深色写死色板（仅阴影 `#000` 与 Avatar 的 hue 是色相而非主题色）；59 个新增 locale 键（`console` 49 + `presets/advanced` 10）en/zh 叶级一一对应、非空、全部有使用点（脚本核对 + 关键键人工复核）；卫生干净（无 provider/model/base URL/密钥/本机路径）。
- `119d6ec` 的「数字起点 + 字符串终点」分派确实修好：`duration(1700000000000,"2026-11-26T00:00:00Z")` 由误判 1234ms 变为区间模式 `"26569h 47m"`；但区间重载仓库内无调用方（只有 `console-diagnostics.tsx:1098`、`subagent-card.tsx:368` 两处 `(durationMs, locale)`），残留歧义见 P3。
- 推送前必须修 1 个 P1：`console-theme.ts:54` 顶层 `Platform.select` 令离线门禁必红（Lead 全量日志：`docs/PRE-PUSH-AUDIT-20261126/offline-full.log:6187` 76/77，唯一失败 pill-contribution-check）。
- Lead 追加三问：(1) 影响面仅 harness/测试 stub——RN 0.81.5 原生已证 `select` 存在（`paseo-plugin/node_modules/react-native/Libraries/Utilities/Platform.ios.js:80`、`Platform.android.js:73`）；宿主 Web 用 react-native-web，本仓库未安装，未验证；与 Paseo 0.16/0.17 无关（RN API）。(2) 根因以 stub 未同步为主：本分支已给 `harness/tool-call-check.cjs:5032` 的 ios stub 补过 `select`，漏了 `harness/pill-contribution-check.cjs:29`；模块边界为辅（见 P2）。(3) 修复：给该 stub 的 react-native 对象加 `select: (options) => options.web ?? options.default` 即可单行修绿（链上 goal-popover/popover-ui 只需 ActivityIndicator/Platform/Pressable/Text/View，stub 已具备）；其他检查：`tool-call-check` 有 select 不触发；`newest-check.cjs:702…`、`row-status-icon-check.cjs:398`、`thinking-check.cjs:2816` 的 stub 虽无 select，但加载闭包不含 console-theme（newest/row-entrance/stream-reveal；row-status-icon 链；settings-screen 仅在注释提及），当前不触发。

## 问题

| 级别 | 位置 | 问题 | 证据 | 建议 |
| --- | --- | --- | --- | --- |
| P1 | console-theme.ts:54-58 | 顶层 `Platform.select` 在模块加载即执行，`pill-contribution-check` 的 RN stub 无 `select` → `offline-checks` 必红，每次 push CI 失败 | `offline-full.log:1400-1417`：`.dbg-offline-checks/client/console-theme.js:33 TypeError: react_native_1.Platform.select is not a function`，链 `goal-pill.tsx:66`→`goal-popover.tsx:60`→console-theme（`jobs-pill.tsx:48` 也直接 import）；stub `harness/pill-contribution-check.cjs:29` 只有 `Platform:{OS:"web"}`；CI `.github/workflows/offline-checks.yml:28` 每 push 运行 `node harness/offline-checks.cjs`（无 --keep-going 时首败即退出） | 单行补 stub（同 `harness/tool-call-check.cjs:4031` 写法）；或按 P2 拆纯 token 模块 |
| P2 | console-theme.ts:12,54-58；settings-screen.tsx:163-165,196-200 | 「纯 token + 图标字体」模块混入 RN 运行时依赖：只要 `tabular`/`font`/`tint` 的模块（goal-popover.tsx:60、jobs-pill.tsx:48）也被迫在加载期依赖 RN Platform；仓库本有反向约定——`settings-screen.tsx:163-165` 明写「不 import `Platform.select`（保持最小 headless stub 轻量）」而复制实现，复制已语义漂移：`settings-screen.tsx:198` 把 `"0%"` alpha 当 100%（`Number(...)||100`），`console-theme.ts:73-76` 正确返回 0 | 照 `client/tokens.ts` 先例：把 `space/radius/font/tint/toneColor/Colors`（RN-free）拆到独立纯模块，`mono/tabular` 留 UI 层；settings-screen 复用同一 tint。可一并消除上表 P1 的复发面 |
| P2 | console-ui.tsx:387-481,704-710；console-format.ts:385-390 | 未使用导出（确定性死代码 ~110 行）：`TokenBar`(95 行)、`hueFor`、`monthDay` 全仓无调用 | 全仓 grep（排除 .dbg 构建产物）三者各仅定义处 1 命中；旧构建产物 `.dbg-team-server-check/client/stream-stats.js` 显示 `TokenBar` 曾在 stream-stats 用过，现 `console-usage.tsx:51` 只用 `Bar`，属重构残留；`TokenBar` 默认 labels 还是英文（接入即 i18n 泄漏） | 删除或接入 usage 页；若保留须删默认英文 labels |
| P3 | console-format.ts:284-295,247 | duration() 分派残留歧义：无法解析成日期的终点字符串被当 locale，静默返回错误时长而非 null；区间模式 0～<500ms 又被 `Math.max(1,seconds)` 显示成 "1s" | node 实测 `duration(1700000000000,"2026-13-99")`→`"472222h 13m"`、终点传数字字符串 `"1774512000000"` 同样；`duration(2000,2000)`→`"1s"`、`duration(1000,1420)`→`"1s"`。当前无区间调用方，属潜在 | 判据改为「仅 `looksLikeLocaleTag(second)` 走时长模式，其余字符串走区间/null」；补 119d6ec 的回归测试 |
| P3 | console-format.ts:66-83,158-166 | 边界格式化不一致：不足一单位进位时先四舍五入导致越界 | 实测 `tokens(999999)="1000K"`（应 1M）、`tokens(999999999)="1000M"`、`tokens(-0.4)="-0"`、`moneyShort(9999.9)="$10000"` 而 10000→`"$10K"` | 先按目标精度取整再判单位提升；负数取整避免 -0 |
| P3 | console-format.ts:67,87,105,138,152,194 | 非有限值静默变成可见的 0 值，缺数据与真 0 不可区分 | 实测 `percent(NaN)="0%"`、`integer(NaN)="0"`、`tokens(NaN)="0"`、`money(NaN)="$0.00"`、`relative("bad")=""` | 返回 "—" 等空态由调用方决定，或在模块头注释固化该约定并让消费方 guard |
| P3 | harness/locale-check.cjs:190-198；timeline-spacing.test.cjs:217-235；style-check.cjs:21 | 新增 locale key 与 H 块自身零测试：既有检查只覆盖「顶层/键集」对称，叶子值与格式化逻辑无断言 | locale-check 的 `scalarKeys` 只走顶层字符串键，`console`/`presets`/`advanced` 是对象被跳过；timeline-spacing 只比 `settings` 键集；style-check 只编译 `client/tokens.ts`；H 四文件无任何 test/harness 引用（`.dbg` 内 tool-call-check 间接渲染 subagent-card 时才会加载 console-ui/theme，且不校验其输出） | locale-check 增 `console`/`presets`/`advanced` 叶级 en/zh 对称与翻译断言；新增纯模块 `console-format.test.cjs`（duration 分派、边界值、无 Intl 兜底） |

## 未验证项

1. react-native-web 是否有 `Platform.select`：本仓库未安装该包，宿主 Web 运行时未验证（若缺失则 Web 端加载 console-theme 即抛错，属 P0 级）。验证：Paseo Web 打开任一含 goal-popover/console 的界面并看控制台。
2. Paseo 0.16 主题字段完整性：`paseo-plugin.json`/README 仍写 `paseo >=0.16.0`，而 devDependency 是 0.17.3；`accentForeground`、`surface0/1/2`、`status*` 是否 0.16 全有（`console-ui` Button primary/SegmentedControl/Avatar 依赖 `accentForeground`/`surface0`），缺失会渲染 undefined 色。验证：0.16 daemon + 真机看 Console/按钮。
3. `Avatar` 的 `hsl(*,62%,50%)` 初字、Badge 6%/13% 底色的深/浅色对比度：仅静态估算，未截图，需真机双主题走查。
4. `client.i18n?.locale` 启动时是否已初始化/取值形态（代码已 optional chaining 兜底、0.17.3 类型存在）；`adoptHostLocale` 只采纳一次，宿主运行时切语言不会刷新插件 UI（0.17.3 有 `useTranslation` 可订阅，但 0.16 兼容下限下不能无条件用）——是否符合产品预期待确认。
5. 未运行离线门禁（只读约束，构建会写 `.dbg-*`）；P1 的失败结论来自 Lead 实测日志 + 本审查对 stub/import 链/CI workflow 的静态核对（日志 Node v24，CI 用 Node 22，行为一致）。
