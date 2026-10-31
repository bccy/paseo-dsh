const audit = require('./support.cjs');
const { repo: auditRepo, scratch: auditScratch, build: auditBuild, dsh: auditDsh, path: auditPath, url: auditUrl } = audit;
const assert=require('node:assert/strict');
const {DshSession}=require(auditPath.join(auditBuild,"server/session.js"));
let rejectPlan=false;const actual={provider:'fixture',model:'a',reasoningEffort:null,plan:false};
const transport={async attachSession(){},async setPlan(id,active){if(rejectPlan)throw Error('plan service unavailable');actual.plan=active;return {active,pending:false}},async setConfig(id,changes){Object.assign(actual,changes);return {...actual}},async usage(){return {available:false}},async closeSession(){}};
const s=new DshSession({sessionId:'config-proof',cwd:process.cwd(),env:{},route:{provider:'fixture',model:'a'},mode:'build',models:[{id:'fixture/a',thinkingOptions:[{id:'high',label:'High'}]},{id:'fixture/b'}],thinkingOptions:[],subsession:false,emit(){},log(){},acquireProcess:async()=>({process:transport,reused:false}),releaseProcess(){}});
(async()=>{
 await s.open();assert.equal(s.configState().mode,'build');assert.equal(actual.plan,false);
 await s.configure({mode:'plan'});assert.equal(s.configState().mode,'plan');assert.equal(actual.plan,true);
 await s.configure({mode:'build'});assert.equal(s.configState().mode,'build');assert.equal(actual.plan,false);
 console.log('CONTROL: normal mode changes agree with successful backend receipts');
 await s.configure({thinkingOption:'high'});assert.equal(s.configState().thinkingOption,actual.reasoningEffort);console.log('CONTROL: supported effort change agrees');
 await s.configure({model:'fixture/b'});
 assert.equal(actual.model,'b');assert.equal(actual.reasoningEffort,null);assert.equal(s.configState().model,'fixture/b');assert.equal(s.configState().thinkingOption,'high');
 console.log('STALE_EFFORT',JSON.stringify({backend:actual.reasoningEffort,advertised:s.configState().thinkingOption,options:s.configState().thinkingOptions}));
 rejectPlan=true;await assert.rejects(s.configure({mode:'plan'}));assert.equal(actual.plan,false);assert.equal(s.configState().mode,'plan');
 console.log('REJECTED_PLAN',JSON.stringify({backend:actual.plan,advertised:s.configState().mode}));await s.close();
})().catch(e=>{console.error(e);process.exitCode=1});
