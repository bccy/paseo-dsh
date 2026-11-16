/** Offline screenshots of the real host WorkspaceRowBadge + real plugin components.
 * Uses RN Web and theme/icon adapters; no daemon, profile or model. This is a
 * component preview, not an installed-plugin/sidebar/Show-menu end-to-end test.
 * Run: node harness/workspace-badges-preview.cjs <Paseo checkout> <output directory>
 */
const fs=require('node:fs'), path=require('node:path'), http=require('node:http');
const {createRequire}=require('node:module');
const host=path.resolve(process.argv[2]||'');const output=path.resolve(process.argv[3]||'');
if(!process.argv[2]||!process.argv[3])throw Error('Pass Paseo checkout and output directory');
const hostRequire=createRequire(path.join(host,'package.json'));
const esbuild=hostRequire('esbuild'),{chromium}=hostRequire('playwright');
const repo=path.resolve(__dirname,'..');fs.mkdirSync(output,{recursive:true});
const kit=path.join(host,'packages/app/src/plugins/workspace-row-badge-items/kit.tsx');
const preview=`
import React from 'react'; import {createRoot} from 'react-dom/client';
import {contributeWorkspaceBadges} from ${JSON.stringify(path.join(repo,'paseo-plugin/client/workspace-badges.tsx'))};
import {createWorkspaceStatusStore} from ${JSON.stringify(path.join(repo,'paseo-plugin/client/workspace-status.ts'))};
import {setLocale} from ${JSON.stringify(path.join(repo,'paseo-plugin/client/locale.ts'))};
const language=new URLSearchParams(location.search).get('lang')||'zh-CN';setLocale(language);
const store=createWorkspaceStatusStore(),items=[];
contributeWorkspaceBadges({addWorkspaceRowBadgeItem:r=>{items.push(r);return()=>{}}},store);
const goal={id:'goal',revision:1,objective:'Deliver release',phase:'active',activation:'armed',roundsStarted:1,maxGoalRounds:10};
const job={id:'job',kind:'bash',label:'Build',status:'running',canStop:true,startedAt:1};
const team={enabled:true,members:[{id:'child',name:'worker',role:'teammate',running:true}],tasks:[]};
const add=(id,workspaceId,kind,data,extra={},background=false)=>{const o=store.observer(kind);o.agent({id,workspaceId,provider:'deepseek-harness-native',status:'running',background});o.state(id,{available:true,data,...extra});};
add('a','active','goal',goal);add('a','active','team',team);add('a','active','jobs',[job,{...job,id:'job2'}]);
add('b','blocked','goal',{...goal,phase:'blocked'});add('c','failed','team',null,{available:false,error:'read failed'});
add('d','complete','goal',{...goal,phase:'complete'},{visible:true});add('e','background','goal',goal,{},true);add('e','background','jobs',[job],{},true);
add('f','quiet','goal',{...goal,phase:'complete'},{visible:false});
const rows=[['active','Paseo DSH','Running'],['blocked','Release review','Needs attention'],['failed','Integration tests','Read failure'],['complete','Documentation','Completed, unread'],['background','Background agent','Running without attention'],['quiet','Archive','Seen, no badge']];
function App(){return <main><aside><h2>Workspaces</h2>{rows.map(([id,name,note])=><section key={id}><strong>{name}</strong><div className="badges">{items.map(({id:kind,Component})=><Component key={kind} workspaceId={id}/>)}</div></section>)}</aside><article><h1>DSH workspace status</h1><p>Official WorkspaceRowBadge component</p><p>Existing pill stream snapshots · no additional reads</p><small>Offline component preview with RN Web and theme/icon adapters. This is not a live daemon or mobile app capture.</small></article></main>};
createRoot(document.getElementById('root')).render(<App/>);
`;
const theme=`const light=new URLSearchParams(location.search).get('theme')==='light';export const theme={colors:light?{foregroundMuted:'#71717a',statusSuccess:'#3e704a',statusWarning:'#7b5d39',statusDanger:'#9d433b',statusDotRunning:'#268ae0'}:{foregroundMuted:'#a1a1aa',statusSuccess:'#6cb17b',statusWarning:'#c09664',statusDanger:'#d8847b',statusDotRunning:'#5caaf6'},fontSize:{sm:12}};`;
const shims={
 'react-native-unistyles':`${theme} import React from 'react';export const StyleSheet={create:f=>f(theme)};export const withUnistyles=C=>({uniProps,...props})=><C {...props} {...(uniProps?uniProps(theme):{})}/>;`,
 '@/hosts/host-badge':`export const HOST_BADGE_ICON_SIZE=12;`,
 'offline-icons':`import React from 'react';import {Target,Users,Terminal,Check} from 'lucide-react';const icons={Target,Users,Terminal,Check};export const parsePluginIcon=(_,icon)=>icon;export function PluginIconView({icon,size,color}){const I=icons[icon];return <I width={size} height={size} color={color}/>}`,
 '@getpaseo/plugin/client/ui':`export {WorkspaceRowBadge} from ${JSON.stringify(kit)};`,
 '@getpaseo/plugin':`export const defineSubscription=x=>x;export const defineRpc=x=>x;`,
};
(async()=>{
 await esbuild.build({stdin:{contents:preview,resolveDir:repo,sourcefile:'workspace-badges-preview.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',outfile:path.join(output,'preview.js'),jsx:'automatic',plugins:[{name:'offline-host-adapters',setup(build){
  build.onResolve({filter:/.*/},args=>{
   if(args.path==='../icons'&&args.importer===kit)return {path:'offline-icons',namespace:'stub'};
   if(shims[args.path])return {path:args.path,namespace:'stub'};
   if(args.path==='react-native')return {path:hostRequire.resolve('react-native-web')};
   if(['react','react/jsx-runtime','react-dom/client','lucide-react','zod'].includes(args.path))return {path:hostRequire.resolve(args.path)};
  });
  build.onLoad({filter:/.*/,namespace:'stub'},args=>({contents:shims[args.path],loader:'tsx',resolveDir:host}));
 }}]});
 fs.writeFileSync(path.join(output,'index.html'),`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;background:#0d1117;color:#e6edf3;font:14px system-ui}main{display:flex;min-height:100vh}aside{width:300px;padding:22px 16px;background:#161b22;border-right:1px solid #30363d}h2{font-size:13px;color:#8d949e;margin:0 0 18px}section{padding:13px 10px;margin:3px 0;border-radius:7px}section:first-of-type{background:#21262d}strong{font-size:14px;font-weight:500}.badges{display:flex;gap:10px;min-width:0;margin-top:7px}article{padding:65px 42px;max-width:650px}h1{font-size:25px}p,small{color:#8d949e;line-height:1.6}small{display:block;margin-top:50px}@media(max-width:600px){aside{width:100%;border:0}article{display:none}section{padding:15px 10px}}.light{background:#fff;color:#24292f}.light aside{background:#f6f8fa;border-color:#d0d7de}.light section:first-of-type{background:#eaeef2}</style><div id="root"></div><script>if(new URLSearchParams(location.search).get('theme')==='light')document.body.className='light'</script><script src="preview.js"></script>`);
 const server=http.createServer((req,res)=>{res.setHeader('content-type',req.url.split('?')[0].endsWith('.js')?'text/javascript':'text/html');res.end(fs.readFileSync(path.join(output,req.url.split('?')[0].endsWith('.js')?'preview.js':'index.html')))});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});for(const [name,width,height,query] of [['desktop',1280,800,''],['mobile',390,844,''],['desktop-light-en',1280,800,'?theme=light&lang=en']]){const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port+'/'+query);await page.waitForSelector('section .badges [aria-label]');await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});if(errors.length)throw Error(errors.join('\n'));await page.close();}}
 finally{if(browser)await browser.close();server.close();}
 fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify({scope:'offline component preview',officialComponent:kit,pluginSource:repo,adapters:['react-native-web','unistyles theme','lucide icon map'],notVerified:['live daemon','installed plugin sidebar','Show menu','native mobile runtime'],screenshots:['desktop.png','mobile.png','desktop-light-en.png']},null,2));console.log(output);
})().catch(e=>{console.error(e);process.exitCode=1});
