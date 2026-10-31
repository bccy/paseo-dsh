const audit = require('./support.cjs');
const { repo: auditRepo, scratch: auditScratch, build: auditBuild, dsh: auditDsh, path: auditPath, url: auditUrl } = audit;
// Execute the real compiled component with a minimal deterministic hooks dispatcher.
// This verifies hook dependencies/state transitions; it is not a native UI test.
const Module=require('node:module');
const oldLoad=Module._load;
const slots=[];let cursor=0;let effects=[];let changed=false;
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
const hooks={
 useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],v=>{const next=typeof v==='function'?v(slots[i]):v;if(!Object.is(next,slots[i])){slots[i]=next;changed=true;}}];},
 useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},
 useEffect(fn,deps){const i=cursor++;if(!same(slots[i],deps)){slots[i]=deps;effects.push(fn);}},
 useMemo(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={deps,value:fn()};return slots[i].value;}
};
Module._load=function(id,parent,isMain){
 if(id==='react')return hooks;
 if(id==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'Fragment'};
 if(id==='react-native')return {Pressable:'Pressable',Text:'Text',View:'View',Image:'Image'};
 if(id==='./text-shimmer')return {TextShimmer:'TextShimmer'};
 return oldLoad.apply(this,arguments);
};
const {InlineThinking}=require(auditPath.join(auditBuild,"client/inline-thinking.js"));
function find(node){if(!node||typeof node!=='object')return null;if(node.type==='TextShimmer')return node.props.active;const cs=node.props?.children;for(const child of Array.isArray(cs)?cs:[cs]){const answer=find(child);if(answer!==null)return answer;}return null;}
function render(text,phase){let tree;let turns=0;do{changed=false;effects=[];cursor=0;tree=InlineThinking({theme:{colors:{foregroundMuted:'#888',foreground:'#fff',surface0:'#000'}},layout:{compact:false},item:{data:{text,phase}}});for(const effect of effects)effect();}while(changed&&++turns<10);return {text,phase,shimmerActive:find(tree),renders:turns+1};}
console.log(JSON.stringify(render('a','streaming')));
console.log(JSON.stringify(render('ab','complete')));
console.log(JSON.stringify(render('ab','complete')));
console.log(JSON.stringify(render('ab','streaming')));
console.log(JSON.stringify(render('ab','complete')));
