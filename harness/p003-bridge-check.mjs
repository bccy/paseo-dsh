/** P003 bridge contracts: real bridge modules with recording transports and
 * upstream observation seams; no profile/model calls. */
import assert from 'node:assert/strict';
import { register, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { registerApprovalAnswerer } from '../dsh-bridge/lib/approval.js';
import { readSessionProjections } from '../dsh-bridge/lib/session-projections.js';
const root=process.env.DSH_INSTALL_DIR??join(homedir(),'.npm-global/lib/node_modules/@deepseek-ai/dsh');
register(`data:text/javascript,${encodeURIComponent(`import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';const r=createRequire(${JSON.stringify(join(root,'package.json'))});export async function resolve(s,c,n){if(s.startsWith('@deepseek-ai/'))return {url:pathToFileURL(r.resolve(s)).href,shortCircuit:true};return n(s,c);}`)}`);
const {PaseoHarnessServer}=await import('../dsh-bridge/lib/server.js');
let count=0;
async function test(name,fn){await fn();console.log('PASS',name);count++;}
const signal=()=>new AbortController().signal;
const ctx=services=>({get:name=>services[name]});
await test('controller projection result and AbortSignal are forwarded unchanged',async()=>{
  const value={kind:'sequenced',asOfSeq:7,values:{tokenUsage:{input:3}}},s=signal();
  const context=ctx({sessionController:{projections:async(request,received)=>{assert.deepEqual(request,{sessionId:'s'});assert.equal(received,s);return value;}}});
  assert.equal(await readSessionProjections(context,'s',s),value);
});
await test('base live projections use real snapshot semantics without creating agents or caching',async()=>{
  let n=0;const session={id:'s'};
  const context=ctx({sessions:{get:id=>id==='s'?session:undefined},sessionProjections:{snapshot:actual=>{assert.equal(actual,session);return {asOfSeq:++n,values:{tokenUsage:n}};}}});
  assert.equal((await readSessionProjections(context,'s',signal())).asOfSeq,1);
  assert.equal((await readSessionProjections(context,'s',signal())).values.tokenUsage,2);
});
await test('cold read closes observation; missing sessions return null; migration stays non-exact',async()=>{
  let disposed=0;
  const context=ctx({sessionPersistence:{stat:async()=>({header:{id:'s'}})},sessionQuery:{observeSession:async()=>({projections:{asOfSeq:9,values:{sessionStats:{turns:1}}},[Symbol.dispose](){disposed++;}})}});
  assert.equal((await readSessionProjections(context,'s',signal())).asOfSeq,9);assert.equal(disposed,1);
  assert.equal(await readSessionProjections(ctx({sessionPersistence:{stat:async()=>undefined}}),'missing',signal()),null);
  const migration=await readSessionProjections(ctx({sessionPersistence:{stat:async()=>({formatStatus:'migration-required',header:{id:'s'}})},sessionProjectionCache:{cachedSnapshot:()=>({values:{tokenUsage:8}})}}),'s',signal());
  assert.deepEqual(migration,{kind:'migration-required',values:{tokenUsage:8}});
});
await test('projection failures and cancellation are loud; observation is released even on failure',async()=>{
  await assert.rejects(readSessionProjections(ctx({}),'s',signal()),/not mounted/);
  let closed=false;
  await assert.rejects(readSessionProjections(ctx({sessionPersistence:{stat:async()=>({})},sessionQuery:{observeSession:async()=>({[Symbol.dispose](){closed=true;}})}}),'s',signal()),/unavailable/);
  assert.ok(closed);
  const c=new AbortController();c.abort();await assert.rejects(readSessionProjections(ctx({}),'s',c.signal),/abort/i);
});
await test('bridge dispatch selects keys and rejects malformed or unknown keys',async()=>{
  const server=Object.create(PaseoHarnessServer.prototype); server.ctx=ctx({sessionController:{projections:async()=>({kind:'sequenced',asOfSeq:2,values:{tokenUsage:12,agentPreset:null}})}});
  assert.deepEqual(await server.handleRequest('paseo/projections',{sessionId:'s',keys:['agentPreset']}),{kind:'sequenced',asOfSeq:2,values:{agentPreset:null}});
  await assert.rejects(server.projections({sessionId:'s',keys:['missing']}),/missing/);
  await assert.rejects(server.projections({sessionId:'s',keys:'tokenUsage'}),/keys/);
  await assert.rejects(server.projections({sessionId:''}),/sessionId/);
});
await test('prompt registration preserves text, uses supplied agent scope, replaces and disposes exactly',async()=>{
  const server=Object.create(PaseoHarnessServer.prototype);
  server.sessionSystemPrompts=new Map([['a','ONE {{literal}}'],['b','TWO']]);server.systemPromptDisposers=new Map();
  const slots=new Map();const scope=id=>ctx({systemPrompt:{getSectionOrder:()=>10200,section:section=>{assert.equal(section.interpolate,false);assert.equal(section.order,10201);slots.set(id,section.text);return ()=>slots.delete(id);}}});
  server.installSystemPrompt('a',scope('a'));server.installSystemPrompt('b',scope('b'));
  assert.equal(slots.get('a'),'ONE {{literal}}');assert.equal(slots.get('b'),'TWO');
  server.sessionSystemPrompts.set('a','NEW');server.installSystemPrompt('a',scope('a'));assert.equal(slots.get('a'),'NEW');
  server.sessionSystemPrompts.delete('a');server.installSystemPrompt('a',scope('a'));assert.ok(!slots.has('a'));assert.equal(slots.get('b'),'TWO');
  server.systemPromptDisposers.get('b')();assert.equal(slots.size,0);
});
await test('real close and failed creation release prompt sections without touching a sibling',async()=>{
  const server=new PaseoHarnessServer({...ctx({}),on:()=>()=>{}},{notify(){}});
  const slots=new Map();
  const scope=id=>ctx({systemPrompt:{getSectionOrder:()=>10200,section:section=>{
    slots.set(id,section.text);return ()=>slots.delete(id);
  }}});
  for(const id of ['a','b']) {
    server.initializedSessions.add(id);server.sessionSystemPrompts.set(id,id);
    server.installSystemPrompt(id,scope(id));
  }
  assert.deepEqual(await server.closeSession({sessionId:'a'}),{closed:true});
  assert.ok(!slots.has('a'));assert.ok(!server.sessionSystemPrompts.has('a'));
  assert.ok(!server.systemPromptDisposers.has('a'));assert.equal(slots.get('b'),'b');
  server.sessionSystemPrompts.set('failed','pending');
  server.createSession=async id=>{server.installSystemPrompt(id,scope(id));throw new Error('setup failed');};
  await assert.rejects(server.getOrCreateSession('failed'),/setup failed/);
  assert.ok(!slots.has('failed'));assert.ok(!server.systemPromptDisposers.has('failed'));
  assert.equal(slots.get('b'),'b');
  await assert.rejects(server.initialize({cwd:process.cwd(),sessionId:'x',systemPrompt:{}}),/systemPrompt must be a string/);
});
function answerer(transport,timeout=1000) {
  let callback,removed=false;
  const dispose=registerApprovalAnswerer({on:(name,fn)=>{assert.equal(name,'approval/request');callback=fn;return ()=>{removed=true;};}}, {owns:id=>id==='ours'},transport,timeout);
  return {call:callback,dispose,get removed(){return removed;}};
}
const request=()=>({agent:{session:{id:'ours'}},toolName:'harmless',callId:'call',reason:'test'});
await test('foreign approvals pass down waterfall; own exact requests return DSH outcome vocabulary',async()=>{
  let calls=0;const a=answerer({request:async(method,params,s)=>{calls++;assert.equal(method,'paseo/permission');assert.equal(params.sessionId,'ours');assert.equal(params.callId,'call');assert.equal(params.reason,'test');assert.ok(params.requestId);assert.ok(s);return {outcome:'allowed-once'};},notify(){}});
  assert.equal(await a.call({...request(),agent:{session:{id:'other'}}},()=> 'next'),'next');assert.equal(calls,0);
  assert.equal(await a.call(request(),()=>assert.fail()),'allowed-once');assert.equal(calls,1);a.dispose();assert.ok(a.removed);
});
await test('timeout is unavailable, withdrawal is correlated, malformed replies never allow',async()=>{
  let cancelled;
  const a=answerer({request:(_m,_p,s)=>new Promise((_r,reject)=>s.addEventListener('abort',()=>reject(s.reason),{once:true})),notify:(method,p)=>{cancelled={method,...p};}},15);
  // The production timeout is unref'd. This keeper represents the live process.
  const keeper=setInterval(()=>{},100);
  try {assert.equal(await a.call(request(),()=>assert.fail()),'unavailable');}finally{clearInterval(keeper);}
  assert.equal(cancelled.method,'paseo/permission-cancelled');assert.equal(cancelled.timedOut,true);assert.equal(cancelled.sessionId,'ours');
  assert.equal(await answerer({request:async()=>({outcome:'allow-always'}),notify(){}}).call(request(),()=>assert.fail()),'unavailable');
});
await test('turn cancellation reaches reverse request and returns cancelled, no implicit approval',async()=>{
  const controller=new AbortController();let notification;
  const a=answerer({request:(_m,_p,s)=>new Promise((_r,reject)=>{s.addEventListener('abort',()=>reject(s.reason),{once:true});controller.abort();}),notify:(_m,p)=>{notification=p;}});
  assert.equal(await a.call({...request(),signal:controller.signal},()=>assert.fail()),'cancelled');assert.equal(notification.timedOut,false);
});
console.log(`${count} P003 bridge checks passed`);
