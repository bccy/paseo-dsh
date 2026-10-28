# Issue 草稿：plugin provider 子代理第二次运行时，Subagents 卡片不恢复 running

> 目标仓库：https://github.com/getpaseo/paseo
> 状态：**草稿，等你审阅后才提交**（我不会自己发）
> 证据等级：源码确认 + 真机实测

---

## 标题（备选）

1. `bug: a plugin-provider subagent card never returns to running on its second turn`
2. `bug: re-dispatching a plugin-provider subagent leaves its Subagents card on the previous terminal status`

推荐 1。

---

## 正文

### What's broken

With a **plugin provider**, a subagent card in the Subagents panel shows `running` the first time
the child runs, and never again. Send a second instruction to the same durable child (the plugin
reuses the child's provider session, so this is a *new turn* on the *same* child), and the card
stays on the previous terminal status (`completed` / `canceled` / `failed`) for the whole second
run. The child is working; Paseo says it is not.

This is not the parent-session symptom in #3160 / #7095, and not the terminal-status overwrite in
#7390. It is specifically **`session.turn` with `state: "started"` being dropped for child
sessions**, so nothing ever moves the card back to `running`.

### Where it comes from

`packages/server/src/server/agent/plugin-provider.ts`, `PluginAgentSession.acceptChildEvent`
(in the published 0.14.0-beta.1 dist: `dist/server/server/agent/plugin-provider.js:1262`):

```ts
if (event.type === "session.turn" && event.state !== "started") {
    this.publish({
        type: "provider_subagent",
        provider: this.provider,
        event: { type: "upsert", id: childId, status: event.state },
    });
    return;
}
```

The `!== "started"` guard excludes `started`, and the method has **no `else`**, so a `started`
event is discarded silently. The only other place a child's status is ever set to `running` is
`attachChild()`:

```ts
this.publish({
    type: "provider_subagent",
    provider: this.provider,
    event: { type: "upsert", id: childId, ..., status: "running", ... },
});
```

and `attachChild()` runs only on `session.opened`. A plugin that keeps one child session alive
across turns (which is the whole point of a durable child) never re-opens it, so `running` is
written **exactly once, ever**. Every later turn is invisible to the card.

Note this is not the plugin failing to send anything: the provider contract has `session.turn`
with `state: "started"` (the same event the *root* session uses to become running), and the plugin
in question emits it on every child turn with the child's own session id.

### Why it looks like "works once, then never"

1. First turn: `session.opened` → `attachChild()` → `status: "running"`. Card is green. ✅
2. Turn ends: `session.turn` `completed` → `status: "completed"`. Card is done. ✅
3. Second instruction on the same child: the plugin emits `session.turn` `started`.
   `acceptChildEvent` drops it. Card stays `completed` for the entire run. ❌
4. Turn ends: `completed` again. Nothing visible changed.

### Suggested fix

Two lines in that branch — stop excluding `started`, and map it to `running`:

```ts
if (event.type === "session.turn") {
    this.publish({
        type: "provider_subagent",
        provider: this.provider,
        event: {
            type: "upsert",
            id: childId,
            status: event.state === "started" ? "running" : event.state,
        },
    });
    return;
}
```

`status: "started"` must **not** be passed through verbatim: the subagent status enum is
`running | completed | failed | canceled`, so `started` would be rejected by the client schema.

Why this is safe:

- `ProviderSubagentStore.apply` treats `status` as sticky (`event.status ?? previous?.status ?? "running"`),
  so a single upsert restores the card without re-sending `title` / `description` / `toolCallId` / `cwd`.
- Idempotent: repeated `running` upserts are harmless, and the app only rebuilds the card's
  timeline when the status actually changes.
- It also makes `runtimeHasNoPendingWork()` correct during a child's second run — today
  `!providerSubagents.list(agent.id).some(child => child.status === "running")` is satisfied while
  a re-dispatched child is still working.

### Verification I ran (0.14.0-beta.1, Linux, Node 22)

- Reproduced on a real daemon + real plugin provider: the card returns to `running` on turn 1 and
  stays `completed` on turn 2, with the child demonstrably working (60 s of tool calls).
- Applied the two-line change to the installed `dist` and restarted the daemon: turn 1 `running`,
  turn 2 **`running`** again, turn 2 terminal status updates correctly afterwards.
- `session.turn` `canceled` / `failed` still map through unchanged (they take the same `event.state`
  path), so #7390's fix — whichever shape it lands in — is unaffected.

### Environment

- Paseo CLI + daemon `0.14.0-beta.1`, Linux (systemd user unit)
- Provider: a third-party plugin provider (the one in question is `paseo-dsh`); the drop is in
  Paseo's own code, so any plugin provider that keeps child sessions across turns hits it.

---

## 提交前需要你确认的 3 件事

1. **要不要点名 `paseo-dsh`？** 草稿里写了。若你不想关联自己的仓库，我改成「a third-party
   plugin provider」匿名表述。
2. **要不要附真机截图/日志？** 截图能显著提高受理率，但要脱敏（会话内容、路径）。
3. **提 issue 还是直接提 PR？** 上游 #7390 的修法正在 #7408 里改同一段代码（未合），直接提
   PR 可能冲突；先提 issue 更稳。
