const audit = require('./support.cjs');
const { repo: auditRepo, scratch: auditScratch, build: auditBuild, dsh: auditDsh, path: auditPath, url: auditUrl } = audit;
const root=auditBuild;
const {TimelineBuilder}=require(root+'/server/timeline.js');
const {toolCallData}=require(root+'/client/tool-call-data.js');
for (const [name,args] of [
 ['write',{file_path:'/synthetic/example.txt',content:'requested contents'}],
 ['edit',{file_path:'/synthetic/example.txt',old_string:'before',new_string:'after'}],
 ['bash',{command:'synthetic command'}],
]) {
 const b=new TimelineBuilder();const errorText='AUDIT_ERROR_PERMISSION_DENIED';
 b.consume({type:'tool/call',data:{turn:1,step:1,callId:'fake-call',name,arguments:args}});
 const rows=b.consume({type:'tool/result',data:{turn:1,step:1,toolCallId:'fake-call',message:{isError:true,content:[{type:'text',text:errorText}]}}});
 const row=rows.find(x=>x.type==='tool_call');const mapped=toolCallData(row,'complete');
 console.log(JSON.stringify({name,serverStatus:row.status,serverError:row.error,mappedStatus:mapped.status,mappedBody:mapped.body,errorSurvives:JSON.stringify(mapped).includes(errorText)}));
}
