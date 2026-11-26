# B 定价核心 审查报告
状态: completed
范围: `paseo-plugin/shared/pricing.ts`（2160 行新增）、`paseo-plugin/test/pricing.test.cjs`（1796 行，22 条，已登记 `harness/offline-checks.cjs:54` 进 portable CI）。方法：全文只读 + `git show 24faabc/72d888f/95398a5` 对照意图 + `node -e` 加载真实模块实测关键行为（未跑 `node --test`，遵守只读约束）。cache/TTL/single-flight/HTTP 拉取实现在 `server/pricing.ts`（C 块），本块只含目录 schema 契约与 TTL 常量，测试文件里的 8 条 store/sync 测试属间接覆盖。

## 摘要
- 未发现 P0/P1。核心口径均正确：价格单位统一“每 1M token”（`shared/pricing.ts:1893-1895` 统一 `/1_000_000`，`rateNumberSchema` 0..100k）；双币种换算方向正确（1852-1855：USD→CNY 乘 `usdToCnyRate`，成本先按 native 算再折算，展示处不再二次取整）；优先级 override > synced > reference > null（1745-1774）；解析失败响亮抛错（766-768、807-809）。
- token 桶口径与 DSH 一致：`input` 为未缓存输入、`cached`/`cacheWrite` 独立（对照 `@deepseek-ai/dsh-token-meter`：`uncachedInputTokens: usage.inputTokens`），不重复计费。
- 1 个 P2：同步不可用时，内置参考表把 `-pro`/模态变体折叠成基础档，usage 成本静默低估 2~17 倍。
- 4 个 P3：models.dev 非法数值静默回退/丢弃、多上下文阶梯只取最低档、长阶梯部分字段回退口径不一致、提交前卫生（provider 名/模型 id）+ 2 个新导出无测试断言。

