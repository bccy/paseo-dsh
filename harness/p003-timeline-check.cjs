/** Real TimelineBuilder -> ProviderEventSchema -> client renderer data, plus
 * bridge history projection. Run: node harness/p003-timeline-check.cjs */
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const build = require('./plugin-build.cjs').resolvePluginBuild(undefined, '.dbg-p003-timeline');
const { TimelineBuilder } = require(join(build, 'server/timeline.js'));
const req = createRequire(join(build, 'index.server.js'));
const { ProviderEventSchema } = req('@getpaseo/plugin/server/provider');
const { toolCallData } = require(join(build, 'client/tool-call-data.js'));
const warnings = [];
const builder = () => new TimelineBuilder({ warn: s => warnings.push(s) });
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS', name); }
const ev = (type, data) => ({ type, data });
const workflow = [
  ev('tool-workflow/run-start', { runId: 'run', name: 'Review' }),
  ev('tool-workflow/agent-start', { runId: 'run', seq: 0, label: 'Alpha', phase: 'Inspect', childId: 'child-A' }),
  ev('tool-workflow/agent-start', { runId: 'run', seq: 1, label: 'Beta', phase: 'Verify', childId: 'child-B' }),
  ev('tool-workflow/agent-end', { runId: 'run', seq: 0, outcome: 'completed' }),
  ev('tool-workflow/agent-end', { runId: 'run', seq: 1, outcome: 'failed' }),
  ev('tool-workflow/run-end', { runId: 'run', stopReason: 'error' }),
];
function goal(operation, phase, objective='target', extras={}) {
  return ev('goal/change', { version:1, operation, goal:{id:'g',revision:1,objective,phase,maxGoalRounds:3,...extras},roundsStarted:0,createdAt:1,updatedAt:2 });
}
test('workflow updates one identity, all members and phases survive protocol and rendering', () => {
  const b = builder(); const rows = workflow.flatMap(e => b.consume(e));
  assert.equal(rows.length, 6); assert.equal(new Set(rows.map(r=>r.callId)).size,1);
  assert.equal(new Set(rows.map(r=>r.id)).size,1);
  assert.equal(rows[0].status,'running'); assert.equal(rows.at(-1).status,'failed');
  const item = ProviderEventSchema.parse({type:'timeline.item',sessionId:'a',item:rows.at(-1)}).item;
  const view = toolCallData(item);
  assert.match(view.body,/Inspect/); assert.match(view.body,/Verify/); assert.match(view.body,/child-B/);
  assert.match(item.detail.label,/2\/2/); assert.ok(item.error);
});
test('duplicate starts cannot erase progress or reset a terminal', () => {
  const b=builder(); const final=workflow.flatMap(e=>b.consume(e)).at(-1);
  assert.deepEqual(b.consume(workflow[0])[0],final);
  assert.deepEqual(b.consume(workflow[1])[0],final);
});
test('completed/cancelled run reasons and dead replay have truthful terminal states',()=>{
  for(const [reason,status] of [['completed','completed'],['cancelled','canceled']]) {
    const b=builder();b.consume(workflow[0]);assert.equal(b.consume(ev('tool-workflow/run-end',{runId:'run',stopReason:reason}))[0].status,status);
  }
  for(const end of [b=>b.settleRunningTools()]) {
    const b=builder();b.consume(workflow[0]);b.consume(workflow[1]);assert.equal(end(b)[0].status,'canceled');assert.equal(end(b).length,0);
    assert.equal(b.consume(workflow[0])[0].status,'canceled');
  }
});
test('background workflow remains running across parent turns, then uses its own terminal',()=>{
  const b=builder();b.consume(workflow[0]);b.consume(workflow[1]);
  b.consume(ev('tool/call',{callId:'ordinary',name:'read',input:{path:'fixture'}}));
  for(const kind of ['completed','aborted']) {
    const ended=b.consume(ev('turn/end',{reason:{kind}}));
    assert.ok(ended.every(row=>row.callId!=='workflow:run'));
    if(kind==='completed')assert.ok(ended.some(row=>row.callId==='ordinary'&&row.status==='canceled'));
    assert.equal(b.consume(workflow[0])[0].status,'running');
  }
  b.consume(workflow[3]);
  assert.equal(b.consume(ev('tool-workflow/run-end',{runId:'run',stopReason:'completed'}))[0].status,'completed');
});
test('goal full snapshots replace stale objective/reason; clear and new create share one row',()=>{
  const b=builder();const rows=[goal('create','active'),goal('block','blocked','old',{blockedReason:{code:'test',message:'old reason'}}),goal('edit','active','new'),goal('complete','complete','new'),ev('goal/change',{version:1,operation:'clear',cleared:{id:'g',revision:2},clearedAt:3}),goal('create','active','next')].flatMap(e=>b.consume(e));
  assert.equal(new Set(rows.map(r=>r.callId)).size,1);assert.match(rows[1].detail.text,/old reason/);
  assert.doesNotMatch(rows[2].detail.text,/old/);assert.doesNotMatch(rows[4].detail.label,/new/);assert.match(rows[5].detail.text,/next/);
  for (const item of rows) ProviderEventSchema.parse({type:'timeline.item',sessionId:'a',item});
  assert.equal(b.consume(ev('turn/end',{reason:{kind:'completed'}})).length,0);
  assert.equal(b.settleRunningTools().length,0);
});
test('malformed known events are visible errors rather than silent omissions',()=>{
  for(const e of [ev('goal/change',{}),ev('goal/change',{version:2}),goal('block','blocked'),ev('tool-workflow/run-start',{runId:'x'}),ev('tool-workflow/agent-end',{runId:'missing',seq:0,outcome:'completed'})]) {
    const rows=builder().consume(e); assert.equal(rows[0].type,'error');assert.match(rows[0].message,new RegExp(e.type));
  }
  assert.ok(warnings.length>=5);
});
test('independent session builders never inherit each other\'s workflow or goal state',()=>{
  const a=builder(),b=builder();a.consume(workflow[0]);a.consume(goal('create','active','ONLY-A'));
  assert.equal(b.consume(workflow[1])[0].type,'error');
  assert.doesNotMatch(b.consume(ev('goal/change',{version:1,operation:'clear',cleared:{id:'g'}}))[0].detail.text,/ONLY-A/);
});
(async()=>{
  const {historyEvents}=await import('../dsh-bridge/lib/image-host-path.js');
  test('real bridge history preserves workflow/goal and replay builds the identical snapshots',()=>{
    const events=[...workflow,goal('create','active'),goal('complete','complete')].map((e,seq)=>({...e,seq,time:seq+1}));
    const replay=historyEvents({get:()=>undefined},events);
    assert.deepEqual(replay,events);
    const a=builder(),b=builder();assert.deepEqual(events.flatMap(e=>a.consume(e)),replay.flatMap(e=>b.consume(e)));
  });
  console.log(`${passed} P003 timeline checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
