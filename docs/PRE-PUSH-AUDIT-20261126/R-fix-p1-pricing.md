# R P1-3 复审（定价损坏文件）
状态: pass
## 判定
修复成立、可放行：坏 config/catalog 均 rename 为同目录 `<path>.corrupt-<UTC时间戳>`（文件名无 `:`/`.`,内容逐字节保留）；`update()` 写盘前对有备份者 warn 一次、对隔离失败者抛错拒写（reset/resetOverrides 同走该守卫，config 文件无其他写入方，writeAtomicFile 仍为未改动的 tmp+rename 原子写）；`pricingStateSchema` 新增字段只作用于 RPC 输出，持久化用的 `pricingConfigSchema` 未变（旧文件实测正常解析）；无新增竞态（rename 在单飞 load 内、先于写队列；单进程单 store，index.server.ts:126；多实例共享 DSH_HOME 时退化为保守拒写、不丢数据）；新增测试真实有效。
## 独立验证（本机 Linux，uid=1000 非 root）
- `node --test test/pricing.test.cjs`：tests 25 / pass 25 / fail 0 / skipped 0（rename 失败用例真实执行，未 skip）；`npx tsc --noEmit`：exit 0。
- 手工复现（/tmp，只写 /tmp）：坏 config+catalog → 生成 2 个 `.corrupt-*`，与原文 readFile 逐字节相等；state 过 schema，readError/recoveredFromCorruption/corruptBackupPath 正确；update 后备份内容未变、仅 warn 1 次；旧格式 config（无新字段）正常解析。
- 只读目录复现隔离失败：原文件逐字节保留、update 抛 `Refusing to overwrite pricing config`、无半成品备份；chmod 恢复后同一实例 retry 仍拒写（reload() 后才可写）。
- 变异验证（/tmp 预加载改编译产物）：禁用隔离 rename → 2 条测试红；删除 update 守卫 → 新 2 条测试红，证明非自证。
## 问题（若有）
| 级别 | 位置 | 问题 | 证据 |
|---|---|---|---|
| P3 | server/pricing.ts:453-457 | 拒写消息「Repair or move that file, then retry」不可执行：同一实例不会重试隔离（`reload()` 无 RPC/生产调用方，server/pricing.ts:277），修好权限或移走文件后 retry 仍抛同一错，只有重启插件进程才能恢复 | 只读目录复现：chmod 恢复后 update 仍拒写；reload() 后才成功 |
| P3 | server/pricing.ts:766-771、shared/pricing.ts:2086-2097 | 恢复事实仅限本进程且 UI 未消费：重启后文件已被移走按 ENOENT 当干净首启（readError=null、不再 warn），`.corrupt-*` 只能靠翻目录/stderr 日志发现；client/ 无三个新字段引用 | 手工两实例复现恢复标记消失；grep client 无 readError/recoveredFromCorruption/corruptBackupPath |
## 未验证项
- Windows：chmod(0o500) 目录在 win32 能否制造 rename 失败未实测（本机仅 Linux 实证；Windows CI 矩阵只跑 `test:process`，不跑 pricing.test.cjs），该用例在 Windows 本地 `npm test` 可能假失败。
- catalog 隔离失败后 sync 无拒写守卫（server/pricing.ts:832-842 直写 writeAtomicFile）：只读目录实测 sync 也 EACCES 不覆盖；能「rename 失败但 write 成功」的故障组合未构造，且 catalog 可重拉，代价≈0。
