# C 定价服务端 审查报告
状态: completed
范围: `paseo-plugin/server/pricing.ts`（新增 850 行，提交 24faabc / 72d888f / 96eb31e / 95398a5）+ `paseo-plugin/index.server.ts` 定价接线（index.server.ts:125-170、261-263）。基线 `tsc --noEmit` exit 0 由 Lead 跑过，未重复；全程只读（read/grep/git show/node -e），未跑测试、未联网、未写仓库。

## 摘要
- 结论：**无 P0 / P1**。可推送。主要风险集中在「磁盘文件损坏时静默回退默认值」「热 RPC 上挂重诊断依赖」两处 P2，其余为文档漂移/加固建议。
- 已验证通过：`tmp+rename` 原子写 + `0o600`/目录 `0o700`（pricing.ts:765-779）；失败不覆盖既有磁盘缓存（648-666）；single-flight 去重（365-376，测试 1059-1210）；`dispose()` 清启动 timer 并 abort 在飞 fetch（379-389，index.server.ts:262 调用）；网络/HTTP/JSON/超限/超时失败均写 `sync.lastError` 回传给 UI（console-pricing.tsx:2154-2155、2369-2374），不是静默降级；`dsh.pricing.*` 入参由 SDK 按 zod schema 校验、`.strict()` 拒绝未知字段，`dsh.pricing.update` 内再 parse 一次（pricing.ts:397），不存在 unknown input → completed；96eb31e「参考备注不得泄漏到已同步行」已落实且 72d888f 起有回归测试（pricing.ts:491/540，pricing.test.cjs:1269-1276）；server 侧无密钥、无本机真实路径。

## 问题
| 级别 | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| P2 | paseo-plugin/server/pricing.ts:725-731, 740-749, 437 | 配置/目录文件读失败（非 ENOENT）静默回退默认值：无坏文件备份、无 UI 错误，下一次 `update()` 用默认值重写原文件，用户自定义单价/汇率实际丢失 | `if (code !== "ENOENT") { this.warn(...); } this.config = defaultPricingConfig();`；随后 `await this.writeAtomicFile(this.filePath, validated);` | 非 ENOENT 时先把坏文件 rename 为 `.corrupt-<ts>`，并把 readError 放进 state 让 UI 提示；`update` 前若检测到曾回退则明确提示将覆盖 |
| P2 | paseo-plugin/server/pricing.ts:793-809；paseo-plugin/index.server.ts:155-157 | seen/configured 模型注入失败被完全吞掉（连 warn 都没有）：usage 引擎或 diagnostics.overview 抛错时，定价表静默缺「本地已用/已配置模型」行，无迹可查 | 三处 `} catch { return new Map<string, string>(); }`；测试把该降级当预期（pricing.test.cjs:1778-1782） | 至少 `this.warn(...)` 记一次；或让 state 携带 enrichment 错误位，便于运维定位 |
| P3 | paseo-plugin/server/pricing.ts:320-329 | 服务端无周期 re-arm：启动后 4s 只跑一次定时同步，运行超 24h 且未打开控制台时目录不会自动刷新；与 README 承诺措辞不一致 | `setTimeout(... void this.runBackgroundAutoSync() ...)` 内不重排，全文无 interval（grep 0）；README.md:583「每 24 小时自动刷新」；实际另有 TTL 懒刷新（336-343），打开控制台即触发（console-screen.tsx:230） | 文档改为「启动后 + 打开控制台时按 24h TTL 刷新」，或补周期 timer（务必 unref 并纳入 dispose） |
| P3 | paseo-plugin/index.server.ts:130-155 | `dsh.pricing.get` 热路径每次执行完整环境概览：`diagnostics.overview()` 内含逐文件安装检查（doctor-core.mjs:958+）与版本缓存检查（diagnostics.ts:834-859；版本探测每 5 分钟一次、wrapper 场景可能 spawn `dsh --version`，diagnostics.ts:44、759-833），客户端 sync 期间 1.5s×20 次轮询（console-pricing.tsx:1899-1930）会重复 | `const [overview, resolver] = await Promise.all([diagnostics.overview(), pricingStore.resolver()]);` | 缓存 overview 结果（30-60s）或改读 profile 配置，避免热 RPC 做全量安装检查（耗时未实测） |
| P3 | paseo-plugin/server/pricing.ts:54 | 硬编码公共 base URL `https://models.dev/api.json`，与 AGENTS.md:294「不得引入任何具体 provider 名、模型 id、base URL」字面冲突；属本功能声明的公开数据源且 README.md:583 已写明 | `export const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json";` | 建议 Lead 记为有意偏差（与 shared/pricing.ts 内置 provider 族/模型 id 同类） |
| P3 | paseo-plugin/server/pricing.ts:233-235, 400-446, 753-763 | 写串行仅进程内 promise 队列（tmp+rename 只保证原子、不防丢更新）：同一 `$DSH_HOME` 下两个 plugin-process 同时 read-modify-write 会互相覆盖 | `const run = this.writing.then(async () => { ...structuredClone(this.config)... })` 无文件锁/mtime 校验 | 低优先级；如需多实例支持，加锁文件或写前 mtime 比对（未复现） |
| P3 | paseo-plugin/server/pricing.ts:297-302 | `isCatalogStale` 对未来 `syncedAt` 无上界：`now - syncedMs` 为负永不满足 TTL，磁盘时间戳异常（时钟回拨/手工改）会永久停摆自动刷新 | `return this.now() - syncedMs >= this.catalogTtlMs;`；schema 仅 `z.string().min(1)`（shared/pricing.ts:229） | 对 `now < syncedMs` 的时间戳直接判 stale，或 `Math.max(0, ...)` |
| P3 | paseo-plugin/server/pricing.ts:264, 276 | 公开方法 `reload()` / `catalogSnapshot()` 生产与测试均无调用（`snapshot()` 仅测试用），属小段死代码 | 全仓 grep 仅定义处命中，测试只用 `store.snapshot()`（pricing.test.cjs:484/531） | 删除或标注为测试辅助 |

## 未验证项
- **models.dev 真实 payload 形态**（未联网，置信度中）：server 参考族行用精确 key 查表（pricing.ts:469 `catalog?.models[entry.key]`），而内置 Claude 族 key 用点号（shared/pricing.ts:282/322/329）且前缀表同时收录连字符写法（共享表明确预期两种 id 并存）。若真实 Anthropic id 为连字符，参考族行永不叠加官方价，且同模型会同时出现「参考族行 + 同步行」两行；若这是刻意区分族行/模型行则非缺陷。验证：`curl -s https://models.dev/api.json` 统计 22 个官方 provider key 与模型 id 形态，再构造 `store.state()` 断言行数。
- **真实网络边界**（置信度中）：10s 超时、32MiB 上限、无 `User-Agent`、默认跟随重定向在真实网络/慢网下的表现；单元测试只用 mock fetch 覆盖 5 类失败（pricing.test.cjs:1059-1210），未实测真实拉取与慢网失败率。验证：隔离环境跑一次真实 sync 并观察 lastError/耗时。
- **`dsh --version` 探测频率**（置信度中）：`pricing.get` 间接触发的版本探测在自定义 wrapper 场景的实际频率（依赖 diagnostics 版本缓存命中率与 `@deepseek-ai/dsh/package.json` 快路径是否可用），未实测。
- **跨进程并发写丢更新**（置信度低）：需同机两个 plugin-process 共享 `$DSH_HOME` 才能复现，本次未构造。
