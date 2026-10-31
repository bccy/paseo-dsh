/** Real DSH service, harmless model-invoked tool. Pins the audit pair, rejects
 * through the bridge, then verifies that the never policy bypasses answerers. */
import assert from 'node:assert/strict';
import { liveProfile, bridge, until } from './p003-live-support.mjs';
const profile = liveProfile();
const run = bridge(profile);
try {
  const sessionId = `p003-preflight-${Date.now()}`;
  await run.rpc('initialize', { sessionId, cwd: profile.home });
  await run.rpc('session/prompt', { sessionId, contentBlocks: [{type:'text', text:'Call p003_approval_probe exactly once. It only tests approval and has no side effects. Then say DONE. Do not call any other tool.'}] });
  const asked = await until(() => run.frames.find(f => f.params?.event?.type === 'approval/asked'), 'approval/asked');
  // Refuse if an answerer is already implemented. This is a test decision for
  // the explicitly harmless tool, never a general unattended allow policy.
  const timer = setInterval(() => {
    for (const f of run.frames) if (f.method === 'paseo/permission' && !f.answered) {
      f.answered = true; run.send({jsonrpc:'2.0', id:f.id, result:{outcome:'rejected'}});
    }
  }, 25);
  try {
    const decided = await until(() => run.frames.find(f => f.params?.event?.type === 'approval/decided'), 'approval/decided');
    assert.equal(asked.params.event.data.toolName, 'p003_approval_probe');
    assert.equal(decided.params.event.data.id, asked.params.event.data.id);
    assert.equal(decided.params.event.data.outcome,'rejected');
    console.log(`PASS actual DSH approval/asked -> approval/decided (${decided.params.event.data.outcome}); no dangerous operation`);
    await until(() => run.frames.find(f => f.params?.event?.type === 'turn/end'), 'first turn end');
    await run.rpc('paseo/permission/set', { sessionId, preset: 'danger-full-access' });
    const start = run.frames.length;
    await run.rpc('session/prompt', { sessionId, contentBlocks: [{type:'text',text:'Call p003_approval_probe exactly once again to verify the never policy returns rejected without asking. This is a harmless test, no other tools.'}] });
    const denied = await until(() => run.frames.slice(start).find(f => f.params?.event?.type === 'approval/decided'), 'never decision');
    assert.equal(denied.params.event.data.outcome, 'rejected');
    assert.equal(run.frames.slice(start).filter(f => f.method === 'paseo/permission').length, 0);
    const minimal = await run.rpc('paseo/projections', { sessionId });
    assert.ok(Object.hasOwn(minimal.values, 'tokenUsage'));
    for (const key of ['sessionStats','agentPreset']) {
      assert.ok(!Object.hasOwn(minimal.values, key));
      await assert.rejects(run.rpc('paseo/projections', { sessionId, keys:[key] }), /unknown or unavailable/);
    }
    console.log('PASS never policy rejects before answerers; base profile reports unavailable projection keys explicitly');
  } finally { clearInterval(timer); }
} finally { await run.close(); profile.cleanup(); }
