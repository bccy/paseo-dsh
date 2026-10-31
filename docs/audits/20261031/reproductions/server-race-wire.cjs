const audit = require('./support.cjs');
const { repo: auditRepo, scratch: auditScratch, build: auditBuild, dsh: auditDsh, path: auditPath, url: auditUrl } = audit;
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'audit-race-wire-'));
process.env.DSH_HOME=path.join(root,'dsh');process.env.PASEO_HOME=path.join(root,'paseo');process.env.PASEO_SERVER_BROWSER_DATA=path.join(root,'browser');
process.env.DSH_BINARY=path.join(__dirname,'fake-delayed.mjs');process.env.DSH_FAKE_MODE='multi';process.env.AUDIT_COMMAND_READY=path.join(root,'commands.ready');
const {createDshProvider}=require(auditPath.join(auditBuild,"server/provider.js"));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const conn=await createDshProvider().connect({capabilities:['prompt.message','session.persistence']});const ev=[];conn.onEvent(e=>ev.push(e));
 const open=(requestId,sessionId,nativeId)=>({type:'session.open',requestId,sessionId,persistence:{version:1,data:{sessionId:nativeId}},config:{cwd:root,mode:'build'},history:'skip'});
 const prompt=(sessionId,id)=>({type:'session.prompt',sessionId,prompt:{clientMessageId:id,delivery:'auto',input:{type:'message',content:[{type:'text',text:'safe fixture'}]}}});
 try {
  await conn.send(open('normal-open','normal-session','normal-native'));await conn.send(prompt('normal-session','normal-prompt'));await sleep(80);
  assert(ev.some(e=>e.type==='session.turn'&&e.sessionId==='normal-session'&&e.state==='completed'));
  console.log('CONTROL: distinct healthy session can complete a turn');
  const first=conn.send(open('first-open','first-provider','race-native'));
  const deadline=Date.now()+3000;while(!fs.existsSync(process.env.AUDIT_COMMAND_READY)&&Date.now()<deadline)await sleep(2);
  assert(fs.existsSync(process.env.AUDIT_COMMAND_READY),'first open must have reached real commands request');
  await conn.send(open('second-open','second-provider','race-native'));await first;
  await conn.send(prompt('first-provider','after-race'));
  await conn.send(prompt('normal-session','normal-after'));await sleep(80);
  assert(ev.some(e=>e.type==='request.failed'&&e.requestId==='second-open'));
  assert(ev.some(e=>e.type==='session.ready'&&e.sessionId==='first-provider'));
  assert(ev.some(e=>e.type==='session.runtime_failed'&&e.sessionId==='first-provider'&&e.error.message.includes('unknown session')));
  assert(ev.filter(e=>e.type==='session.turn'&&e.sessionId==='normal-session'&&e.state==='completed').length===2,'sibling remains usable');
  console.log('RACE_WIRE',JSON.stringify(ev.filter(e=>/first-provider|second-provider|second-open/.test(JSON.stringify(e))).map(e=>({type:e.type,sessionId:e.sessionId,requestId:e.requestId,error:e.error})),null,2));
  console.log('CONTROL: sibling still completes a second turn');
 }finally{await conn.close();}
})().finally(()=>fs.rmSync(root,{recursive:true,force:true})).catch(e=>{console.error(e);process.exitCode=1});
