# 2026-10-20 全量审查记录

> 分支 `audit/full-review-20261020`（基线 `main` = `2496f0b`）。
> 版本基线（本机实测，npm dist-tag `latest`）：**Paseo 0.12.0**、**DSH 0.2.1-rc.2**。
> 本文只记本轮发现与修复；安装/自举流程仍见 [ADOPTION.md](./ADOPTION.md)、
> 0.12 适配见 [0.12-ADOPTION.md](./0.12-ADOPTION.md)，历史缺陷见 [FIELD-NOTES.md](./FIELD-NOTES.md)。

## 1. 结论

- 6 路只读并行审查（server-session / server-core / client / bridge / 契约与仓库卫生 / harness），
  合计发现 **P0 0、P1 8、P2 34、P3 49**；每条的路径:行号、触发场景、最小修法与未验证项
  在 `~/.dsh/reviews/full-audit-20261020/<area>.md`。
- 按写范围不重叠原则开 6 个 Phase 2 修复流 + 2 个收尾流，**P1 8/8 修复**，
  P2 修 32 条（2 条登记为后续），P3 修 23 条（其余 26 条登记为后续，§7）。
- 冻结后离线验收：**30 个脚本全绿、0 FAIL**（含新增 `harness/session-request-check.cjs`）；
  `tsc --noEmit` 绿；`bridge-assets-check` 2/2（内嵌桥重生成后）；`git diff --check` 干净。
- 真机验收（新桥 provision 进 live profile 之后）：`plugin-check` 32/32、`archive-registry-check` 2/2、
  `probe` exit 0、`stream-probe` 5/5、`rewind-e2e` 12/12、`doctor` 全绿（§6）。

## 2. P1（全部修复）

| # | 区域 | 缺陷 | 修法 | 证据 |
|---|------|------|------|------|
| 1 | server-core | 宿主下发的 `config.systemPrompt`（含 daemon 级 append）被**静默丢弃**；全库 grep `systemPrompt` 0 命中 | 非空时 stderr 警告 + `session.ready` 后发时间线通知；注释写明完整修需桥加会话级 prompt section（未做，不假装支持） | 宿主 `plugin-provider.js:1305` 填充该字段；真机 agent 记录含 400 字 systemPrompt。`provider.ts:867-877/1079-1085` |
| 2 | server-core | 会话物化失败被降级成 "command catalog failed" 日志后仍报 `session.ready` → `/` 菜单与权限选择器静默消失 | 停放进程 kill 后**有界等待退出**（5s）；`#open` 加「同 dshSessionId 不被本连接另一 session 持有」不变量 + `#opening` 并发标记；权限预设/命令目录失败发 warning notice | 真机 58 条 `already owned by an active write handle`（0.11.2×33/0.11.4×25）。`provider.ts:830-860/978-997`、`parked-sessions.ts:228-299` |
| 3 | server-session | 宿主注入 prompt（schedule 火、notify-on-finish，`<paseo-system>` 信封）live 显示成用户原始 XML，replay 又按 `source.kind!=="user"` 丢弃 → 重开/撤回 reload 后该行消失、助手回复孤立 | **冻结跨区接口**：桥 `session/prompt` 回执新增可选 `sourceKind`（=DSH `source.kind`）；插件只在缺失或 `"user"` 时发 user 行（缺失保持 legacy）。不解析 XML | `session.ts:207-227/936-958/986-1018`、`dsh-bridge/lib/server.js:561-590` |
| 4 | client | `worktree_setup` 行渲染成"图标+线名"的空行，`worktreePath/branchName/log` 全丢（daemon 合成的 provider 行必过 transformer） | 加 `case "worktree_setup"`：primary=branchName‖worktreePath、body=log、可展开；补中英标签 | 数据层实测原为 `summary:"" body:"" hasDetail:false`；`tool-call-data.ts:1303-1318` |
| 5 | 契约 | npm 最新发布 `paseo-dsh@0.2.9`（10-17）**不含** main 的 Paseo 0.12 适配；README「一行安装」在 0.12 上拿到旧行为 | README 如实标注 + 源码安装指引；`package.json`/lock bump **0.2.10（未发布）**；发布等用户签字 | unpkg 0.2.9 的 `client/tool-call-data.ts` 无 `agentMessage`（main 16 处） |
| 6 | 契约 | `install.sh --profile NAME` 只建目录/写路由，插件仍按 `DSH_PASEO_PROFILE??"paseo"` 启动、doctor 也只查 `paseo` → 自定义 profile 永不生效 | `--profile` 与 env 不一致时**直接 die** 并给两条修法；next steps 要求 `paseo.service` 加 `Environment=`；doctor 按同一 profile 检查 | 复现：`--profile x` 无 env → 装完后 daemon 仍 boot `paseo` |
| 7 | harness | 假桥离线脚本只设 `DSH_BINARY` 不设 `DSH_HOME`，加载插件会**重写 live profile 的桥**（实测 mtime 变化）→ 桥过期时把旧桥装进真机，让真机检查在旧代码上假绿 | 6 个插件级脚本改用一次性 `DSH_HOME`；冻结验收时复核 live profile 桥 mtime/哈希跑前跑后不变 | `/tmp/dsh-*-check-*` 残留 0、profile 聚合 sha256 不变 |
| 8 | harness | `plugin-check` 的 prompt 缺 `clientMessageId`/`delivery`（`ProviderPrompt` 必填），断言只查非空串 → `turnId=turn:undefined` 也 PASS | 4 处 prompt 补齐；断言改为精确 `turnId === "turn:check-image-1"` | 修前实测 `turnId=turn:undefined`；修后 32/32 精确匹配 |

