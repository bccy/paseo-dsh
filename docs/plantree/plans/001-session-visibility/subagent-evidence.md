# 子会话验收证据

日期：2026-10-15。版本：Paseo 0.11.2、DSH 0.2.0-rc.2。

## 隔离真实运行
主会话审核后运行测试员交付的真实 provider 驱动程序。每个场景使用独立临时 DSH_HOME 和工作目录，官方 Flash 路由，凭据仅进程内注入；没有修改正式 profile。

| 场景 | 结果 | 已确认内容 |
| --- | --- | --- |
| 前台 `subagent(run_in_background:false)` | 21 passed / 0 failed / 1 skipped | 一个直接子会话，独立消息/工具/终态，父子消息ID不混用，skip/replay重开恢复同一子ID和历史 |
| `subagent_fork(run_in_background:false)` | 21 passed / 0 failed / 1 skipped | fork工具路径、独立子消息/工具，重开后独立历史与终态 |
| 后台 `subagent(run_in_background:true)` | 21 passed / 0 failed / 1 skipped | 后台工具路径、独立子消息/工具，重开后子历史与终态 |

每项 skipped 是 provider 事件未暴露原始 descriptor 的 mode 自动核验；未把未验证字段写成通过。三场景都通过父会话关系能力门控。

上述运行验证了真实 DSH 与编译后的 provider 事件链，尚不是正式 Paseo daemon 接纳和 iOS 真机验证。只读子视图由根生命周期持有，不把缺少独立 close 通知等同于残留 DSH 进程。

## 确定性回归和独立审查
- 子会话假桥回归：37/37，覆盖协商、父边门控、乱序父/孙/曾孙、状态归属、失败/取消、fork继承边界和恢复。
- 上下文回归：8/8。
- 最新类型检查与 CJS 验收编译 exit 0。
- 原 reviewer 已确认 P1 与乱序 P2 闭合，可进入正式部署验证。
- 最新完整 `plugin-check.cjs` 在独立 profile 下22/22通过，实际图像问答、用量、根会话恢复均未回归。
- 主会话核对隔离验收目录无残留运行进程。

## 正式环境基线
- 用户已有“你调用个子代理我看看我能不能看到”会话，在修复部署前通过真实 daemon 查询子列表：0，error=null。
- 已重载正式插件并重新打开同一空闲测试父会话，未发送新任务：子列表由0变为1，error=null。
- 子标题 `Verify subagent visibility`、status `completed`，独立历史4行，类型包含 user_message、reasoning、tool_call、assistant_message；父子关系为直接子级，Paseo原生查询已接纳。
- 对同一父再次reload后，子列表仍为1个completed，无重复；Paseo root-scoped运行ID变化但DSH原生子ID保持一致。
- 390×844浏览器交互验收通过：点击 `subagents-track-header`（1个subagent）→子行→`provider-subagent-panel`；独立子滚动容器存在，内有1条assistant消息及工具条目。
- 截图 `panel-child-subview.png` 与报告 `ui-final.md` 由测试员保存在临时验收目录，主会话已读取核验。此项是移动端尺寸 Web，不等同于 iOS 原生真机完整验收。
- 本轮4个执行者均已接收产物、检查预算并归档；正式服务正常，Paseo daemon 未重启。

## 落地状态
- 修改已在本机目录源插件加载，工作分支 `fix/subagents-history`。
- 本轮源码与计划文档尚未提交／推送；此前 PR #1 不包含本轮子会话改动。

## 已知宿主限制
- Paseo 0.11.2 的 provider子事件转译忽略子 `session.turn started`、子 `session.usage` 与子 `session.permission`；因此可续接子代理再次运行时，原生状态卡可能保持旧终态，独立审批与独立上下文计不在当前宿主原生子视图展示。
- 本次插件按真实子身份发送数据并保留DSH自身子代理权限语义；没有通过新造子ID、冒充父会话或改全局包来掩盖宿主限制。
