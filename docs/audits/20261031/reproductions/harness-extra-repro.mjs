import audit from './support.cjs';
const { repo: auditRepo, scratch: auditScratch, build: auditBuild, dsh: auditDsh, path: auditPath, url: auditUrl } = audit;
// Extract and exercise only the original harness predicates. Never launches
// tools.mjs, route-test.mjs, a DSH profile, a daemon, or a model request.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import vm from 'node:vm';
const root=auditRepo;
const output=auditScratch;
const results=[];
const record=(id,data)=>{results.push({id,...data});console.log(id,JSON.stringify(data));};

// T01: run the exact final verdict/output loop, substituting completed RPC
// observations. Real route/model subprocess code is not evaluated.
const routeSource=await readFile(root+'/harness/route-test.mjs','utf8');
const loop=routeSource.slice(routeSource.indexOf('for (const route of routes) {'));
assert.ok(loop.includes("result.text ? 'WORKS ' : 'FAILS '"));
async function verdict(text,failure) {
  const lines=[],fakeProcess={exitCode:0,exit(code){this.exitCode=code;}};
  await vm.runInNewContext(`(async()=>{${loop}})()`,{
    routes:[{provider:'fixture',model:'probe'}],
    tryRoute:async route=>({...route,text,failure}),
    console:{log:line=>lines.push(line)},process:fakeProcess,
  });
  return {lines,exitCode:fakeProcess.exitCode};
}
const partial=await verdict('partial answer','fatal turn error');
const failed=await verdict('','fatal turn error');
assert.ok(partial.lines[0].startsWith('WORKS '));assert.ok(failed.lines[0].startsWith('FAILS '));assert.equal(failed.exitCode,0);
record('T01',{partialTextPlusFailure:partial,allRoutesFailed:failed});

// T02: extract tools.mjs's initialize request and send that shape to the real
// bridge using a recording service that performs no model/persistence activity.
register(`data:text/javascript,${encodeURIComponent(`import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';const r=createRequire(${JSON.stringify(auditPath.join(auditDsh,'package.json'))});export async function resolve(s,c,n){if(s.startsWith('@deepseek-ai/'))return {url:pathToFileURL(r.resolve(s)).href,shortCircuit:true};return n(s,c);}`)}`);
const {PaseoHarnessServer}=await import(root+'/dsh-bridge/lib/server.js');
const toolsSource=await readFile(root+'/harness/tools.mjs','utf8');
const initialize=toolsSource.match(/await request\('initialize', [^\n]+/)[0];
let args;
await vm.runInNewContext(`(async()=>{${initialize}})()`,{request:async(_method,params)=>{args=params;},process:{cwd:()=>'/tmp'}});
assert.equal(args.sessionId,undefined);
const llm={listProviders:()=>[{id:'fixture'}],resolveCallConfig:async()=>({})};
const bridge=new PaseoHarnessServer({on:()=>()=>{},get:n=>n==='llm'?llm:undefined},{notify(){}},{provider:'fixture',model:'probe'});
await bridge.initialize(args);
let rejection;
try{await bridge.prompt({sessionId:'tools-synthetic-session',contentBlocks:[]});}catch(error){rejection=error.message;}
assert.match(rejection,/not initialized for session/);
record('T02',{initializeParams:args,promptRejection:rejection});

// T03: use the original fold helper and its original assistant-only prefilter.
const pluginSource=await readFile(root+'/harness/plugin-check.cjs','utf8');
const start=pluginSource.indexOf('function projectTimelineLikePaseo(');
const end=pluginSource.indexOf('\n(async () => {',start);
const project=vm.runInNewContext(`(${pluginSource.slice(start,end).trim()})`);
const interleaved=[
  {type:'assistant_message',id:'a',messageId:'a',text:'A'},
  {type:'reasoning',id:'r',text:'THINK'},
  {type:'assistant_message',id:'a',messageId:'a',text:'AB'},
];
const filtered=interleaved.filter(item=>item.type==='assistant_message');
const originalOracle=project(interleaved,'turn:any');
const testedOracle=project(filtered,'turn:any');
assert.equal(originalOracle.filter(item=>item.type==='assistant_message').length,2);
assert.equal(testedOracle.filter(item=>item.type==='assistant_message').length,1);
record('T03',{realSequence:interleaved.map(item=>item.type),fullSequenceAssistantRows:2,assistantOnlyPrefilterRows:1,harnessPredicatePasses:true});

// T04: the exact image evidence regex accepts the literal phrase the prompt
// instructs the model to say, with no image input required by that predicate.
const regexSource=pluginSource.match(/\/image\|图片\|[^\n]*?\/i/)[0];
const evidence=vm.runInNewContext(regexSource);
assert.equal(evidence.test('IMAGE-SEEN'),true);
record('T04',{imageBlocksSent:0,syntheticAssistantReply:'IMAGE-SEEN',imageEvidencePredicatePasses:evidence.test('IMAGE-SEEN')});
await writeFile(output+'/harness-extra-repro-results.json',JSON.stringify(results,null,2));