## 3. P2（修 32 / 34）

- **server-core（4）**：`defaultThinkingOption` 必须落在 `thinkingOptions` 交集中才写；
  `#reverting` 闸门按 dshSessionId 释放（宿主每次 open 铸新 id，否则成功后 15s 必打误导日志）；
  `DSH_HOME` 对齐 DSH 的 `~` 展开 + `resolve`（原先 profile 可能建到错位置）；
  按桥上报的 `planMode` 过滤 `plan` 模式声明（未挂载时不声明，避免用户选了被丢弃）。
- **server-session（4）**：`FileDiff.oldText` 为 `null` 时归一为 `""`（write 覆盖空文件的 diff 卡不再静默丢）；
  枚举 RPC 期间子代理帧先入缓冲（撤回 reload 复用停放进程时不再卡 running）；
  纯图片 prompt 在 replay 不再整行丢失（`[image]`/`[file]` 占位保住行与 revert 锚点）；
  同一卡片内重复 header 唯一化（`Confirm` / `Confirm (2)`），两问答案不再串位。
- **client（4）**：补 `archive_subagents` / `terminal_send` / `paseo_worktree_terminals` 的标签与图标；
  `newest` 首绘 pass ≥2 行判历史（重开 2–4 行旧会话不再误脉冲 6s）。
- **bridge（10）**：子代理归档的 running 判定改用 `live?.status`（原 `getSnapshot` 恒 false，会中断在跑子代理）；
  `session/prompt` 回执带 `sourceKind`；resume 从持久 header 读 preset 并补 `agent-preset/selected`（失效 preset 回退默认且大声记录，见 §5）；
  rescue 快照名改 `时间戳-counter-sha256(路径)前16-截断basename`（深路径 429 字符实测由 failed→restored）；
  MCP 图片临时名改进程级单调计数（同工具两次返回图片不再互相覆盖）；
  撤回 settle 同步清 `nextStep`+`nextTurn`（排队回合不再让 whenIdle 多等一整回合致 15s 超时）；
  `paseo/sessions` 失败改 fail-loud（`{available:false,error}`）；快照路径改 `await workingDirectory.ensure()`；
  忽略 `sessions.flush()` 布尔回执改为 false 时抛错；preset 入队前校验、仅终态失败清队；
  恢复 `str_replace_editor` 写命令追踪（create/str_replace/insert 取 `path`，view/未知命令不算写）。
