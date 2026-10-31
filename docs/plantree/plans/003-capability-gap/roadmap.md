# P003 路线图与验收门

原始顺序保留：事件消费 → 投影 → 审批 → 提示词。实施前先修正 [review.md](review.md) 中的 API 假设。

| 项目 | 交付 | 验证门 |
| --- | --- | --- |
| P0-1 workflow | 四类事件、成员/阶段、终态、同 id 更新与重放 | p003-timeline、timeline、p003-live、真实 UI |
| P0-2 goal | 全量快照、固定行、阻塞原因/清除、回合收尾隔离 | p003-timeline、p003-live、真实 UI |
| P0-3 审批 | 根 waterfall 归属、卡片与应答、超时/取消、关闭/退出、策略和协商 | p003-bridge、p003-permission、p003-approval-preflight、p003-live、真实 UI |
| P1-1 systemPrompt | 逐会话传递、agent scope、字面原文、重新注册/关闭/失败清理 | p003-bridge、p003-live、multi-session、concurrent-open |
| P1-2 投影 | 上游原形转发、缺键失败、无自有缓存、非激活式冷读取 | p003-bridge、p003-approval-preflight、p003-live |
| P2 / B 档 | 三个可提交上游的问题描述，保留七个可选扩展点清单 | [upstream-issues.md](upstream-issues.md)、[excluded.md](excluded.md) |

结果和准确运行命令以 [evidence.md](evidence.md) 为准。仅有静态源码推断不算真机通过；doctor 全绿也不能替代模型回合。

## 固定验证顺序

1. `node harness/dsh-api-contract-check.mjs`。
2. 桥有变化时先 `node paseo-plugin/scripts/generate-bridge-assets.mjs`，再 `node harness/bridge-assets-check.mjs`。
3. `cd paseo-plugin && npx tsc --noEmit`；编译当前树并运行所改区域的协议回归。
4. `harness/plugin-check.cjs`、P003 真机检查及 bridge / rewind 相关门。
5. 本地源码 doctor；隔离宿主的桌面/窄屏界面与重放确认。

C 档不实施：货币成本、思考 token 上限、MCP 指定工具预批准、files-only 撤回均没有当前可兑现的等价数据或语义。外部发布仍遵守仓库发布流程。
