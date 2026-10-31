/** Real DshProcess + DshSession; only the stdio peer is scripted. No model,
 * daemon or live DSH_HOME. Run: node harness/p003-permission-check.cjs [build] */
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const home = mkdtempSync(join(tmpdir(), 'p003-permission-'));
const prior = { DSH_HOME: process.env.DSH_HOME, DSH_BINARY: process.env.DSH_BINARY };
process.env.DSH_HOME = home;
process.env.DSH_BINARY = join(home, 'peer.cjs');
writeFileSync(process.env.DSH_BINARY, `#!/usr/bin/env node
const {createInterface}=require('node:readline');
const pending=new Map(); let serial=0;
const send=f=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...f})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
  const f=JSON.parse(line);
  if(!f.method) {
    const command=pending.get(f.id); if(!command)return;
    pending.delete(f.id);
    send({id:command,result:{kind:f.error?'error':'success',text:JSON.stringify(f.error??f.result)}});
    return;
  }
  if(f.method==='paseo/command/run') {
    const {sessionId,name}=f.params;
    const id='reverse-'+(++serial), requestId='request-'+serial;
    pending.set(id,f.id);
    send({id,method:'paseo/permission',params:{sessionId:name==='foreign'?'foreign':sessionId,
      requestId,toolName:name==='malformed'?'':'harmless',callId:'same-call-id',reason:'Harmless fixture'}});
    if(name==='timeout'||name==='cancel')setTimeout(()=>send({method:'paseo/permission-cancelled',
      params:{sessionId,requestId,timedOut:name==='timeout'}}),40);
    return;
  }
  send({id:f.id,result:f.method==='paseo/plan/set'?{available:true,active:f.params.active,pending:false}:{}});
  if(f.method==='shutdown')process.exit(0);
});
`, { mode: 0o700 });
const build = require('./plugin-build.cjs').resolvePluginBuild(process.argv[2], '.dbg-p003-permission');
const { DshProcess } = require(join(build, 'server/dsh-process.js'));
const { DshSession } = require(join(build, 'server/session.js'));
const { createRequire } = require('node:module');
const { ProviderEventSchema } = createRequire(join(build, 'index.server.js'))('@getpaseo/plugin/server/provider');
const events = [], sessions = [];
const route = { provider: 'fixture', model: 'fixture' };
const transport = new DshProcess({ cwd: home, route, sessionId: 'pool',
  onEvent() {}, onStatus() {}, onQuestion() { throw new Error('unexpected question'); },
  onLog() {}, onExit() {}, onProtocolError(e) { throw new Error(e); } });
async function until(fn) {
  for(let i=0;i<400;i++) { const v=fn();if(v)return v;await delay(10); }
  throw new Error('permission test timed out');
}
async function open(id,permission=true) {
  const session = new DshSession({ sessionId:id,cwd:home,env:{},route,mode:'build',models:[],
    thinkingOptions:[],subsession:false,permission,emit:e=>{ProviderEventSchema.parse(e);events.push(e);},log(){},
    acquireProcess:async()=>({process:transport,reused:true}),releaseProcess(){} });
  sessions.push(session);await session.open();return session;
}
function countResolved(id) { return events.filter(e=>e.type==='session.permission_resolved'&&e.permissionId===id).length; }
async function begin(session,name='ask') {
  const start=events.length;
  const result=transport.runCommand(session.id,name,'');
  const card=await until(()=>events.slice(start).find(e=>e.type==='session.permission'&&e.sessionId===session.id));
  return {result,card:card.request,start};
}
let checks=0;
const pass=message=>{checks++;console.log('PASS',message);};
(async()=>{
  try {
    const a=await open('a'),b=await open('b');
    const [one,two]=await Promise.all([begin(a),begin(b)]);
    assert.notEqual(one.card.id,two.card.id);
    assert.equal(one.card.kind,'tool');assert.deepEqual(one.card.actions.map(x=>x.behavior),['deny','allow']);
    a.resolvePermission(two.card.id,{behavior:'allow'});
    assert.equal(countResolved(two.card.id),0);
    a.resolvePermission(one.card.id,{behavior:'deny'});b.resolvePermission(two.card.id,{behavior:'allow'});
    assert.deepEqual(JSON.parse((await one.result).text),{outcome:'rejected'});
    assert.deepEqual(JSON.parse((await two.result).text),{outcome:'allowed-once'});
    assert.equal(countResolved(one.card.id),1);assert.equal(countResolved(two.card.id),1);
    pass('simultaneous cards with identical callId stay session-scoped and return to their own requests');
    for(const name of ['timeout','cancel']) {
      const {result,card,start}=await begin(b,name);
      const response=await result;
      assert.equal(response.kind,'error');assert.match(response.text,name==='timeout'?/timed out/:/cancelled/);
      assert.equal(countResolved(card.id),1);
      assert.equal(events.slice(start).filter(e=>e.type==='session.notice').length,name==='timeout'?1:0);
      b.resolvePermission(card.id,{behavior:'allow'});assert.equal(countResolved(card.id),1);
      pass(name+' withdraws exactly one card, fails the reverse RPC, and ignores late approval');
    }
    const disabled=await open('disabled',false);
    for(const [session,name,reason] of [[disabled,'ask',/negotiated permission/],[b,'foreign',/unowned/],[b,'malformed',/invalid/]]) {
      const start=events.length,result=await transport.runCommand(session.id,name,'');
      assert.equal(result.kind,'error');assert.match(result.text,reason);
      assert.equal(events.slice(start).filter(e=>e.type==='session.permission').length,0);
    }
    pass('unnegotiated, foreign and malformed requests fail without an undisplayable card');
    const closing=await begin(a);await a.close();
    assert.equal((await closing.result).kind,'error');assert.equal(countResolved(closing.card.id),1);
    const survivor=await begin(b);b.resolvePermission(survivor.card.id,{behavior:'allow'});
    assert.equal((await survivor.result).kind,'success');
    pass('closing one session cancels its pending approval and leaves its sibling usable');
    const dying=await begin(b);transport.kill();
    await dying.result.catch(()=>{});
    await until(()=>countResolved(dying.card.id)===1);
    pass('process exit releases the pending card');
    console.log(checks+' P003 permission checks passed');
  } finally {
    for(const session of sessions)await session.close();
    transport.kill();await transport.waitForExit(2000);
    for(const [key,value] of Object.entries(prior)) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
    rmSync(home,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