- **契约/卫生（7）**：`install.sh` 的 `ln -sfn` 对真实目录生成嵌套链接并谎报 linked → 改「只换符号链接、真实目录不动、创建后校验」；
  checkout 自检改 `node paseo-plugin/bin/paseo-dsh.mjs doctor`（`npx` 查的是 npm 发布包）；
  CI 同步工作流加最小可信门（`npm ci` + `tsc --noEmit` + `node --check` + `bridge-assets-check` + 9 个零依赖离线脚本，失败不 push）；
  AGENTS.md 验证清单补 9 个漏列脚本并修正计数/前置条件；`paseo-plugin/README` 的 checkout 安装命令改为 0.12 可用写法；
  补 DSH 最低版本声明（README + doctor 判据收紧到能区分 0.2.0/0.2.1）；README 里与 bootstrap 实现相反的「链桥 + git pull 生效」描述改正。
- **harness（3）**：假桥补 `paseo/revert`、`paseo/sessions` 分支并新增 `session-request-check.cjs`（11 条，原本 revert/sessions 无离线覆盖）；
  `file-snapshot-check` 补 5 条 `str_replace_editor` 断言（49→54）；`.gitignore` 补 `.dbg-*/`，`frames*.jsonl` 移出仓库。

## 4. P3（修 23 / 49）

修掉的代表项：孤儿 JSDoc 归位（server-core 2 处、bridge 1 处、session 1 处）；
`transport.js` 死代码（`#closed` 从不置真、`onNotification` 无调用方、`JsonRpcResponseError` 无消费者）删除并让坏帧记日志；
删除给 `subagent/subagent_fork` 注入的 `run_in_background` 死 shim（0.2.1 无此参数）；
删除 `profileName` 三处重复定义/死导出、`#dshIds` 加上限 500；客户端恒 false 分支、未用 colors、
无消费者的 `phase` 与两个高度常量、指向已删 `./shimmer` 的注释；
`revert-check` 两条因 `#emitUserMessage` 重构而失效的 source-regex 断言改为跨行匹配并做变异验证；
`FIELD-NOTES` 57b/57c 补记、`REWIND.md` settle 与 `str_replace_editor` 追踪说明同步。

另外 Lead 在真机门里抓到 harness 自身一类缺陷：`probe` / `stream-probe` / `rewind-e2e` /
`rewind-merge-e2e` 的请求超时定时器没有 `unref()`，最后一个请求之后事件循环被占住最长 180–240s，
**成功的探针看起来像挂起**（被外层 `timeout` 杀掉并记为失败）。已统一 `unref()`，并用干净退出
（`probe exit=0`、`rewind-e2e exit=0`）验证。

## 5. 有意偏差（明确记录，不当作缺陷）

1. **resume 时 header 里的 preset 已不存在**：DSH 官方 `composeAgent → presets.resolve` 会抛
   `agent-preset/not-found` 让会话打不开；桥选择**回退默认 preset + stderr 大声记录 + 补
   `agent-preset/selected`**，因为「会话不能永久打不开」优先。`dsh-bridge/lib/server.js:2105-2116`。
2. **`config.systemPrompt` 只做响亮化**：完整支持需要桥给 DSH 加会话级 prompt section，本轮不做，
   代码注释与运行期通知都说明「未生效」。
3. **`newest` 脉冲的两个已知取舍**：1 行历史的最后一行仍会闪 6s（与实时首条命令不可区分，固有限制）；
   首绘 pass 同时出现 ≥2 个实时工具行会被当作历史而不闪（换掉短历史误闪的代价）。`client/newest.ts` 注释已写。
4. **未挂载 plan mode 时隐藏 Plan**：见 §6 的 profile 说明——这是按数据源如实降级，不是功能消失。

## 6. 验证

### 离线（冻结树，全新 `.dbg` 编译）

30 个脚本全部 exit 0、0 FAIL，断言计数与基线一致，唯一变化是
`file-snapshot` 49→54（本轮新增 5 条 `str_replace_editor`）：

