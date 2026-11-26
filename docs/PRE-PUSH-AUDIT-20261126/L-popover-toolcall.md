# L Popover 与 tool-call 审查报告
状态: completed
范围: `git diff origin/main..HEAD` 下的 popover-ui.tsx(+444)、popover-prose.ts(+348)、goal-popover.tsx(±286)、team-popover.tsx(±519)、tool-call.tsx(±487)、tool-call-data.ts(±121)、jobs-pill.tsx(±84)、team-card.tsx(±40)、rewind-notice.tsx(±63)、test/popover-prose.test.cjs(+305)，及 harness 四个检查（goal/jobs/team render-check、tool-call-check）改动。纯只读静态审查；未跑构建/渲染（paseo-plugin 构建会写 .dbg-*）。

## 摘要
结论：本块无 P0/P1。未发现交互删除回归、HTML 注入面或字段契约漂移；检出 1 个 P2（新增测试未进 CI）与 4 个 P3。
- 交互保留：goal 暂停/继续/清除/清除确认、team 任务行→详情→返回/完成折叠/owner 标记、jobs 展开与行尾停止/live 行首、tool-call 折叠/展开/失败展开/复制、rewind 的 `monitor.take` 订阅均在。`git diff -w` 核实 tool-call.tsx 唯一语义改动是 subagent 分支接入。
- 安全：client 全目录无 dangerouslySetInnerHTML/WebView/innerHTML/eval；prose 只产出 text/strong/code span，由 RN `<Text>` 渲染（popover-ui.tsx:280-305），模型/工具输出无法变成 HTML；解析为线性扫描、无 lookbehind，未闭合/空定界符按字面保留（测试覆盖）。
- 数据契约一致：index.client.tsx:347-400 已声明 subagent 的 13 个字段与 subagentChips 两分支，与 tool-call-data.ts:3420-3456、shared/subagent-card.ts 类型一致；server/timeline.ts:826-847（sub_agent:log）、:864-876（unknown:input/output）、:621-630（metadata.dshSubagent）与 resolver 分支对齐。
- harness 为收紧/新增：goal +8、team +9、jobs +7、tool-call +67 条断言，未见放宽既有判据（goal/team 的"单行/字段"钉按新设计改钉，并补 pill/alert/blockedBy/warnings 与 schema-字段漂移断言）；tool-call-check 新增段覆盖数据层、真实编译组件的展开/复制/chips 与 `safeCopyText` 拒绝路径。
- 其他 CI 源码钉静态核对未破：goal-pill-check（facts 钉命中清除页）、row-status-icon-check（单 RowStatusIcon + head aria）、style-check（team-card frameless/无硬编码色）、rewind-notice-check（monitor wiring）、jobs-stop-ui-check。
- i18n：新 UI 复用的 key（unowned/listSeparator/fields.*/card.expand/collapse/statuses.running/currentTaskPrefix/rounds）en/zh 均存在，无新增缺 key；唯一硬编码为 team 详情 `· vN` 版本前缀与列表记号（约定符号）。
- 卫生：变更文件无密钥、真实 provider/模型 id、base URL、本机真实路径（仅既有 harness 夹具的 /home/user、/home/runner 虚构路径）。

## 问题
| 级别 | 位置 | 问题 | 证据 | 建议 |
| --- | --- | --- | --- | --- |
| P2 | harness/offline-checks.cjs:48-60 | 新增的 `paseo-plugin/test/popover-prose.test.cjs` 未登记进 CI 的唯一测试清单 pluginTests，CI 永远不会运行它；`npm test` 不在任何 workflow 中 | .github/workflows/offline-checks.yml:28 只跑 `node harness/offline-checks.cjs`；该文件 pluginTests 列表不含 popover-prose；process-compatibility.yml 只跑 `npm run test:process` | 加入 pluginTests 并在 docs/HARNESS.md 登记（否则解析器回归无门禁） |
| P3 | harness/goal-pill-check.cjs:680 | 源码钉「the objective is one truncated line」在 view/complete 改为 3 行后，只还能匹配到清除确认页；断言名与所钉对象不符（仍绿，判据意图漂移） | goal-popover.tsx:636-640 清除页仍 `numberOfLines={1}`+`{goal.objective}`；view 页同文件 :894-905 已 `numberOfLines={3}` | 改为明确钉清除页，或删掉该钉交给 host-dependent render-check |
| P3 | paseo-plugin/client/jobs-pill.tsx:755-767 | 新「运行中」分区头把 `stopping` 也算进 count，与行内「正在停止」状态矛盾 | 头部 `label={text.statuses.running} count={live.length}`；shared/jobs.ts:72 `LIVE_JOB_STATUSES = ["running","stopping"]` | 头部改用中性文案（如"进行中"）或 count 排除 stopping |
| P3 | paseo-plugin/client/popover-ui.tsx:216-277 | goal ControlError 原有的合并无障碍名（message+original）丢失；role=alert 容器下两段 Text 分开，harness 同步改断言不再覆盖 | 旧实现 origin goal-popover.tsx:239-242 有 `accessible` + `accessibilityLabel="msg original"`；新 PopoverAlertRow 只有 `accessibilityRole="alert"` | 给 PopoverAlertRow 增加合并 accessibilityLabel；真机读屏确认（未验证） |
| P3 | paseo-plugin/client/team-popover.tsx:648-660 | 详情页描述改为 PopoverProse 结构渲染（识别 kicker/heading/list、trim 行首缩进），不再逐字保真；旧 harness「whole description, newlines kept」被换成子句包含断言 | popover-prose.ts:277-342 按行 trim 并改写为 kicker/列表；team-popover-render-check.cjs 改为按子句断言 | 若任务描述可能含需保真的缩进/代码块，保留原文渲染兜底；需真机样本确认（未验证） |

## 未验证项
- 未运行任何构建/渲染/CI（paseo-plugin 构建写 `.dbg-*`，并行会互踩，按任务约束仅静态）：`node --check harness/tool-call-check.cjs` 通过、新增段引用的标识符均存在，但其运行时半（依赖编译产物）与三个 popover render-check 是否全绿未验证。
- CI 整体是否绿未验证（未执行 offline-checks）。
- goal ControlError 的读屏实际表现（需真机 VoiceOver/TalkBack）。
- PopoverProse 对含缩进/代码块任务描述的实际改写影响（需真机样本）。
- 超长 prose 的滚动/性能表现未真机确认（解析为线性、无字符上限）。