## 问题
| 级别 | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| P2 | `shared/pricing.ts:556-565`（对照 906-914、959） | 同步 catalog 不可用（首启同步完成前、离线、models.dev 失败——README.md:583 承诺“安全回退内置参考表”）时，`matchReferenceEntry` 无 distinct-qualifier 守卫，把高档位/模态变体折到基础价：`gpt-5-pro→gpt-5`、`gpt-4o-mini-tts→gpt-4o-mini`、`gpt-4o-realtime→gpt-4o`、`o1-pro→o1`、`o3-pro→o3`。usage 汇总中与已同步行混合、无 provenance 标记。 | `for (const item of SORTED_PREFIX_INDEX) if (matchesPrefixWithBoundary(...)) return item.entry;`；`node -e` 实测 gpt-5-pro → gpt-5（$1.25/$10），而仓库自己的测试夹具对同模型标注官方价 $15/$120（`test/pricing.test.cjs:738-742`），低估 12 倍；gpt-4o-mini-tts 0.15/0.6 vs 夹具 0.6/12（1370-1372），低估 16.8 倍 | 参考表匹配复用 `DISTINCT_MODEL_QUALIFIERS` 守卫（或补 gpt-5-pro/o1-pro/o3-pro/tts/realtime 显式条目）；补负例断言防回归 |
| P3 | `shared/pricing.ts:633-637、730-749` | models.dev 数值字段非法（如字符串 `"0.3"`）被当作“缺失”而非“非法”：`cache_read` 非法→静默按 input 计费（实测 cached=3 而非 0.3，缓存读高估 10x）；`input`/`output` 非法→整条模型静默跳过。无 warning/lastError，上游形状变化会静默产出错价。 | `if (typeof value !== "number"…) return undefined;` + `const cached = parseOptionalRateNumber(rawCost.cache_read) ?? input;`；实测 `parseModelsDevCatalog({anthropic:{models:{"claude-sonnet-4-5":{cost:{input:3,output:15,cache_read:"0.3"}}}}})` → `cached:3` | 区分“缺失 vs 非法”：input/output 非法该条跳过并计数告警，cache 字段非法仍回退 input 但记 warning |
| P3 | `shared/pricing.ts:697-699`（对照 `test/pricing.test.cjs:951-956`） | 多上下文阶梯只取最低阈值（`candidates.sort` 后 `candidates[0]`）。测试夹具本身给 alibaba 两档（32k/128k，价格上涨）并断言“取最低档”；若上游真给 ≥2 个 context tier，超过最高档的 prompt 仍按最低档计费。实测 1.5M prompt 取 200k 档 $2 而非 1M 档 $8，成本 $3.01 vs 应 $12.04。 | `candidates.sort((l, r) => l.threshold - r.threshold); const picked = candidates[0]!;` | 存全部 tier 或按“已跨过最高阈值”取档；需先确认上游语义（见未验证项） |
| P3 | `shared/pricing.ts:1883-1891` | 长上下文阶梯的部分字段回退方向不一致：`longCacheWrite` 缺失→回退短 `cacheWrite`、`longCached` 缺失→回退短 `cached`，而短上下文的同类回退是 `inputRate`。手工覆盖只填 longInput/longOutput 时 cache 桶按短价计，口径静默改变（内置/同步数据均成对提供，当前不触发）。 | `: rates.cacheWrite !== undefined ? rates.cacheWrite : inputRate`（longContext 分支） | 长上下文分支统一回退 `longInput`，或 schema 要求 long 字段成对并在注释写明 |
| P3 | `shared/pricing.ts:48-71、263-492` | 提交前卫生合规歧义：内嵌具体 provider 名（deepseek/anthropic/openai/google…）、具体模型 id 与参考价，与 AGENTS.md:294「提交前确认没有引入任何具体 provider 名、模型 id、base URL、密钥」字面冲突。属定价功能必需，README.md:583 已声明、模块头 9-11 行限定公开模型族，测试 71-93 行反而强制这些前缀。 | `OFFICIAL_PROVIDER_PRIORITY` 名单 + `REFERENCE_PRICING` 各条目 | Lead 记为有意偏差即可，无需改码（`server/pricing.ts:53` 公开 URL 同批，属 C 块） |
| P3 | `test/pricing.test.cjs`（对照 `shared/pricing.ts:578-602`） | 测试有效性缺口：`inferModelFamily`、`officialProviderRank` 两个新导出无任何断言（仅经 `server/pricing.ts:532/553` 间接调用）；参考表折叠 pro/模态变体无负例（95-161 行只测 `gpt-5.2→gpt-5` 这类合法折叠），故 P2 行问题未被测试暴露；多 tier、长阶梯部分字段也无覆盖。其余 22 条为真实断言（官方价/手算值、失败必抛、缓存不被清、无重复键/顺序），未见 assert 死分支（仅 win32 跳过 0600 检查）。 | 测试中无 `family`/`officialProviderRank` 行为断言；无 `gpt-5-pro`/`tts` 折叠断言 | 补 `inferModelFamily` 表驱动断言、pro/tts 折叠负例、多 tier 与部分 long 字段用例 |

## 未验证项
- models.dev 真实 payload 形状未抓取（只读+离线约束）：是否真出现 ≥2 个 context tier、数值是否可能为字符串、cache 字段缺省约定。验证：抓 `https://models.dev/api.json`，统计含 tiers/≥2 tier 的模型并抽样对官方价目；置信度中。
- `pricing.test.cjs` 未整体运行（任务约束未允许；tsc 基线由 Lead 提供）。已用 `node -e` 加载真实模块实测上述行为；验收时建议 `cd paseo-plugin && node --test test/pricing.test.cjs`。
- 缓存 TTL(24h)/单飞/HTTP 大小与超时边界实现不在本块（`server/pricing.ts`，C 块），本块仅确认共享侧 `syncedPricingCatalogSchema` 与 `DEFAULT_CATALOG_TTL_MS` 契约一致。
- `o1-pro`/`o3-pro` 官方价（$150/$600、$20/$80）来自公开价目、未在仓库内二次验证；gpt-5-pro/gpt-4o-mini-tts 的对照价以仓库测试夹具为准。