```
archived-lineage 12  image-host-path 33  bridge-assets 2   revert 98        surface 18
file-snapshot 54    rewind-merge 49     mcp-http 26        paseo-system-envelope 33
doctor 9            probe-check 21      revert-shape-probe 10  session-request 11
timeline 187        newest 36           style 253          sweep 25         thinking 37
uploaded-file 17    parked 27           context 8          agent-message 111
tool-call 335       locale 222          subagent 68        steer 25
mcp-injection 10    assistant-stream 7  image 8
```

`git diff --check` 干净；改动桥 js `node --check` 全 OK；`tsc --noEmit` exit 0；
`bridge-assets.ts` 与 `dsh-bridge/`+`templates/` 逐字节一致。

### 真机

全部在**新桥已 provision 进 live profile** 之后跑（`plugin-check` 加载插件会把内嵌桥写进
`~/.dsh/profiles/paseo/node_modules/dsh-paseo-bridge`，校验与 `dsh-bridge/lib/server.js` 逐字节一致）：

| 检查 | 结果 |
|---|---|
| `node harness/plugin-check.cjs` | **32/32 passed**（插件层事件形状、图片、附件、会话导入、reopen 回放） |
| `node harness/archive-registry-check.mjs` | **2/2 passed**（首帧 `paseo/archive` 到达真 `workspaceRegistry`） |
| `node harness/probe.mjs` | **exit 0**：initialize、提问往返（收到 1 个 `paseo/question`）、权限/沙箱/审批事件、`paseo/config/set`、`paseo/catalog`、shutdown |
| `node harness/stream-probe.mjs` | **5/5 passed**：28 个 delta 帧先于 durable 消息、前缀单调增长、首 delta 6.45s vs durable 9.55s、折叠成 1 条 assistant + 1 条 reasoning |
| `node harness/rewind-e2e.mjs` | **12/12 passed**：撤回删文件、replay 只剩第一条 user 消息、被撤回合事件不重放、模型只知道 ALPHA |
| `node paseo-plugin/bin/paseo-dsh.mjs doctor` | 全绿（plugin 0.2.10、dsh 0.2.1-rc.2） |

`plugin-check` 日志里的 `plan mode could not be reconciled on open (build): plan mode is not
mounted in this profile` 是 §8 的 profile 组合问题，现在会**大声记录**而不是静默忽略。

## 7. 未修 / 后续（登记，不在本轮范围）

- **client P2-5**：被取代的行不会立刻停闪（≤6s 内 2–3 行同时扫光）。需要跨行订阅；
  「宿主 append 新行时是否重渲染旧行」未验证。
- **coverage gaps**：`dsh-bridge/lib/subagent-archive.js`、`mcp-gateway.js` 本体与
  `server/bootstrap.ts` 仍无离线断言（桥侧本轮用自建探针 19/19 + 真 profile 覆盖）。
- **client P3 剩余**：`working_directory` 无标签/图标（本机 0 次真实调用）、
  `sweep-geometry` 三个导出无生产消费者（同时是「与 DSH 一致」的唯一凭据，改动需同步 harness）、
  `TERMINAL_MAX_LINES`/`CODE_MAX_HEIGHT` 与两个高度上限未实现（RENDER-PLAN 记缺口）、
  折叠控件 a11y 文案未按 DSH 分块、`web_search→Globe` 仍无断言、RENDER-PLAN 文档漂移。
- **bridge P3 剩余**：`archive-lineage` 与 DSH 在「直接父不 live」时语义不同（冷路径更严）、
  `mcp-http` 工具清单进程级缓存与注释不符、`waitForChildren` join 全部后代每次多等 3s、
  `file-snapshots.js` 四个死导出、`commands` 用 `this.cwd` 而非 `workingDirectory` 等。
- **契约 P3 剩余**：README/ADOPTION 中仍有一些只影响阅读的措辞；`revert-shape-probe` 的
  默认模块路径仍硬编码本机 `~/.npm-global`（可用 `DSH_SESSION_MODULE` 覆盖）。
