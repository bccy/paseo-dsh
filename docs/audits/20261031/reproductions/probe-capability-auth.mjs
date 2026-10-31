import audit from './support.cjs';
const { repo: auditRepo, scratch: auditScratch, build: auditBuild, dsh: auditDsh, path: auditPath, url: auditUrl } = audit;
const { runProbe } = await import(auditUrl.pathToFileURL(auditPath.join(auditRepo,"paseo-plugin/lib/probe-provider.mjs")).href);
process.env.AUDIT_SYNTHETIC_KEY='synthetic-only';
for (const status of [401,402,403,429]) {
 let calls=0;globalThis.fetch=async()=>{
   calls++;return calls===1
    ? new Response(JSON.stringify({choices:[{message:{content:'391'}}]}),{status:200})
    : new Response(JSON.stringify({error:{message:'synthetic auth or quota refusal'}}),{status});
 };
 let output='';const original=process.stdout.write;const oldError=process.stderr.write;process.exitCode=0;
 process.stdout.write=(part)=>{output+=part;return true;};process.stderr.write=(part)=>{output+=part;return true;};
 try{await runProbe(['--base-url','http://synthetic.invalid/v1','--api-key-env','AUDIT_SYNTHETIC_KEY','--model','synthetic-model']);}
 finally{process.stdout.write=original;process.stderr.write=oldError;}
 console.log(JSON.stringify({status,requests:calls,exitCode:process.exitCode??0,advisesDisableReasoning:output.includes('declare `reasoningEfforts: false`'),developerRejected:output.includes('REJECTED -> needs compat.supportsDeveloperRole: false'),unknownReasoning:output.includes('so this is not a result')}));
}
process.exitCode=0;
