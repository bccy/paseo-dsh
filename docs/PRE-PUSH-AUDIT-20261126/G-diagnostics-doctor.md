# G 诊断/doctor-core 审查报告

状态: completed
范围: 08585a8 / 48f63b4 / 59cb50d 涉及的 paseo-plugin/server/diagnostics.ts（1202 行）、server/doctor-core.mjs（1847 行新增）、server/doctor-core.d.mts（219 行）、lib/doctor.mjs（1138→76 行）、test/diagnostics.test.cjs（1197 行）、harness/doctor-check.mjs（±12）；对照 origin/main、48f63b4 版本与本机 Paseo 0.17.4 宿主源码。全程只读，未改源码。

## 摘要

- 抽取等价性成立：48f63b4 的 lib/doctor.mjs 与 HEAD 的 server/doctor-core.mjs 逐行 diff 只有 4 处适配（import 路径、HERE/require→moduleMetaUrl/getLocalRequire、可选 pluginDir 参数、移除 CLI 渲染 runDoctor），无判定逻辑改动；lib/doctor.mjs = core 全部 20 个 value export + runDoctor，旧公共导出（runDoctor）无缺失（动态 import 实测集合对账）。
- CLI A/B 逐字节相同：/tmp 双副本（旧版 lib + dsh-command.mjs、node_modules 软链）+ 注入 runner，正夹具（全绿）与负夹具（坏 patch、缺 bridge、低 dsh 版本）下 runDoctor 的 stdout/stderr/exit code 全部一致（0 / 1）。
- 静态打包已用真实宿主编译器验证（非 tsc 模拟）：Paseo 0.17.4 的 packages/server/dist/server/server/plugins/compiler-build.js 编译 index.server.ts，产物中无 `require("./doctor-core.mjs")`（已内联），`import.meta` 被替换为 `var import_meta = {}`，moduleMetaUrl() 返回 undefined 后走 require 回退，与文件头注释一致；bundle 内含 runDoctorChecksAsync 与 diagnostics RPC。
- 发布/构建命中：npm pack --dry-run 清单含 lib/doctor.mjs、server/doctor-core.mjs、server/doctor-core.d.mts；plugin-build.cjs runtimeAssets() 按 server/*.mjs 复制（.d.mts 仅类型，不需运行时）；prepack 只生成 bridge-assets，doctor-core 是源文件而非生成物，无需再生成。
- 门禁实跑：node harness/doctor-check.mjs 64/64 绿（±12 行只是给沙箱补拷 doctor-core.mjs，未放宽判据）；node --test test/diagnostics.test.cjs 13/13 绿（覆盖单飞、真实挂起子进程 kill、eval 包装无 __dirname、隔离 /tmp 下零 lib/doctor.mjs 可达）。
- 失败态总体响亮：run-doctor 的加载失败/超时/执行异常都返回 fail 检查 + fixHint，客户端有 danger 横幅与修复步骤；overview 的“版本未知当健康”见 P2。

## 问题

| 级别 | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| P2 | paseo-plugin/server/diagnostics.ts:822-826、876-885；paseo-plugin/client/console-diagnostics.tsx:1146-1147 | dsh 二进制存在但版本无法确定时 overview 仍 hasIssues=false（聚合“健康”），探测失败被当成通过（“没检查”渲染成默认成功值） | `return buildResult(version, false, version === undefined && resolvedPath === undefined ? "dsh not found on PATH" : undefined);` —— resolvedPath 有值时 error 缺省；hasIssues 只判 `dsh.error!==undefined || dsh.versionOk===false`。实测：/tmp 放 `exit 1` 的假 dsh 作 binary，overview() 返回 {无 version / versionOk / error}、hasIssues=false；测试只覆盖可解析版本（test/diagnostics.test.cjs:587-666） | 把“version 与 versionOk 均缺省且无 error”计为 issue，或加显式 unknown 状态；聚合徽标按警告渲染 |
| P3 | paseo-plugin/server/doctor-core.mjs:1710-1727 对照 1788 | 同步 CLI 在 readPluginVersion 失败时返回 fatalError（exit 1），异步 RPC 路径完全忽略 pkg.error：打包态插件版本不可得时报告省略 pluginVersion，并跳过“插件与 DSH 线路不匹配”warn，未标注“未检查” | 1710 起 `const pkg = readPluginVersion(...)`，失败分支 `return { fatalError: pkg.error, ... summary:{fail:1,blocking:true} }`；1788 同名调用后直接 `evaluateDoctorChecks({ pluginVersion: pkg.version, ... })`，无 error 分支；test:1132 明确断言打包态 pluginVersion=undefined 且 report.ok=true | RPC 报告显式带 pluginVersionUnknown 标记，或加一条 warn “插件版本不可得，DSH 线路兼容性未检查” |
| P3 | paseo-plugin/shared/diagnostics.ts:216-219；paseo-plugin/server/diagnostics.ts:47,963-966 | 契约允许 timeoutMs 到 60s，但 Paseo 0.17.4 宿主 invoke 的硬超时是 30s：传 >30s 会被宿主先截断，拿不到本模块干净的 timeout 报告（当前 UI 只传 `{}`，故为潜在契约不一致） | `timeoutMs: z.number().int().min(1_000).max(60_000).optional()`；`MAX_RPC_TIMEOUT_MS = 60_000`；宿主源码 packages/server/src/server/plugins/runtime.ts:64 `const REQUEST_TIMEOUT_MS = 30_000;`（349-355 映射到 invoke） | 上限收敛到 ≤29s，或保留 60s 但在注释/文档写明宿主会先超时 |
| P3 | paseo-plugin/server/doctor-core.d.mts:1-219；paseo-plugin/package.json scripts.prepack | 219 行类型声明纯手工维护，无生成/新鲜度校验：tsconfig include 只收 `**/*.ts(x)`（.mts 不在编译根集，只经 import 解析），prepack 只跑 generate-bridge-assets；改 core 不改 d.mts 不会变红（当前 20 个 value export 与签名核对一致） | tsconfig.json `"include": ["**/*.ts", "**/*.tsx"]`；package.json `"prepack": "node scripts/generate-bridge-assets.mjs"` | 加导出/签名对账脚本（动态 import core + 解析 d.mts），或从 JSDoc 生成 d.mts |
| P3 | paseo-plugin/server/diagnostics.ts:252-261、453-525、640-675 | 生产 bundle 保留仅测试可达的 lib/doctor.mjs 动态定位/import 回退（walkAncestorsForDoctor/stackFrameDirs/nativeDynamicImport），且 redactBaseUrlHost 与 doctor-core.mjs:736 重复实现（本地副本只被测试引用），两处增加漂移面 | index.server.ts:122 `new DiagnosticsService()` 无 doctorModulePath → #loadDoctor 恒返回 bundledDoctorModule；diagnostics.ts:252 副本仅 test:422-424 使用 | 测试改用 core 导出的 redactBaseUrlHost；删除或注释明确保留理由，去掉双实现 |
| P3 | paseo-plugin/server/doctor-core.mjs:1388-1408（run-doctor 才有）；server/diagnostics.ts:876-885（overview 无） | overview（设置 Tab 首屏与健康聚合）不检查 Paseo 宿主版本：低于 MINIMUM_PASEO 时概览可能全绿，只有点完整 Doctor 才见 paseo-cli fail；零子进程设计是有意的，但只看概览会漏宿主不匹配 | paseo-cli 判定只在 evaluateDoctorChecks（run-doctor）；overview 的 hasIssues 无宿主版本项（diagnostics.ts:830-832 明确其“不跑 paseo CLI”的取舍） | 概览 UI 明示“宿主版本请在完整 Doctor 检查”，或从宿主握手/环境信息廉价取版本放入概览 |

## 未验证项

1. 真机插件加载后调 dsh.diagnostics.overview / run-doctor 未复验（已用 Paseo 0.17.4 的 dist 编译器离线打包验证内联，但未装进运行中的 Paseo 看 UI 错误态）。
2. run-doctor 外层超时后子进程清理与紧接下一轮 `dsh --dump-config` 写 cordis.yml 的重叠窗口未实测（killChild 先 SIGTERM、400ms 后 SIGKILL；理论上有串行化，但旧子进程未 reaped 时可能重叠）。
3. harness/doctor-live-check.mjs 未复跑：已知既有红（fixture 把 `paseo --version` stub 成 0.14.0 < MINIMUM_PASEO 0.16.0），与本批改动无关。
