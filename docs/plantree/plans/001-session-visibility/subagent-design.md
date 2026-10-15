# 子会话映射设计

模式：`execute-ready`。数据来源与协议已核对 DSH `0.2.0-rc.2`、Paseo `0.11.2`。

## 事实与根因
- 当前 bridge 的 `session.event` 和 `session.status` 已带原生会话 ID，插件仍按“一进程只有一个会话”处理；状态回调丢失 ID。
- `subagent` 工具卡不是 Paseo 子会话，必须宣布 `session.subsession` 并发出带 `parentSessionId` 的 `session.opened`。
- DSH 父日志 `subagent/catalog` 与子日志 `subagent/descriptor` 提供持久关系；fork 继承的目录事实需排除。
- `subagent/end` 描述一次运行／Activation 结束，不意味着可续接子会话永久关闭。

## 决策
- 使用 Paseo 原生 provider-owned 子会话（`restoration: parent`），首先实现子代理树、状态和独立时间线查看；不把子代理另行创建成顶层 Paseo agent。
- 根进程保持唯一所有者。子视图只路由本进程或持久历史中的原生子会话，不为“查看”启动子代理。
- 所有 timeline、status、usage、permission 按 session ID 归属；未知 ID 暂存或报告诊断，禁止退化为父会话事件。
- 父先注册，子先于注册到达的事件有界暂存／补读；恢复先重建关系再回放，避免遗漏最初输出和嵌套后代。
- 子 provider ID 在同一根视图下稳定且不冲突；原生 DSH ID 与 Paseo ID 显式映射。
- `toolCallId` 只在权威数据可确认时设置。缺失时允许仅在子代理列表显示，不能凭模糊文本误连工具卡。
- 默认子会话为只读查看面；Paseo 未支持或 bridge 未实现的反向 prompt/configure 操作明确拒绝。已有审批若经过本桥，必须保留会话和请求身份，不转给无关父会话。
- 占用修复、现有根会话恢复、Provider 名称和模型配置必须保留。

## 已核实的宿主边界
- Paseo 0.11.2 在接收子 `session.opened` 时，校验其直接父会话已协商 `session.subsession`；所以能拥有孙级的只读子视图也需要该关系能力，不能把全部子能力置空后宣称支持嵌套。
- 当前宿主对子事件消费 `timeline.item` 和回合终态，但忽略重新开始的 `session.turn started`、子 `session.usage` 与子 `session.permission`。因此单靠插件不能承诺子代理独立审批或再次运行时原生列表实时恢复 running。
- 首次可见、独立历史和准确终态仍可通过现有协议实现；对宿主未消费的事件需保留真实身份并明确验证边界，不能伪造新子 ID 绕过。
- 父的 `history: skip` 仅跳过父时间线回放，不跳过子目录与子视图恢复。子视图以自身持久 `turn/end` 恢复终态，不把“刚注册”默认 running 留给已结束的孩子。
- DSH `openAt: never` 关闭全文搜索，不关闭 `sessionQuery.observeSession` 精确读取；子树枚举应使用该读取能力，并让真正错误可见。

## 修改归属
- 同一执行者负责 `dsh-bridge/`、`paseo-plugin/server/` 相关代码和内嵌资源、专项 harness。
- 历史性能调研继续只读；如与此处写入文件重叠，串行修复或由同一代码负责人整合。
- 主会话维护计划、决定部署时机并做真实 Paseo 验收。

## 验证与回滚
- 隔离回归覆盖多子会话并发、事件先后、前后台／fork／continuable、父子用量隔离、恢复去重、失败／取消终态。
- 执行者可编写真实子代理测试入口但不得执行递归派发；由主会话审核后驱动隔离真实模型验收。
- 部署前备份正式 profile 桥副本，重载只作用于目标插件；失败保留错误证据并恢复该副本与修改前源码快照。

依据：Paseo 插件 provider 契约与本机 `plugin-provider.js`；DSH `dsh-subagent` 类型、目录／描述符投影及生命周期实现。
