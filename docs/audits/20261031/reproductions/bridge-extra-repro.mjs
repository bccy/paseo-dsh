import audit from './support.cjs';
const { repo: auditRepo, scratch: auditScratch, build: auditBuild, dsh: auditDsh, path: auditPath, url: auditUrl } = audit;
// Read-only review probes: production modules, synthetic services, private files,
// loopback-only MCP. No live DSH profile, daemon, or model calls.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const repo=auditRepo;
const scratch=auditScratch;
const temp=await mkdtemp(join(scratch,'bridge-probe-'));
const dsh=auditDsh;
register(`data:text/javascript,${encodeURIComponent(`import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url'; const r=createRequire(${JSON.stringify(join(dsh,'package.json'))}); export async function resolve(s,c,n){if(s.startsWith('@deepseek-ai/'))return {url:pathToFileURL(r.resolve(s)).href,shortCircuit:true};return n(s,c);}`)}`);
const {FileSnapshots}=await import(pathToFileURL(join(repo,'dsh-bridge/lib/file-snapshots.js')));
const {PaseoHarnessServer}=await import(pathToFileURL(join(repo,'dsh-bridge/lib/server.js')));
const {apply}=await import(pathToFileURL(join(repo,'dsh-bridge/lib/mcp-gateway.js')));
const result=[];
const check=(name,evidence)=>{result.push({name,evidence});console.log(name,JSON.stringify(evidence));};

try {
  // A fresh bridge process resets captureSequence despite sharing the durable journal.
  const snapshotRoot=join(temp,'snapshots');
  const dummy=join(temp,'dummy.txt'), target=join(temp,'target.txt');
  await writeFile(dummy,'dummy'); await writeFile(target,'ORIGINAL');
  const first=new FileSnapshots({rootDir:snapshotRoot});
  await first.capture({sessionId:'s',anchorSeq:10,callId:'warm',path:dummy});
  first.discard({sessionId:'s',callId:'warm'});
  await first.capture({sessionId:'s',anchorSeq:20,callId:'before-restart',path:target});
  await writeFile(target,'AFTER_FIRST_EDIT'); await first.commit({sessionId:'s',callId:'before-restart'},{});
  const second=new FileSnapshots({rootDir:snapshotRoot});
  await second.capture({sessionId:'s',anchorSeq:30,callId:'after-restart',path:target});
  await writeFile(target,'AFTER_SECOND_EDIT'); await second.commit({sessionId:'s',callId:'after-restart'},{});
  const journal=await second.readJournal('s');
  const plan=await second.planRestore('s',20);
  const restore=await second.restore('s',plan.actions);
  const restored=await readFile(target,'utf8');
  assert.equal(restored,'AFTER_FIRST_EDIT');
  check('snapshot-capture-order-resets',{captureSeq:journal.entries.map(e=>e.captureSeq),expected:'ORIGINAL',actual:restored,reportedRestored:restore.restored.length});

  // A background child can finish its already-captured edit after planRestore()
  // but before the bridge cancels and joins delegated work. The frozen file plan
  // then omits that path, while prune/trim erase its newly committed journal row.
  const raceRoot=join(temp,'race-snapshots');
  const rootFile=join(temp,'root-file'),childFile=join(temp,'child-file');
  await writeFile(rootFile,'ROOT_ORIGINAL');
  const snapshots=new FileSnapshots({rootDir:raceRoot});
  await snapshots.capture({sessionId:'race',anchorSeq:10,callId:'root-edit',path:rootFile});
  await writeFile(rootFile,'ROOT_CHANGED');await snapshots.commit({sessionId:'race',callId:'root-edit'},{});
  await snapshots.capture({sessionId:'race',anchorSeq:20,callId:'child-edit',path:childFile});
  const originalEvents=new Map([[0,{type:'user/message',data:{id:'first',source:{kind:'user'}}}],
    [10,{type:'user/message',data:{id:'second',source:{kind:'user'}}}],
    [20,{type:'user/message',data:{id:'third',source:{kind:'user'}}}]]);
  const session={id:'race',surface:{nodes:[0,10,20]},eventAt:seq=>originalEvents.get(seq),append(_type,_data){this.surface.nodes=[0,30];}};
  const rootAgent={id:'root-agent',session,status:'idle',inbox:{nextStep:[],nextTurn:[]}};
  const interrupted=[];
  const raceServices={sessions:{flush:async()=>{
    await writeFile(childFile,'CHILD_LATE_WRITE');
    await snapshots.commit({sessionId:'race',callId:'child-edit'},{});
    return true;
  }},subagents:{interrupt:id=>interrupted.push(id),waitForChildren:async()=>{}}};
  const raceCtx={on:()=>()=>{},get:n=>raceServices[n],agents:{get:()=>rootAgent}};
  const racing=new PaseoHarnessServer(raceCtx,{notify(){}},{});
  racing.fileSnapshots=snapshots;
  racing.sessions.set('race',{handle:{agent:rootAgent},control:{}});
  racing.childAnchors.record('child',20,'race');
  const raceResult=await racing.revert({sessionId:'race',scope:'both',token:{messageId:'second'}});
  const late=await readFile(childFile,'utf8');const remaining=(await snapshots.readJournal('race')).entries;
  assert.equal(late,'CHILD_LATE_WRITE');assert.equal(remaining.length,0);
  check('rewind-misses-inflight-child-edit',{expectedChildFile:'deleted',actualChildFile:late,receipt:raceResult.kind,
    restoredCount:raceResult.files.restored.length,deletedCount:raceResult.files.deleted.length,remainingJournalEntries:remaining.length,interrupted});

  // An old, still-running child spawns a grandchild after a later unrelated human
  // message reached the root. It should inherit its parent's dispatch anchor.
  const lineageRoot={id:'lineage-root',header:{},surface:{nodes:[10,20]},eventAt:seq=>({type:'user/message',data:{id:String(seq),source:{kind:'user'}}})};
  const parentSession={id:'parent-child',header:{origin:'subagent',parentSession:lineageRoot.id}};
  const grandchild={id:'grandchild',header:{origin:'subagent',parentSession:parentSession.id}};
  const lineageSessions=new Map([[lineageRoot.id,lineageRoot],[parentSession.id,parentSession],[grandchild.id,grandchild]]);
  const lineage=new PaseoHarnessServer({on:()=>()=>{},get:n=>n==='sessions'?{get:id=>lineageSessions.get(id)}:undefined},{notify(){}},{});
  lineage.childAnchors.record(parentSession.id,10,lineageRoot.id);
  lineage.observeDelegatedTurn(grandchild,{type:'turn/start'});
  const anchor=lineage.childAnchors.anchorFor(grandchild.id);
  assert.equal(anchor,20);
  check('grandchild-misattributed-to-later-root-message',{parentDispatchAnchor:10,latestRootHumanMessage:20,grandchildDispatchAnchor:anchor,withdrawnAt20:lineage.childAnchors.withdrawnSince(20,lineageRoot.id)});

  // lstat protects only the last path component, not an ancestor switched to a
  // symlink after capture. Everything remains within the private test tree.
  const linkRoot=join(temp,'link-snapshots'), workspace=join(temp,'workspace'), outside=join(temp,'outside');
  await mkdir(workspace);await mkdir(outside);
  const originalPath=join(workspace,'file');await writeFile(originalPath,'WORKSPACE_ORIGINAL');
  const linkSnapshots=new FileSnapshots({rootDir:linkRoot});
  await linkSnapshots.capture({sessionId:'link',anchorSeq:10,callId:'edit',path:originalPath});
  await writeFile(originalPath,'WORKSPACE_EDIT');await linkSnapshots.commit({sessionId:'link',callId:'edit'},{});
  await writeFile(join(outside,'file'),'UNRELATED_OUTSIDE_FILE');
  await rename(workspace,workspace+'-moved');await symlink(outside,workspace,'dir');
  const linkedPlan=await linkSnapshots.planRestore('link',10);
  const linkedResult=await linkSnapshots.restore('link',linkedPlan.actions);
  const outsideValue=await readFile(join(outside,'file'),'utf8');assert.equal(outsideValue,'WORKSPACE_ORIGINAL');
  check('restore-follows-symlink-ancestor',{outsideExpected:'UNRELATED_OUTSIDE_FILE',outsideActual:outsideValue,restoredCount:linkedResult.restored.length,skippedCount:linkedResult.skipped.length});

  // Real bridge createSession with no models: synthetic create/resume seam restores
  // the durable plan flag, exactly what DSH's planMode projection does.
  const planCalls=[]; let active=true;
  const ctx={on:()=>()=>{},get:n=>n==='planMode'?{
    get:()=>({active}),set:(_agent,value)=>{active=value;planCalls.push(value);return 'committed';},
  }:undefined,agents:{create:async()=>{throw new Error('already exists');},resume:async()=>({agent:{id:'a',session:{id:'s'}}})}};
  const bridge=new PaseoHarnessServer(ctx,{notify(){}},{});
  const receipt=await bridge.planSet({sessionId:'s',active:false});
  await bridge.createSession('s');
  assert.equal(active,true); assert.equal(planCalls.length,0);
  check('queued-plan-off-dropped',{receipt,activeAfterResume:active,setCalls:planCalls});

  // Result-only structured payload and a cancellation while a tool is in flight.
  let entered; let count=0; let abortedRequest=false; let completedAfterAbort=false;
  const callsEntered=new Promise(resolve=>{entered=resolve;});
  const c=new AbortController();
  const server=createServer((req,res)=>{
    let body='';req.on('data',b=>body+=b);req.on('end',()=>{
      const message=JSON.parse(body);
      const respond=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:value}));};
      if(message.method==='initialize')return respond({protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}});
      if(message.method==='notifications/initialized'){res.writeHead(202);return res.end();}
      if(message.method==='tools/call'){
        count++;
        if(message.params.name==='structured')return respond({content:[],structuredContent:{answer:42}});
        res.on('close',()=>{if(!res.writableEnded)abortedRequest=true;});
        entered();
        setTimeout(()=>{completedAfterAbort=c.signal.aborted;respond({content:[{type:'text',text:'SIDE_EFFECT_COMPLETED'}]});},120);
        return;
      }
      respond({tools:[]});
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const registry=new Map();const dispose=[];
    apply({tools:{register:t=>registry.set(t.name,t)},effect:f=>dispose.push(f()),get:()=>undefined},{servers:{fake:{url:`http://127.0.0.1:${server.address().port}`}},timeoutMs:1000});
    const execute=registry.get('mcp_call_tool').execute;
    const structured=await execute({tool:'structured'}, {signal:new AbortController().signal});
    assert.equal(structured.content,'');assert.equal(structured.structuredContent,undefined);
    check('mcp-structured-content-dropped',{serverResult:{content:[],structuredContent:{answer:42}},gatewayResult:structured});
    const pending=execute({tool:'delayed'}, {signal:c.signal});
    await callsEntered;c.abort(new Error('user cancelled the turn'));
    const completed=await pending;
    assert.equal(completed.content,'SIDE_EFFECT_COMPLETED'); assert.equal(completedAfterAbort,true);assert.equal(abortedRequest,false);
    check('mcp-caller-abort-ignored',{signalAborted:c.signal.aborted,requestAborted:abortedRequest,completedAfterAbort,result:completed});
    await Promise.allSettled(dispose.map(f=>f?.()));
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

  // Change TMPDIR only in an isolated subprocess so the normal UID cache is never
  // touched. Simulates an attacker-owned pre-created predictable cache directory.
  const imgroot=join(temp,'image-tmp');await mkdir(imgroot);
  const img=execFileSync(process.execPath,['--input-type=module','-e',`
    import {mkdirSync,writeFileSync,symlinkSync,readFileSync} from 'node:fs';
    import {join} from 'node:path';
    const root=${JSON.stringify(imgroot)};
    const source=join(root,'digest'),victim=join(root,'victim');
    writeFileSync(source,'ATTACHMENT_BYTES');writeFileSync(victim,'KEEP_ME');
    const cache=join(root,'paseo-dsh-attachments-'+process.getuid());mkdirSync(cache,{mode:0o777});
    symlinkSync(victim,join(cache,'digest.jpg.'+process.pid+'.tmp'));
    const {hostImagePath}=await import(${JSON.stringify(pathToFileURL(join(repo,'dsh-bridge/lib/image-host-path.js')).href)});
    const output=hostImagePath(source,'image/jpeg');
    console.log(JSON.stringify({victim:readFileSync(victim,'utf8'),outputEndsInJpg:output.endsWith('.jpg')}));
  `],{env:{...process.env,TMPDIR:imgroot},encoding:'utf8'});
  const imageEvidence=JSON.parse(img); assert.equal(imageEvidence.victim,'ATTACHMENT_BYTES');
  check('image-staging-follows-symlink',imageEvidence);
  await writeFile(join(scratch,'bridge-extra-repro-results.json'),JSON.stringify(result,null,2));
} finally {await rm(temp,{recursive:true,force:true});}
