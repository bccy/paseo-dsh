const audit = require('./support.cjs');
const { repo: auditRepo, scratch: auditScratch, build: auditBuild, dsh: auditDsh, path: auditPath, url: auditUrl } = audit;
// Pure in-memory evaluation of the patch's source transformation only.
// The apply/revert entrypoints and all filesystem mutation helpers are excluded.
const fs=require('node:fs');const vm=require('node:vm');
const ts=require(auditPath.join(auditRepo,"paseo-plugin/node_modules/typescript"));
const source=fs.readFileSync(auditPath.join(auditRepo,"local-patches/apply-rewind-history-truncation.mjs"),'utf8');
const ast=ts.createSourceFile('patch.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const names=new Set(['matchClosingBrace','locateRewindCallRegion','rebuildRewindCall','reindent','normaliseEol']);const pieces=[];
for(const node of ast.statements){
 if(ts.isFunctionDeclaration(node)&&names.has(node.name?.text))pieces.push(node.getText(ast));
 if(ts.isVariableStatement(node))for(const d of node.declarationList.declarations){if(['CALL','CALL_BASE_INDENT'].includes(d.name.getText(ast)))pieces.push('const '+d.getText(ast)+';');}
}
const transform=vm.runInNewContext(pieces.join('\n')+'\n({CALL,rebuildRewindCall})',{process:{stderr:{write:()=>{throw new Error('unexpected failure branch');}}},succeed:()=>{throw new Error('unexpected failure branch');}});
const fixture='class Example {\n    async revert(messageId, scope) {\n        await this.bridge.revert({\n            type: "session.revert",\n            token,\n            scope,\n        });\n'+transform.CALL+'        this.upstreamCleanupAfterRewind();\n    }\n}\n';
const edit=transform.rebuildRewindCall(fixture,'    ',false);
const changed=fixture.slice(0,edit.index)+edit.text+fixture.slice(edit.index+edit.length);
console.log(JSON.stringify({unrelatedTailPresentBefore:fixture.includes('this.upstreamCleanupAfterRewind();'),unrelatedTailPresentAfter:changed.includes('this.upstreamCleanupAfterRewind();'),changedSourceParses:ts.createSourceFile('after.js',changed,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS).parseDiagnostics.length===0,transformationOnly:true}));
