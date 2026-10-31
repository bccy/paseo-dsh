const audit = require('./support.cjs');
const { repo: auditRepo, scratch: auditScratch, build: auditBuild, dsh: auditDsh, path: auditPath, url: auditUrl } = audit;
const assert=require('node:assert/strict');
const {DshSession,DshChildSession}=require(auditPath.join(auditBuild,"server/session.js"));
const events=[];let handlers;
const fake={async attachSession(id,h){handlers=h},async setPlan(){return {active:false}},async usage(){return {available:false}},async prompt(id,text){return {messageId:'m-'+text}},async closeSession(){}};
const s=new DshSession({sessionId:'root',cwd:process.cwd(),env:{},route:{provider:'fixture',model:'a'},mode:'build',models:[],thinkingOptions:[],subsession:true,emit:e=>events.push(e),log(){},acquireProcess:async()=>({process:fake,reused:false}),releaseProcess(){}});
const emit=(type,data,time)=>handlers.onEvent({sessionId:'root',event:{type,data,...(time===undefined?{}:{time})}});
(async()=>{
 await s.open();s.markRootReady();
 for(let turn=1;turn<=2;turn++){
  await s.prompt({clientMessageId:'p'+turn,delivery:'auto',input:{type:'message',content:[{type:'text',text:'t'+turn}]}});
  handlers.onStatus('running','root');
  emit('tool/call',{callId:'tool-'+turn,name:'bash',arguments:{command:'true'}});
  emit('tool/result',{toolCallId:'tool-'+turn,message:{content:[{type:'text',text:'ok'}]}});
  emit('assistant/message',{turn,step:1,message:{content:[{type:'text',text:'ok'}]},stream:[{type:'chunk',time:1000,chunk:{type:'text-delta',text:'ok'}}],usage:{outputTokens:20}},2000);
  emit('turn/end',{turn,reason:{kind:'completed'}});handlers.onStatus('idle','root');
 }
 const stats=events.filter(e=>e.type==='timeline.item'&&e.item.kind==='dsh-stream-stats');
 console.log('SECOND_TURN_TOOL_COUNT',stats.at(-1).item.data.toolCalls);assert.equal(stats.at(-1).item.data.toolCalls,2);
 handlers.onChildOpened({sessionId:'without-title',parentSessionId:'root'});
 assert(!events.some(e=>e.type==='session.opened'&&e.sessionId==='root:sub:without-title'));
 handlers.onChildOpened({sessionId:'has-title',parentSessionId:'root',label:'Known'});
 const unknown=events.find(e=>e.type==='session.opened'&&e.sessionId==='root:sub:without-title');
 console.log('UNRELATED_CHILD_RELEASES_UNTITLED',JSON.stringify(unknown));assert(unknown&&unknown.title===undefined);
 handlers.onEvent({sessionId:'has-title',event:{type:'turn/start',data:{turn:1}}});handlers.onStatus('running','has-title');
 handlers.onEvent({sessionId:'has-title',event:{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}});
 handlers.onExit(1,null);
 const child=events.filter(e=>e.sessionId==='root:sub:has-title'&&['session.turn','session.runtime_failed'].includes(e.type));
 console.log('COMPLETED_CHILD_AFTER_PROCESS_EXIT',JSON.stringify(child));
 assert(child.some(e=>e.state==='completed'));assert(child.at(-1).type==='session.runtime_failed');
 console.log('ALL_LIFECYCLE_CANDIDATES_REPRODUCED');await s.close();
})().catch(e=>{console.error(e);process.exitCode=1});