- **系统调用/时序类**（需真机场景）：真实 daemon 的重复 open 接管、停放 mismatch 最坏 +5s、
  `flush=false` 分支、preset 重开、MCP 同一工具两次返回图片、删除 cwd 后的快照路径、
  宿主注入 prompt 端到端（schedule 火触发）。

## 8. 本机环境问题（不是仓库缺陷）

本机 `~/.dsh/profiles/paseo` 的 bundle 列表里叠加了 `@deepseek-ai/dsh-web-app`，而该 bundle 的
patch **显式禁用** `plan-mode`（`dsh-web-app/cordis.patch.yml:529-530` → `disabled: true`）。
在桥 profile 里这意味着：

- 桥 `paseo/plan/get` 返回 `available:false`、`paseo/plan/set` 抛 "plan mode is not mounted"；
  修复前插件仍声明 Plan 模式，用户选择后报错（真机 0.12.0 日志有 1 条）。本轮 P2 改为按数据源过滤后，
  Paseo 里 **Plan 选项消失**（正确降级）。
- 实测对照：`dsh-base + dsh-paseo-bridge`（仓库自举的 profile）→ plan 可用（`paseo/plan/set` queued）；
  再叠加 `dsh-web-app` → plan 不可用。因此**不是本仓库代码问题**，是 profile 组合问题。
- **恢复方法（2026-10-20 在本机验证通过）**：不要删 `dsh-web-app` —— 它提供 `webServer`/`connection`
  服务，`dsh-prime-memory` 依赖它们，删掉会让记忆插件永久 pending。正确做法是在 profile 自己的
  `cordis.patch.yml` 末尾按 id **只覆盖 `disabled`**（DSH 的 patch 按 id 合并覆盖键，`config` 不写就
  沿用 base 那份，计划模式的政策文本不会丢）：

  ```yaml
  - id: plan-mode
    disabled: false
  ```

  验证链（本机实测）：`dsh --profile paseo --dump-config` 里 `plan-mode` 行存在且带 `config.section`；
  桥 `paseo/catalog` 返回 `planMode: true`；`paseo/plan/get` → `available:true`、
  `paseo/plan/set active=true` → `outcome:"queued"`；启动无 "entry did not activate" 告警。
  备份：`~/.dsh/profiles/paseo/cordis.patch.yml.bak-plan-restore-<时间戳>`；回退就是还原该备份。
- **生效时机**：profile 只在新的 `dsh --profile paseo` 子进程里生效；插件对 catalog 有 5 分钟 TTL
  缓存（`provider.ts` 的 `CATALOG_TTL_MS`），所以**等 ≥5 分钟后开一个新会话**即可看到 Plan；
  不想等就 `paseo daemon restart`（会中断正在跑的 agent，别在有任务时做）。
- `harness/probe.mjs` 已改为在 `available:false` 时**跳过** plan set 并打印原因，不再把
  「profile 没挂 plan mode」当成 probe 失败。

## 9. 待用户决定

1. **发布**：`0.2.10` 已在源码里 bump，但按 AGENTS.md 的硬性流程，`npm publish` 必须等你本机
   真机测试通过并明确确认。在此之前 npm 上仍是 0.2.9（不含 0.12 适配），README 已如实标注。
2. **分支处置**：本分支是否 push 到 `origin`；`audit/full-review-20261020` 为一次性审查分支，
   合回 `main` 前建议再做一轮真机 UI 目视（§7 的 App 侧项）。
3. **`feat/unify-profile`**（未合并，6 commits）：结论是**不整体合并、不删**——核心改动（默认 profile
   改 web + 会话级 `--patch` overlay）是破坏性变更且本机未落地；可单独摘 `8323362` 的
   install.sh/doctor/generator 修复与 `b09022d` 的原子换桥，建议另开小 PR。
4. 本机 profile 是否移除 `dsh-web-app` 以恢复 Paseo 里的 Plan 模式（§8）。
