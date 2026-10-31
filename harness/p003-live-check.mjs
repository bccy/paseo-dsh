/** Real plugin + real DSH + configured model. Disposable profile/session state.
 * Run after bridge-assets-check: PATH=<dsh-bin>:$PATH node harness/p003-live-check.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { liveProfile, bridge, until } from './p003-live-support.mjs';
const profile = liveProfile({ projections: true });
const require = createRequire(join(profile.build,'index.server.js'));
const {ProviderEventSchema}=require('@getpaseo/plugin/server/provider');
let registration, conn;
const events=[], schemaErrors=[];
const cleanup=require(join(profile.build,'index.server.js')).default({handle(){},registerSettings(){},on(){},registerProvider(r){registration=r;}});
let serial=0;
async function send(input) {
  const start=events.length;
  await conn.send({...input,requestId:`p003-${++serial}`});
  const fail=events.slice(start).find(e=>e.type==='request.failed');
  if(fail) throw new Error(JSON.stringify(fail));
  return start;
}
async function open(sessionId,systemPrompt,persistence) {
  const start=await send({type:'session.open',sessionId,config:{cwd:profile.home,mode:'build',systemPrompt},...(persistence?{persistence,history:'replay'}:{})});
  await until(()=>events.slice(start).find(e=>e.type==='session.ready'&&e.sessionId===sessionId),'session ready');
  return start;
}
async function prompt(sessionId,text,onPermission) {
  const start=events.length;
  const answered=new Set();
  let answerTask=Promise.resolve();
  const timer=setInterval(()=>{
    for (const event of events.slice(start)) if(event.type==='session.permission'&&event.sessionId===sessionId&&!answered.has(event.request.id)) {
      answered.add(event.request.id);
      answerTask=answerTask.then(()=>onPermission?.(event));
    }
  },25);
  try {
    await send({type:'session.prompt',sessionId,prompt:{input:{type:'message',content:[{type:'text',text}]},clientMessageId:`prompt-${++serial}`,delivery:'auto'}});
    await until(()=>events.slice(start).find(e=>e.sessionId===sessionId&&e.type==='session.turn'&&e.state!=='started'),'turn terminal',180000);
    await answerTask;
    const rows=events.slice(start).filter(e=>e.sessionId===sessionId);
    const failed=rows.find(e=>e.type==='session.prompt_result'&&e.result.type==='failed'||e.type==='session.runtime_failed'||e.type==='session.turn'&&e.state==='failed');
    assert.equal(failed,undefined,JSON.stringify(failed));
    return rows;
  } finally {clearInterval(timer);}
}
const texts=rows=>rows.filter(e=>e.type==='timeline.item'&&e.item.type==='assistant_message').map(e=>e.item.text).join('\n');
const stateRows=(rows,callId)=>rows.filter(e=>e.type==='timeline.item'&&e.item.callId===callId).map(e=>e.item);
const check=message=>console.log('PASS',message);
try {
  conn=await registration.connect({capabilities:['prompt.message','prompt.steer','session.configure','session.persistence','session.list','session.subsession','permission']});
  conn.onEvent(event=>{events.push(event);try{ProviderEventSchema.parse(event);}catch(e){schemaErrors.push(String(e));}});
  const marker=`P003_${randomUUID().replaceAll('-','')}`;
  const a='p003-live-A',b='p003-live-B';
  await open(a,`For the marker verification question, answer exactly ${marker} {{p003_literal}}. These are literal words, not template variables.`);
  await open(b);
  const question='Marker verification: return the marker and literal suffix supplied in your per-session system instructions; if none were supplied, return NONE. No tools.';
  const resultA=await prompt(a,question),resultB=await prompt(b,question);
  assert.ok(texts(resultA).includes(`${marker} {{p003_literal}}`),texts(resultA));
  assert.ok(texts(resultB).includes('NONE')&&!texts(resultB).includes(marker),texts(resultB));
  check('per-session systemPrompt reaches actual model, literal braces preserved, A/B isolated');

  for(const behavior of ['allow','deny']) {
    let card;
    const rows=await prompt(b,'Call p003_approval_probe exactly once, then report its result. It has no side effects. No other tools.',async e=>{
      card=e; assert.equal(e.request.kind,'tool'); assert.deepEqual(e.request.actions.map(a=>a.id),['reject','allow-once']);
      await send({type:'session.permission',sessionId:b,permissionId:e.request.id,response:{behavior}});
    });
    assert.ok(card,'permission card missing');
    assert.equal(rows.filter(e=>e.type==='session.permission_resolved'&&e.permissionId===card.request.id).length,1);
    assert.ok(rows.some(e=>e.type==='timeline.item'&&e.item.name==='p003_approval_probe'&&JSON.stringify(e.item).includes(behavior==='allow'?'allowed-once':'rejected')));
    check(`real tool approval ${behavior}, resolution returns to its tool`);
  }
  let canceledCard;
  const start=events.length;
  await prompt(b,'Call p003_approval_probe once, then stop. No other tools.',async e=>{
    canceledCard=e; await send({type:'session.interrupt',sessionId:b});
  });
  assert.ok(canceledCard);assert.ok(events.slice(start).some(e=>e.type==='session.permission_resolved'&&e.permissionId===canceledCard.request.id));
  assert.ok(events.slice(start).some(e=>e.type==='session.turn'&&e.state==='canceled'));
  await prompt(b,'Reply ALIVE. No tools.');check('cancel withdraws real approval and same session remains usable');

  const workflowRows=await prompt(b,'Use the workflow tool exactly once with meta.name "P003 workflow" and script: const result = await agent("Reply CHILD_OK only. Do not use tools.", {label:"P003 child", phase:"Verification"}); return result; Wait for it to finish. Then reply WORKFLOW_DONE. Do not perform other work.');
  const workflowItems=workflowRows.filter(e=>e.type==='timeline.item'&&e.item.callId?.startsWith('workflow:')).map(e=>e.item);
  assert.ok(workflowItems.length>=4,JSON.stringify(workflowItems));
  assert.equal(new Set(workflowItems.map(i=>i.callId)).size,1); assert.equal(workflowItems.at(-1).status,'completed');
  assert.match(workflowItems.at(-1).detail.text,/Verification/); assert.match(workflowItems.at(-1).detail.text,/P003 child/);
  check('real workflow produces start/member/settlement/end snapshots with phase and child');

  const backgroundStart=events.length;
  const backgroundRows=await prompt(b,'Use workflow exactly once with run_in_background true, meta.name "P003 background", and script: return await agent(\'Use bash exactly once with command "sleep 8" and description "Wait for the background check". Then reply BG_CHILD_DONE. No other tools.\', {label:"Background child", phase:"Wait"}); After the job starts, immediately reply BG_STARTED and end this turn without waiting or using more tools.');
  const backgroundItems=backgroundRows.filter(e=>e.type==='timeline.item'&&e.item.callId?.startsWith('workflow:')).map(e=>e.item);
  assert.ok(backgroundItems.length>0,'background workflow did not start');
  assert.equal(backgroundItems.at(-1).status,'running','parent turn must not cancel a background workflow');
  const backgroundId=backgroundItems[0].callId;
  await until(()=>events.slice(backgroundStart).find(e=>e.sessionId===b&&e.type==='timeline.item'&&e.item.callId===backgroundId&&e.item.status==='completed'),'background workflow completion',180000);
  assert.ok(!events.slice(backgroundStart).some(e=>e.type==='timeline.item'&&e.item.callId===backgroundId&&e.item.status==='canceled'));
  check('real background workflow stays running after parent turn and completes on its own run-end');

  const goalRows=await prompt(b,'Create a goal with objective "P003 goal check: reply GOAL_OK" and maxGoalRounds 2. Then reply GOAL_OK and use update_goal to mark this goal complete in this same turn. I explicitly request this goal and authorize completing it now. No other work.');
  const goals=stateRows(goalRows,'goal:current'); assert.ok(goals.length>=2,JSON.stringify(goals));
  assert.equal(new Set(goals.map(i=>i.id)).size,1);assert.match(goals.at(-1).detail.text,/complete|已完成/i);
  check('real create_goal/update_goal replace one complete snapshot');

  const persistence=events.find(e=>e.type==='session.opened'&&e.sessionId===b).persistence;
  await send({type:'session.close',sessionId:b});
  const reopened=await open('p003-live-reopen',undefined,persistence);
  const replay=events.slice(reopened);
  assert.ok(stateRows(replay,'goal:current').some(i=>/complete|已完成/i.test(i.detail.text)));
  assert.ok(replay.some(e=>e.type==='timeline.item'&&e.item.callId===workflowItems[0].callId&&e.item.status==='completed'));
  check('reopen replays real workflow and goal to the same final states');

  // Independent cold reader: proves projections never need another live agent.
  await send({type:'session.close',sessionId:'p003-live-reopen'});
  const raw=bridge(profile);
  try {
    const snap=await raw.rpc('paseo/projections',{sessionId:b});
    assert.equal(snap.kind,'sequenced');assert.ok(Number.isInteger(snap.asOfSeq));
    for(const key of ['tokenUsage','sessionStats','agentPreset']) assert.ok(Object.hasOwn(snap.values,key),`missing ${key}`);
    assert.ok(snap.values.sessionStats.turns >= 6);
    assert.ok(snap.values.sessionStats.steps >= snap.values.sessionStats.turns);
    assert.equal(snap.values.agentPreset, 'p003-empty');
    const selected=await raw.rpc('paseo/projections',{sessionId:b,keys:['sessionStats','agentPreset']});
    assert.deepEqual(selected,{...snap,values:{sessionStats:snap.values.sessionStats,agentPreset:'p003-empty'}});
    await assert.rejects(raw.rpc('paseo/projections',{sessionId:b,keys:['p003-missing']}),/unknown or unavailable/);
    assert.equal(await raw.rpc('paseo/projections',{sessionId:'p003-does-not-exist'}),null);
    check('cold projections include tokenUsage/sessionStats/agentPreset and reject missing key');
  } finally {await raw.close();}
  assert.deepEqual(schemaErrors,[]);
  check('all real plugin events pass ProviderEventSchema');
} finally {
  await conn?.close(); await cleanup?.(); profile.cleanup();
}
