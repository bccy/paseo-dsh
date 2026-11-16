/** Offline table/store/lifecycle checks. No daemon, profile, RPC or model.
 * Run: node harness/workspace-badges-check.cjs
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { resolvePluginBuild } = require('./plugin-build.cjs');
const build = resolvePluginBuild(undefined, '.dbg-workspace-badges');
const { aggregateWorkspaceStatus, createWorkspaceStatusStore } = require(path.join(build, 'client/workspace-status.js'));
const { setLocale } = require(path.join(build, 'client/locale.js'));
(async () => {
let checks = 0;
function check(name, actual, expected) { assert.deepEqual(actual, expected, name); checks++; }
const agent = { id: 'a', workspaceId: 'w', provider: 'deepseek-harness-native', status: 'running' };
const goal = { id:'g', revision:1, objective:'work', phase:'active', activation:'armed', roundsStarted:1, maxGoalRounds:10 };
const team = { enabled:true, members:[{ id:'t', name:'worker', role:'teammate', running:true }], tasks:[] };
const job = { id:'j', kind:'bash', label:'work', status:'running', canStop:true, startedAt:1 };
const result = (kind, data, extra={}, meta={}) => aggregateWorkspaceStatus([{agent:{...agent,...meta},state:{[kind]:{available:true,data,...extra}}}])[kind];
const tone = (kind,data,extra,meta) => result(kind,data,extra,meta)?.tone ?? null;
for (const [name, actual, expected] of [
 ['no data', aggregateWorkspaceStatus([]), {goal:null,team:null,jobs:null}],
 ['active armed goal',tone('goal',goal),'info'],
 ['armed idle goal',tone('goal',goal,{}, {status:'idle'}),'info'],
 ['armed unknown activity',tone('goal',goal,{}, {status:undefined}),'info'],
 ['background armed goal between rounds',tone('goal',goal,{}, {status:'idle',background:true}),'info'],
 ['missing goal session hidden',tone('goal',null,{available:false,code:'session_missing'}),null],
 ['missing team session hidden',tone('team',null,{available:false,code:'session_missing'}),null],
 ['goal service absent hidden',tone('goal',null,{available:false,code:'goal_unavailable'}),null],
 ['team service absent hidden',tone('team',null,{available:false,code:'team_unavailable'}),null],
 ['active disarmed goal',tone('goal',{...goal,activation:'disarmed'}),'warning'],
 ['paused goal',tone('goal',{...goal,phase:'paused'}),'warning'],
 ['blocked goal',tone('goal',{...goal,phase:'blocked'}),'danger'],
 ['unread completed goal',tone('goal',{...goal,phase:'complete'},{visible:true}),'success'],
 ['read completed goal',tone('goal',{...goal,phase:'complete'},{visible:false}),null],
 ['unknown seen state',tone('goal',{...goal,phase:'complete'}),null],
 ['goal absent',tone('goal',null),null],
 ['goal error',tone('goal',null,{available:false,error:'bad'}),'danger'],
 ['running team',tone('team',team),'info'],
 ['disabled team',tone('team',{...team,enabled:false}),null],
 ['unknown runtime activity',tone('team',{...team,members:[{...team.members[0],running:undefined,phase:'active'}]}),null],
 ['team failure',tone('team',{...team,failure:'bad'}),'danger'],
 ['member failure',tone('team',{...team,members:[{...team.members[0],running:false,phase:'failed'}]}),'danger'],
 ['team read failure',tone('team',null,{available:false,error:'bad'}),'danger'],
 ['running jobs',tone('jobs',[job]),'info'],
 ['stopping jobs are live',tone('jobs',[{...job,status:'stopping'}]),'info'],
 ['failed jobs hide',tone('jobs',[{...job,status:'failed'}]),null],
 ['jobs read failure hides',tone('jobs',[job],{available:false,error:'bad'}),null],
 ['background active goal',tone('goal',goal,{}, {background:true}),'info'],
 ['background blocked goal',tone('goal',{...goal,phase:'blocked'},{},{background:true}),null],
 ['background completion',tone('goal',{...goal,phase:'complete'},{visible:true},{background:true}),null],
 ['background failure',tone('goal',null,{available:false},{background:true}),null],
 ['background failed team still counts explicitly running member',tone('team',{...team,failure:'bad'},{},{background:true}),'info'],
 ['closed agent hidden',tone('goal',goal,{}, {status:'closed'}),null],
 ['foreign provider hidden',tone('goal',goal,{}, {provider:'other'}),null],
]) check(name,actual,expected);
const multi = [
 {agent,state:{goal:{available:true,data:goal}}},
 {agent:{...agent,id:'b'},state:{goal:{available:true,data:{...goal,phase:'complete'},visible:true}}},
 {agent:{...agent,id:'c'},state:{goal:{available:true,data:{...goal,phase:'paused'}}}},
 {agent:{...agent,id:'d'},state:{goal:{available:false,data:null,error:'read failed'}}},
];
check('priority danger',aggregateWorkspaceStatus(multi).goal.tone,'danger');
check('priority warning',aggregateWorkspaceStatus(multi.slice(0,3)).goal.tone,'warning');
check('priority success',aggregateWorkspaceStatus(multi.slice(0,2)).goal.tone,'success');
check('counts retain all states',aggregateWorkspaceStatus(multi).goal.counts,{danger:1,warning:1,success:1,info:1});
const store=createWorkspaceStatusStore(), g=store.observer('goal'), j=store.observer('jobs');
let w=0, other=0; const un=store.subscribe('w',()=>w++);store.subscribe('other',()=>other++);
g.agent(agent);g.state('a',{available:true,data:goal});
check('first update publishes',w,1);const same=store.getSnapshot('w');
g.state('a',{available:true,data:{...goal}});check('same aggregate retains snapshot identity',store.getSnapshot('w')===same,true);check('unrelated workspace never notified',other,0);
j.agent(agent);j.state('a',{available:true,data:[job]});check('other category update retains goal identity',store.getSnapshot('w').goal===same.goal,true);g.remove('a');
check('one stream removed preserves another',store.getSnapshot('w').jobs.tone,'info');check('goal removed',store.getSnapshot('w').goal,null);
g.state('a',{available:true,data:goal});check('late removed stream ignored',store.getSnapshot('w').goal,null);
j.agent({...agent,workspaceId:'other'});check('old workspace cleared on move',store.getSnapshot('w'),{goal:null,team:null,jobs:null});check('new workspace receives retained state',store.getSnapshot('other').jobs.tone,'info');
j.agent({...agent,workspaceId:'other',status:'closed'});check('closed removes everything',store.getSnapshot('other'),{goal:null,team:null,jobs:null});
j.state('a',{available:true,data:[job]});check('late closed answer cannot resurrect',store.getSnapshot('other').jobs,null);
g.agent(agent);g.state('a',{available:true,data:{...goal,phase:'complete'},visible:true});g.state('a',{available:true,data:{...goal,phase:'complete'},visible:false});check('seen transition clears complete badge',store.getSnapshot('w').goal,null);
un();store.dispose();g.agent(agent);g.state('a',{available:true,data:goal});check('disposed store stays empty',store.getSnapshot('w'),{goal:null,team:null,jobs:null});
// Load UI using only host module substitutes. Registration and rendering never read data.
const originalLoad=Module._load;const ui=function NativeBadge(){};
Module._load=function(id,parent,main){if(id==='@getpaseo/plugin/client/ui')return {WorkspaceRowBadge:ui};if(id==='react')return {useCallback:f=>f,useSyncExternalStore:(_,get)=>get()};if(id==='react/jsx-runtime')return {jsx:(type,props)=>({type,props})};return originalLoad.call(this,id,parent,main)};
const {contributeWorkspaceBadges,workspaceBadgePresentation}=require(path.join(build,'client/workspace-badges.js'));Module._load=originalLoad;
let warns=[];const warn=console.warn;console.warn=(s)=>warns.push(s);contributeWorkspaceBadges({},createWorkspaceStatusStore())();console.warn=warn;
check('missing API warns exactly once',warns.length,1);check('missing API warning names 0.16.0',warns[0].includes('0.16.0'),true);
for(const locale of ['zh-CN','en']){setLocale(locale);const p=workspaceBadgePresentation('jobs',result('jobs',[job,{...job,id:'j2'}]));check('fixed background label '+locale,p.label,locale==='en'?'Background':'后台');check('count remains accessible '+locale,p.accessibilityLabel.includes('2'),true);}
setLocale('zh-CN');check('blocked goal uses blocked wording',workspaceBadgePresentation('goal',result('goal',{...goal,phase:'blocked'})).accessibilityLabel.includes('受阻'),true);const errorLabel=workspaceBadgePresentation('goal',result('goal',null,{available:false,code:'rpc_failed'})).accessibilityLabel;check('read failure accessible wording',errorLabel.includes('状态读取失败'),true);check('read error is not execution failure',errorLabel.includes('执行失败'),false);let reads=0,removes=0;const registrations=[];const s=createWorkspaceStatusStore();const observer=s.observer('jobs');observer.agent(agent);
const {createPillFeed}=require(path.join(build,'server/pill-feed.js'));const controller=new AbortController();
const feed=createPillFeed({read:async()=>{reads++;return {available:true,data:[job]}},isTerminal:()=>false,setTimeout:()=>0,clearTimeout:()=>{}});
feed.subscribe('a',answer=>observer.state('a',answer),controller.signal);await new Promise(setImmediate);const before=reads;
const cleanup=contributeWorkspaceBadges({addWorkspaceRowBadgeItem:(r)=>{registrations.push(r);return()=>removes++;},rpc(){throw Error('badge must not read RPC')},paseo:new Proxy({},{get(){throw Error('badge must not read Paseo')}})},s);
check('one registration per category',registrations.map(r=>r.id),['dsh-goal','dsh-team','dsh-jobs']);
check('empty component returns null',registrations[0].Component({workspaceId:'w'}),null);
check('live component uses native badge',registrations[2].Component({workspaceId:'w'}).type,ui);
check('empty workspace leaves no gaps',registrations[2].Component({workspaceId:'empty'}),null);
for(let i=0;i<100;i++)for(const r of registrations)r.Component({workspaceId:'w'});
check('100 row renders add no feed reads',reads,before);cleanup();check('all registrations cleaned up',removes,3);s.dispose();controller.abort();feed.dispose();
console.log(`${checks}/${checks} workspace badge checks passed`);

})().catch(error => { console.error(error); process.exitCode = 1; });
