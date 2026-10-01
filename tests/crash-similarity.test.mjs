// Crash-map retrieval must report true cosine similarity, so the adaptive-gate
// threshold means what its comment says. Uses the vendored browser WASM.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {similarityFromDistance} from '../AI-Car-Racer/archive/similarity.js';
import {crashLayoutFromHit,crashMapMode} from '../AI-Car-Racer/archive/crashRecall.js';
import initVec,{VectorDB} from '../vendor/ruvector/ruvector_wasm/ruvector_wasm.js';

await initVec({module_or_path:await readFile(new URL('../vendor/ruvector/ruvector_wasm/ruvector_wasm_bg.wasm',import.meta.url))});
const scope=vm.createContext({});
vm.runInContext(await readFile(new URL('../AI-Car-Racer/crashMapCodec.js',import.meta.url),'utf8'),scope);
const {encodeDeathMap,CRASH_DIM}=scope.CrashMapCodec;
const gates=await readFile(new URL('../AI-Car-Racer/adaptiveGates.js',import.meta.url),'utf8');
const CRASH_SIM_MIN=Number(gates.match(/const CRASH_SIM_MIN = ([\d.]+);/)[1]);
const bridge=await readFile(new URL('../AI-Car-Racer/ruvectorBridge.js',import.meta.url),'utf8');

// Deaths at canvas cell centres (16×9 grid over 3200×1800).
const map=cells=>{
  const xy=new Float32Array(cells.length*2);
  cells.forEach(([gx,gy],i)=>{xy[i*2]=(gx+.5)*200;xy[i*2+1]=(gy+.5)*200;});
  return encodeDeathMap(xy,cells.length,3200,1800);
};
const cosine=(a,b)=>{let d=0;for(let i=0;i<a.length;i++)d+=a[i]*b[i];return d;};
const repeat=(cell,n)=>Array.from({length:n},()=>cell);
const base=map([...repeat([2,2],6),...repeat([8,4],3),[12,6],[3,7]]);
const similar=map([...repeat([2,2],5),...repeat([8,4],3),[12,6],[4,7]]);
const weak=map([...repeat([2,2],1),...repeat([9,4],6),...repeat([13,1],6),[1,8],[5,5],[14,3]]);
const disjoint=map([...repeat([10,1],5),...repeat([15,8],5),[6,0]]);

test('distance converts to a clamped cosine similarity',()=>{
  assert.equal(similarityFromDistance(0),1);assert.equal(similarityFromDistance(1),0);
  assert.equal(similarityFromDistance(2),0);assert.ok(Math.abs(similarityFromDistance(.3)-.7)<1e-12);
  assert.equal(similarityFromDistance(-1e-7),1,'Rounding below zero still means identical');
  assert.equal(similarityFromDistance('0.25'),.75);
  for(const bad of [null,undefined,'',NaN,Infinity,'x',{}])assert.equal(similarityFromDistance(bad),0,String(bad));
});

test('crash fixtures cover strong, weak, and no overlap',()=>{
  assert.equal(base.length,CRASH_DIM);
  assert.ok(cosine(base,similar)>.9);
  const c=cosine(base,weak);assert.ok(c>.1&&c<CRASH_SIM_MIN,`weak cosine ${c}`);
  assert.equal(cosine(base,disjoint),0);
});

test('recalled crash layouts carry cosine similarity from the vendored VectorDB',()=>{
  const db=new VectorDB(CRASH_DIM,'cosine'),mirror=new Map();
  const layout=[[{x:1,y:2},{x:3,y:4}]];
  for(const [id,vector] of [['similar',similar],['weak',weak],['disjoint',disjoint],['self',base]]){
    const meta={survival:.8,fitness:4,generation:7,cps:layout,geometrySig:'sig'};
    db.insert(vector,id,null);mirror.set(id,{vector,meta});
  }
  const records=db.search(base,4).map(hit=>crashLayoutFromHit(hit,mirror.get(hit.id)));
  assert.deepEqual(records.map(r=>r.id),['self','similar','weak','disjoint']);
  const expected={self:1,similar:cosine(base,similar),weak:cosine(base,weak),disjoint:0};
  for(const record of records){
    assert.ok(Math.abs(record.similarity-expected[record.id])<1e-4,`${record.id}: ${record.similarity} vs cosine ${expected[record.id]}`);
    assert.ok(Math.max(0,Math.min(1,1-record.distance/2))>=.5,'The former conversion could never reject a non-negative crash map');
    assert.equal(record.survival,.8);assert.equal(record.generation,7);assert.equal(record.geometrySig,'sig');assert.deepEqual(record.cps,layout);
  }
  assert.deepEqual(records.filter(r=>r.similarity>=CRASH_SIM_MIN).map(r=>r.id),['self','similar']);
  db.free?.();
});

test('hit metadata is the fallback, and missing fields are safe',()=>{
  const record=crashLayoutFromHit({id:'x',score:.4,metadata:{survival:'0.5',bottleneck:2.7}},undefined);
  assert.ok(Math.abs(record.similarity-.6)<1e-12);assert.equal(record.survival,.5);assert.equal(record.bottleneck,2);
  const empty=crashLayoutFromHit({id:'y',score:null},null);
  assert.equal(empty.similarity,0);assert.ok(Number.isNaN(empty.distance));assert.equal(empty.cps,null);assert.equal(empty.geometrySig,null);assert.equal(empty.bottleneck,null);
});

test('the bridge builds crash recalls with the tested mapping on a cosine index',()=>{
  const body=bridge.slice(bridge.indexOf('export function recommendCrashLayouts'),bridge.indexOf('export function crashMapCount')).replace(/\/\/.*$/gm,'');
  assert.match(body,/crashLayoutFromHit\(h, _crashMirror\.get\(h\.id\)\)/);
  assert.doesNotMatch(body,/\/\s*2/,'No halved distance in crash recall');
  const constructions=bridge.match(/_crashDB = new \w+\(CRASH_DIM, 'cosine'\)/g);
  assert.ok(constructions?.length>=2,'Expected the crash store to be constructed in ready() and rebuildIndicesFromMirror()');
  for(const line of constructions)assert.match(line,/new VectorDB\(/,'Crash maps must not follow the hyperbolic index kind');
});

test('death causes: car contact (5) has its own bucket, and an unknown code is never counted as alive',()=>{
  const causes=Int8Array.from([0,1,2,3,4,5,5,9,-1]);
  assert.deepEqual({...scope.CrashMapCodec.causeHistogram(causes,causes.length)},{headOn:1,side:1,slide:1,stalled:1,alive:1,contact:2,other:2});
  assert.deepEqual({...scope.CrashMapCodec.causeHistogram(null,3)},{headOn:0,side:0,slide:0,stalled:0,alive:0,contact:0,other:0});
});

test('car-contact deaths stay out of the adaptive-gates crash centroid',async()=>{
  const gatesScope=vm.createContext({window:{},location:{search:''},URLSearchParams,console});
  vm.runInContext(gates,gatesScope);
  const centroid=gatesScope.window.AdaptiveGates._crashCentroid;
  // Four wall deaths near (100, 100) after gate 2 and three contact deaths far away.
  const xy=Float32Array.from([100,100, 110,100, 100,110, 110,110, 2000,900, 2010,900, 2000,910, NaN,NaN]);
  const popCheckpoints=Int16Array.from([2,2,2,2,2,2,2,3]),popDeathCauses=Int8Array.from([0,1,0,2,5,5,5,4]);
  const c=centroid({popN:8,popDeathXY:xy,popCheckpoints,popDeathCauses},2);
  assert.deepEqual({x:c.x,y:c.y,n:c.n,scoped:c.scoped},{x:105,y:105,n:4,scoped:true});
  // Without causes (an older worker), every death counts, as before.
  assert.equal(centroid({popN:8,popDeathXY:xy,popCheckpoints},2).n,7);
  // Contact deaths do not count toward the global fallback either.
  const onlyContact=centroid({popN:8,popDeathXY:xy,popCheckpoints,popDeathCauses:Int8Array.from([5,5,5,5,5,5,5,4])},2);
  assert.equal(onlyContact,null);
});

test('C4: car-contact deaths stay off the crash map; without causes the map is unchanged',()=>{
  const xy=Float32Array.from([100,100, 110,100, 900,500, 1000,600, 2000,900, 2010,900, NaN,NaN]);
  const causes=Int8Array.from([0,1,2,0,5,5,4]);
  const withContacts=encodeDeathMap(xy,7,3200,1800),filtered=encodeDeathMap(xy,7,3200,1800,causes);
  const onlyWalls=encodeDeathMap(xy.slice(0,8),4,3200,1800);
  assert.deepEqual(Array.from(filtered),Array.from(onlyWalls),'the same map as the cars that did not die by contact');
  assert.notDeepEqual(Array.from(filtered),Array.from(withContacts));
  assert.deepEqual(Array.from(encodeDeathMap(xy,7,3200,1800,null)),Array.from(withContacts),'no causes: every death counts, as before');
  assert.deepEqual(Array.from(encodeDeathMap(xy,7,3200,1800,Int8Array.from([0,1,2,0,4,4,4]))),Array.from(withContacts),'no contact deaths: the same map');
  // Under three deaths left on the map: no map, as for any sparse generation.
  assert.equal(encodeDeathMap(xy,7,3200,1800,Int8Array.from([5,5,5,0,5,0,4])),null);
});

// Values from the vm realm, as plain JSON (other prototypes).
const plain=v=>JSON.parse(JSON.stringify(v));
// adaptiveGates.js in a small page: a road, localStorage, and a bridge whose
// crash-map recall returns `hits`.
function gatesPage(mode='off',globals={}){
  const storage=new Map(),archived=[];let hits=[];
  const gate=x=>[{x,y:0},{x,y:100}];
  const road={roadEditor:{points:[{x:0,y:0},{x:600,y:0}],points2:[{x:0,y:100},{x:600,y:100}],
    checkPointListEditor:[gate(0),gate(100),gate(200),gate(300),gate(400)]},checkPointList:null,rebuildGrids(){}};
  const window={CrashMapCodec:scope.CrashMapCodec,DriverLearning:{context:{collisions:mode}},
    __rvBridge:{recommendCrashLayouts:()=>hits,archiveCrashMap:(vec,meta)=>{archived.push({...meta,vec:Array.from(vec)});return 'c'+archived.length;}}};
  const context=vm.createContext({window,location:{search:''},URLSearchParams,console,road,canvas:{width:3200,height:1800},
    localStorage:{getItem:k=>storage.has(k)?storage.get(k):null,setItem:(k,v)=>storage.set(k,String(v))},document:{readyState:'complete'},...globals});
  vm.runInContext(gates,context);
  return {AG:window.AdaptiveGates,window,road,storage,archived,context,setHits:h=>{hits=h;}};
}
// One generation of 20 cars: 10 died by contact near (2000, 900), 10 at the walls near (300, 50).
function generation(mode){
  const N=20,xy=new Float32Array(N*2),causes=new Int8Array(N),popCheckpoints=new Int16Array(N);
  for(let i=0;i<N;i++){const contact=i<10;causes[i]=contact?5:i%3;xy[i*2]=contact?2000+i:300+i;xy[i*2+1]=contact?900:50;popCheckpoints[i]=contact?0:2;}
  return {popN:N,popDeathXY:xy,popDeathCauses:causes,popCheckpoints,popStillAlive:0,fitness:2,learningContext:{collisions:mode}};
}

test('C4: reach rates leave car-contact deaths out, and are exactly reached / N without them',()=>{
  const {AG}=gatesPage(),rates=(...a)=>plain(AG._reachRates(...a));
  const cps=Int16Array.from([0,1,1,3,2,0,4,1]);
  const old=Array.from({length:5},(_,k)=>k===0?1:Array.from(cps).filter(c=>c>=k).length/cps.length);
  assert.deepEqual(rates(cps,4,8),old);
  assert.deepEqual(rates(cps,4,8,Int8Array.from([0,1,2,3,4,0,1,2])),old,'no contact deaths: the old rates, bit for bit');
  // Twenty cars: 10 alive past gate 3, 5 wall deaths and 5 contact deaths after gate 1.
  // Gate 2: 10 of the 15 at risk (the 5 contact deaths left the count), not 10 of 20.
  const cp20=Int16Array.from([...Array(10).fill(3),...Array(10).fill(1)]),causes20=Int8Array.from([...Array(10).fill(4),...Array(5).fill(0),...Array(5).fill(5)]);
  assert.deepEqual(rates(cp20,3,20,causes20),[1,1,10/15,10/15]);
  assert.deepEqual(rates(cp20,3,20),[1,1,.5,.5],'without causes: reached / N');
  // Fewer than 5 cars at risk is no evidence: from that gate on, reached / N
  // (contacts count as failures), so a gate nobody reached reads 0, never passed.
  assert.deepEqual(rates(Int16Array.from([0,1,1,3]),3,4,Int8Array.from([5,0,5,4])),[1,.75,.25,.25]);
  assert.deepEqual(rates(Int16Array.from([0,0]),2,2,Int8Array.from([5,5])),[1,0,0]);
  // 50 cars: two stall early, 48 die by contact at gate 3: gates 4 and 5 read 0.
  const cp50=Int16Array.from([1,2,...Array(48).fill(3)]),causes50=Int8Array.from([3,3,...Array(48).fill(5)]);
  const r50=rates(cp50,5,50,causes50);
  assert.deepEqual(r50.slice(3),[.96,0,0]);assert.ok(Math.abs(r50[2]-.98)<1e-12);
  // Rates never rise from one gate to the next.
  for(let t=0;t<300;t++){
    const n=1+(t*7)%60,cps=Int16Array.from({length:n},(_,i)=>(i*13+t)%7),cs=Int8Array.from({length:n},(_,i)=>(i*5+t)%6);
    const r=rates(cps,6,n,cs);
    for(let k=1;k<r.length;k++)assert.ok(r[k]<=r[k-1]+1e-12&&r[k]>=0,`${t}: ${r}`);
  }
});

test('C4: a pile-up of contact deaths is a bottleneck, never a gate to prune',()=>{
  const {AG}=gatesPage('solid/k8/rays');AG.setEnabled(true);
  const N=50,cps=Int16Array.from([1,2,...Array(48).fill(3)]),causes=Int8Array.from([3,3,...Array(48).fill(5)]);
  const xy=Float32Array.from({length:N*2},(_,i)=>i%2?50:300+i);
  for(let g=0;g<4;g++){
    AG.onGenEnd({popN:N,popDeathXY:xy,popDeathCauses:causes,popCheckpoints:cps,popStillAlive:0,fitness:3,learningContext:{collisions:'solid/k8/rays'}});
    const status=AG.getStatus();
    assert.doesNotMatch(status.status,/removed|clearing/,status.status);
    assert.equal(status.removeCount,0);
  }
  assert.equal(AG.getStatus().bottleneck,4);
});

test('C4: adaptive gates recall, archive, and remember layouts per collision mode',()=>{
  const RAYS='solid/k8/rays',layout=[[{x:1,y:2},{x:1,y:98}],[{x:150,y:2},{x:150,y:98}],[{x:250,y:2},{x:250,y:98}],[{x:350,y:2},{x:350,y:98}],[{x:450,y:2},{x:450,y:98}]];
  const page=gatesPage(RAYS),{AG,road,storage,archived}=page;
  AG.setEnabled(true);
  const geo=AG.geometrySignature(),hit=collisions=>({cps:layout,geometrySig:geo,similarity:.95,survival:.9,collisions});
  // A better layout from normal driving is not applied in collision mode.
  page.setHits([hit('off')]);
  AG.onGenEnd(generation(RAYS));
  assert.notDeepEqual(plain(road.roadEditor.checkPointListEditor),layout);
  assert.match(AG.getStatus().status,/none beat survival \(1 from another collision mode\)/);
  // A map from before C4 whose causes count contacts is from collision mode:
  // it matches no mode, neither this one nor normal driving.
  const old=hit(undefined);delete old.collisions;
  page.setHits([{...old,collisions:'unknown'}]);AG.onGenEnd(generation(RAYS));
  assert.notDeepEqual(plain(road.roadEditor.checkPointListEditor),layout);
  // The map and its meta: the mode, and only the 10 wall deaths.
  assert.equal(archived.at(-1).collisions,RAYS);assert.equal(archived.at(-1).nDeaths,10);assert.equal(archived.at(-1).causes.contact,10);
  const g=generation(RAYS),walls=encodeDeathMap(g.popDeathXY.slice(20),10,3200,1800);
  assert.deepEqual(archived.at(-1).vec,Array.from(walls),'the archived vector is the map of the wall deaths');
  // Reach rates without the contact deaths: every car at risk reached gate 2,
  // nobody gate 3 (reached / N would put the cliff at gate 1).
  assert.equal(AG.getStatus().bottleneck,3);
  // The same layout archived in this mode is applied.
  page.setHits([hit('solid/k8'),hit(RAYS)]);
  AG.onGenEnd(generation(RAYS));
  assert.deepEqual(plain(road.roadEditor.checkPointListEditor),layout);
  assert.match(AG.getStatus().status,/applied layout/);
  // Remembered under this mode only; normal driving keeps its own key.
  const key='vv_adapt_gates_'+geo;
  assert.ok(storage.has(key+'|'+RAYS));assert.equal(storage.has(key),false);
  // Normal driving: a collision-mode hit is refused; an untagged one (every
  // map from before C4) is normal driving and applies.
  const normal=gatesPage('off');
  normal.AG.setEnabled(true);
  normal.setHits([hit(RAYS)]);normal.AG.onGenEnd(generation('off'));
  assert.notDeepEqual(plain(normal.road.roadEditor.checkPointListEditor),layout);
  assert.equal(normal.archived.at(-1).collisions,'off');
  const untagged=hit(undefined);delete untagged.collisions;
  normal.setHits([untagged]);normal.AG.onGenEnd(generation('off'));
  assert.deepEqual(plain(normal.road.roadEditor.checkPointListEditor),layout);
  assert.ok(normal.storage.has(key));assert.equal([...normal.storage.keys()].some(k=>k.includes('|')),false,'normal driving keeps the key it always had');
});

test('C4: turning adaptive gates on restores the best layout of this collision mode only',()=>{
  const RAYS='solid/k8/rays',page=gatesPage(RAYS),{AG,road,storage,window}=page;
  AG.setEnabled(true);
  const geo=AG.geometrySignature(),key='vv_adapt_gates_'+geo;
  const layout=[[{x:5,y:2},{x:5,y:98}],[{x:120,y:2},{x:120,y:98}],[{x:220,y:2},{x:220,y:98}],[{x:320,y:2},{x:320,y:98}],[{x:420,y:2},{x:420,y:98}]];
  storage.set(key,JSON.stringify({best:{survival:.9,fitness:5,cps:layout,geometrySig:geo},ring:[]}));
  const baseline=plain(road.roadEditor.checkPointListEditor);
  AG.setEnabled(false);AG.setEnabled(true);
  assert.deepEqual(plain(road.roadEditor.checkPointListEditor),baseline,'a normal-driving layout is not restored in collision mode');
  window.DriverLearning.context={collisions:'off'};
  AG.setEnabled(false);AG.setEnabled(true);
  assert.deepEqual(plain(road.roadEditor.checkPointListEditor),layout,'in normal driving it is');
  assert.match(AG.getStatus().status,/restored best layout/);
});

test('C4: before the first generation, adaptive gates read the mode the next generation runs in',()=>{
  const layout=[[{x:5,y:2},{x:5,y:98}],[{x:120,y:2},{x:120,y:98}],[{x:220,y:2},{x:220,y:98}],[{x:320,y:2},{x:320,y:98}],[{x:420,y:2},{x:420,y:98}]];
  for(const [name,learning,enabled,restored] of [
    ['Solid cars on, no context yet',{context:null,collisionMode:()=>'solid/k8/rays'},true,false],
    ['Solid cars on, the learning module not loaded',undefined,true,false],
    ['Solid cars off, no context yet',{context:null,collisionMode:()=>'off'},false,true],
    ['the next mode wins over the last context',{context:{collisions:'off'},collisionMode:()=>'solid/k8/rays'},true,false],
  ]){
    const page=gatesPage('off'),{AG,road,storage,window}=page;
    window.DriverLearning=learning;window.carCollisionsEnabled=()=>enabled;
    AG.captureBaseline();
    const geo=AG.geometrySignature();
    storage.set('vv_adapt_gates_'+geo,JSON.stringify({best:{survival:.9,fitness:5,cps:layout,geometrySig:geo},ring:[]}));
    AG.setEnabled(true);
    assert.equal(JSON.stringify(plain(road.roadEditor.checkPointListEditor))===JSON.stringify(layout),restored,name);
  }
});

test('C4: crash maps from before C4 are normal driving, unless their causes count car contacts',()=>{
  for(const [meta,mode] of [[{},'off'],[{causes:{contact:0,headOn:4}},'off'],[{causes:{contact:3}},'unknown'],
    [{collisions:'solid/k8/rays'},'solid/k8/rays'],[{collisions:'SOLID/K008/RAYS'},'solid/k8/rays'],[{collisions:'off',causes:{contact:2}},'off']])
    assert.equal(crashMapMode(meta),mode,JSON.stringify(meta));
  assert.equal(crashLayoutFromHit({id:'x',score:.1,metadata:{causes:{contact:5}}},null).collisions,'unknown');
  assert.equal(crashLayoutFromHit({id:'y',score:.1},null).collisions,'off');
});

test('C4: the reach-rate floor is 5 cars at risk',()=>{
  const {AG}=gatesPage(),rates=(...a)=>plain(AG._reachRates(...a));
  // One contact death before gate 1; then 5 (Kaplan-Meier) or 4 (reached / N) cars at risk for gate 2.
  const five=rates(Int16Array.from([0,1,1,1,1,2]),2,6,Int8Array.from([5,0,0,0,0,4]));
  assert.deepEqual(five,[1,1,.2]);
  const four=rates(Int16Array.from([0,1,1,1,2]),2,5,Int8Array.from([5,0,0,0,4]));
  assert.deepEqual(four,[1,.8,.2]);
});

test('C4: a change of collision mode restarts the survival trend',()=>{
  const {AG}=gatesPage('off');AG.setEnabled(true);
  const run=(mode,alive)=>{const g=generation(mode);g.popDeathCauses=g.popDeathCauses.map(c=>c===5&&mode==='off'?0:c);g.popStillAlive=alive;AG.onGenEnd(g);};
  run('off',18);run('off',18);
  assert.equal(AG._state.lastSurvival,.9);
  run('solid/k8/rays',0);
  assert.equal(AG._state.badStreak,0,'a drop across modes is not a bad generation');assert.equal(AG._state.mode,'solid/k8/rays');
  run('solid/k8/rays',0);run('solid/k8/rays',0);
  assert.equal(AG._state.badStreak,0);
  run('off',0);assert.equal(AG._state.badStreak,0);assert.equal(AG._state.lastSurvival,0);
  run('off',0);assert.equal(AG._state.badStreak,0);
});

test('C4: a generation without a learning context but with solid cars is mode unknown',()=>{
  const {AG,archived}=gatesPage('off');AG.setEnabled(true);
  const g=generation('solid/k8/rays');g.learningContext=null;g.collisions={heatSize:8};
  AG.onGenEnd(g);assert.equal(archived.at(-1).collisions,'unknown');
  const n=generation('off');n.learningContext=null;n.popDeathCauses=n.popDeathCauses.map(c=>c===5?0:c);
  AG.onGenEnd(n);assert.equal(archived.at(-1).collisions,'off');
});

test('C4: switching Solid cars with adaptive gates on goes to the new mode\'s layout, or the baseline',()=>{
  const RAYS='solid/k8/rays',page=gatesPage('off'),{AG,road,storage,window}=page;
  let next='off';window.DriverLearning={context:{collisions:'off'},collisionMode:()=>next};
  AG.setEnabled(true);
  const geo=AG.geometrySignature(),key='vv_adapt_gates_'+geo,baseline=plain(road.roadEditor.checkPointListEditor);
  const solidLayout=[[{x:5,y:2},{x:5,y:98}],[{x:130,y:2},{x:130,y:98}],[{x:230,y:2},{x:230,y:98}],[{x:330,y:2},{x:330,y:98}],[{x:430,y:2},{x:430,y:98}]];
  storage.set(key+'|'+RAYS,JSON.stringify({best:{survival:.5,fitness:3,cps:solidLayout,geometrySig:geo},ring:[]}));
  // A layout adapted in normal driving.
  road.roadEditor.checkPointListEditor[1]=[{x:111,y:2},{x:111,y:98}];
  next=RAYS;assert.equal(AG.onCollisionsChange(),true);
  assert.deepEqual(plain(road.roadEditor.checkPointListEditor),solidLayout,'the new mode\'s best layout');
  assert.equal(AG._state.mode,RAYS);assert.equal(AG._state.lastSurvival,null);
  // Back to normal driving with nothing remembered there: the baseline.
  next='off';AG.onCollisionsChange();
  assert.deepEqual(plain(road.roadEditor.checkPointListEditor),baseline);
  assert.match(AG.getStatus().status,/Solid cars off · baseline gates/);
  // Adaptive gates off: the layout is left alone.
  AG.setEnabled(false);road.roadEditor.checkPointListEditor[1]=[{x:111,y:2},{x:111,y:98}];
  next=RAYS;assert.equal(AG.onCollisionsChange(),false);
  assert.equal(road.roadEditor.checkPointListEditor[1][0].x,111);
});

test('C4: a start-line pile-up never lets a handful of survivors prune gates',()=>{
  // 500 cars: 494 die by contact before gate 1, 6 finish all 5 gates. The
  // Kaplan-Meier rates are all 1 (the gates look clear, so nothing moves),
  // but pruning needs shares of all 500 cars.
  const {AG}=gatesPage('solid/k8/rays');AG.setEnabled(true);
  const N=500,cps=Int16Array.from({length:N},(_,i)=>i<494?0:5),causes=Int8Array.from({length:N},(_,i)=>i<494?5:4);
  const xy=Float32Array.from({length:N*2},(_,i)=>(i>>1)<494?(i%2?50:300+(i>>1)):NaN);
  for(let g=0;g<6;g++){
    AG.onGenEnd({popN:N,popDeathXY:xy,popDeathCauses:causes,popCheckpoints:cps,popStillAlive:6,fitness:5,learningContext:{collisions:'solid/k8/rays'}});
    assert.match(AG.getStatus().status,/clearing gates/,AG.getStatus().status);
  }
  assert.equal(AG.getStatus().removeCount,0);assert.equal(AG.getStatus().nudgeCount,0,'no nudge without evidence');
});

test('C4: outside training (phases 1-3) a Solid cars switch leaves the gates alone',()=>{
  const page=gatesPage('off',{phase:2}),{AG,road,window}=page;
  let next='off';window.DriverLearning={context:null,collisionMode:()=>next};
  AG.setEnabled(true);
  road.roadEditor.checkPointListEditor[1]=[{x:111,y:2},{x:111,y:98}];   // an edit in progress
  next='solid/k8/rays';assert.equal(AG.onCollisionsChange(),false);
  assert.equal(road.roadEditor.checkPointListEditor[1][0].x,111);
  assert.equal(AG._state.mode,'solid/k8/rays');
});

test("C4: mode 'unknown' recalls and remembers no layout",()=>{
  const {AG,road,storage,setHits}=gatesPage('off');AG.setEnabled(true);
  const geo=AG.geometrySignature(),layout=[[{x:5,y:2},{x:5,y:98}],[{x:130,y:2},{x:130,y:98}],[{x:230,y:2},{x:230,y:98}],[{x:330,y:2},{x:330,y:98}],[{x:430,y:2},{x:430,y:98}]];
  setHits([{cps:layout,geometrySig:geo,similarity:.95,survival:.9,collisions:'unknown'}]);
  const g=generation('solid/k8/rays');g.learningContext=null;g.collisions={heatSize:8};
  const memories=()=>[...storage.keys()].filter(k=>k.startsWith('vv_adapt_gates_'));
  const before=memories();
  AG.onGenEnd(g);
  assert.notDeepEqual(plain(road.roadEditor.checkPointListEditor),layout,'a pre-C4 contact map is not applied');
  assert.deepEqual(memories(),before,'nothing remembered under unknown');
});


test('C4: a gate is pruned only when a fifth of all cars reached the gate before it',()=>{
  // 100 cars: 80 die by contact before gate 1, 1 at the walls after gate 1,
  // 19 finish. Every gate after gate 2 is passed by every car at risk, but
  // only 19 of the 100 cars reached them: nothing is redundant.
  const {AG}=gatesPage('solid/k8/rays');AG.setEnabled(true);
  const N=100,cps=Int16Array.from({length:N},(_,i)=>i<80?0:i===80?1:5),causes=Int8Array.from({length:N},(_,i)=>i<80?5:i===80?0:4);
  const xy=Float32Array.from({length:N*2},(_,i)=>(i>>1)<=80?(i%2?50:300+(i>>1)):NaN);
  for(let g=0;g<4;g++){
    AG.onGenEnd({popN:N,popDeathXY:xy,popDeathCauses:causes,popCheckpoints:cps,popStillAlive:19,fitness:5,learningContext:{collisions:'solid/k8/rays'}});
    assert.doesNotMatch(AG.getStatus().status,/removed/,AG.getStatus().status);
  }
  assert.equal(AG.getStatus().removeCount,0);
});

test('C4: a few survivors of a pile-up in mid-course never prune the gate after it',()=>{
  // 100 cars: 10 die at a wall before gate 2, 85 by contact after gate 2,
  // 5 finish. Gate 3 is passed by all 5 cars at risk, but by 5 of the 90
  // cars that reached gate 2: it is not redundant.
  const {AG}=gatesPage('solid/k8/rays');AG.setEnabled(true);
  const N=100,cps=Int16Array.from({length:N},(_,i)=>i<10?1:i<95?2:5),causes=Int8Array.from({length:N},(_,i)=>i<10?0:i<95?5:4);
  const xy=Float32Array.from({length:N*2},(_,i)=>(i>>1)<95?(i%2?50:300+(i>>1)):NaN);
  for(let g=0;g<4;g++){
    AG.onGenEnd({popN:N,popDeathXY:xy,popDeathCauses:causes,popCheckpoints:cps,popStillAlive:5,fitness:5,learningContext:{collisions:'solid/k8/rays'}});
    assert.doesNotMatch(AG.getStatus().status,/removed/,AG.getStatus().status);
  }
  assert.equal(AG.getStatus().removeCount,0);
});


// X4 (docs/plan/cloud-brain.md): layouts from everyone's crash map.
const alive=(mode,n)=>({...generation(mode),popStillAlive:n});        // survival n / 20
// 100 cars (survival in steps of 0.01): 50 crash near (300, 50), the rest reach gate 2.
function hundred(mode,n){
  const N=100,xy=new Float32Array(N*2),causes=new Int8Array(N),popCheckpoints=new Int16Array(N);
  for(let i=0;i<N;i++){causes[i]=i%3;xy[i*2]=i<50?300+i:NaN;xy[i*2+1]=i<50?50:NaN;popCheckpoints[i]=i<50?1:2;}
  return {popN:N,popDeathXY:xy,popDeathCauses:causes,popCheckpoints,popStillAlive:n,fitness:2,learningContext:{collisions:mode}};
}
const sharedLayout=x=>[[{x,y:2},{x,y:98}],[{x:x+100,y:2},{x:x+100,y:98}],[{x:x+200,y:2},{x:x+200,y:98}],[{x:x+300,y:2},{x:x+300,y:98}],[{x:x+400,y:2},{x:x+400,y:98}]];
// A page whose bridge recalls what it archived (local hits) and the shared layouts given.
function livePage(globals={}){
  const page=gatesPage('off',globals);
  page.AG.setEnabled(true);
  const walls=page.AG.wallSignature();
  const shared=(cps,extra={})=>({cps,geometrySig:walls,similarity:.9,survival:.9,collisions:'off',shared:true,...extra});
  const local=()=>page.archived.filter(a=>a.cps).map(a=>({cps:a.cps,geometrySig:a.geometrySig,similarity:.99,survival:a.survival,collisions:a.collisions||'off'}));
  const gen=(n,sharedHits=[],data=alive('off',n))=>{page.setHits([...local(),...sharedHits]);page.AG.onGenEnd(data);};
  return {...page,walls,shared,gen,gates:()=>plain(page.road.roadEditor.checkPointListEditor)};
}

test('X4: shared layouts are for the walls alone, the same signature with adaptive gates on or off',()=>{
  const page=gatesPage('off'),{AG}=page;
  const before=AG.wallSignature();
  assert.equal(AG.geometrySignature(),before,'no baseline yet: the same');
  AG.setEnabled(true);
  assert.notEqual(AG.geometrySignature(),before,'local memory adds the baseline');
  assert.equal(AG.wallSignature(),before);
  AG.setEnabled(false);
  assert.equal(AG.wallSignature(),before);
  // A shared layout under the baseline signature is not for these walls.
  AG.setEnabled(true);
  page.setHits([{cps:sharedLayout(10),geometrySig:AG.geometrySignature(),similarity:.9,survival:.9,collisions:'off',shared:true}]);
  AG.onGenEnd(alive('off',4));
  assert.equal(AG._state.trial,null);
  // Archives carry both.
  assert.equal(page.archived.at(-1).walls,before);
  assert.equal(page.archived.at(-1).geometrySig,AG.geometrySignature());
});

test('X4: a shared layout gets a one-generation trial, unsaved and unarchived; undone without a 3-point rise, then shared layouts wait 10 generations',()=>{
  const p=livePage(),{AG,storage,archived}=p;
  const before=p.gates();
  storage.delete('checkPointList');
  p.gen(5,[p.shared(sharedLayout(10))]);                    // survival 0.25: 0.9 beats it
  assert.deepEqual(p.gates(),sharedLayout(10));
  assert.match(AG.getStatus().status,/applied a shared layout on trial/);
  assert.equal(storage.has('checkPointList'),false,'not saved while on trial');
  assert.equal([...storage.keys()].some(k=>k.startsWith('vv_adapt_gates_')),false,'nor remembered');
  assert.deepEqual(plain(archived.at(-1).cps),before,'the generation\'s map, with the gates it drove');
  assert.equal(archived.at(-1).measured,true);
  const archivedBefore=archived.length;
  // The trial generation: 0.20, no rise. The gates go back, that
  // generation is not archived, the trend goes on from before the trial.
  p.gen(4,[p.shared(sharedLayout(10)),p.shared(sharedLayout(20))]);
  assert.deepEqual(p.gates(),before);
  assert.match(AG.getStatus().status,/shared layout did not help \(survival 20% vs 25%\) · gates restored/);
  assert.equal(archived.length,archivedBefore);
  assert.equal(AG._state.lastSurvival,.25);
  // Shared layouts wait 10 generations; a local one does not.
  for(let g=0;g<9;g++){p.gen(5,[p.shared(sharedLayout(20))]);assert.equal(AG._state.trial,null,'gen '+g);}
  p.gen(5,[p.shared(sharedLayout(20)),p.shared(sharedLayout(30),{shared:false,geometrySig:AG.geometrySignature(),survival:.5})]);
  assert.deepEqual(p.gates(),sharedLayout(30),'a local layout applies while shared ones wait');
  // The 11th: the untried one gets its trial; the tried one never again.
  p.gen(5,[p.shared(sharedLayout(10),{survival:1}),p.shared(sharedLayout(20))]);
  assert.deepEqual(p.gates(),sharedLayout(20));
  p.gen(5);                                                 // it fails too
  // The same walls again (a preset reload, a multiplayer visit): the wait
  // starts over, what was tried and failed is remembered.
  AG.onTrackChange();
  const seen=AG._state.sharedSeen[p.walls];
  assert.deepEqual([AG._state.trial,AG._state.sharedWaitUntil,seen.tried.size,seen.failed.size,seen.fails],[null,0,2,2,2]);
  p.gen(5,[p.shared(sharedLayout(10),{survival:1}),p.shared(sharedLayout(20),{survival:1})]);
  assert.equal(AG._state.trial,null);
  // Other walls have their own.
  p.road.roadEditor.points[1].x+=40;
  AG.onTrackChange();
  const walls=AG.wallSignature();
  assert.notEqual(walls,p.walls);
  p.gen(5,[p.shared(sharedLayout(10),{geometrySig:walls})]);
  assert.ok(AG._state.trial);
  assert.equal(AG._state.sharedSeen[walls].tried.size,1);
});

test('X4: a layout that failed its trial never comes back, not even through the page\'s own archive',()=>{
  // Survival 0.5 puts the shared layout on trial; 0.2 fails it; later
  // generations at 0.45, 0.3, 0.1 would take any local layout archived at 0.5.
  const p=livePage(),{AG,archived}=p;
  const S=sharedLayout(10),key=JSON.stringify(S);
  p.gen(10,[p.shared(S,{survival:.95})]);
  assert.deepEqual(p.gates(),S);
  p.gen(4);
  assert.notDeepEqual(p.gates(),S);
  for(const n of [9,6,2]){
    p.gen(n);
    assert.notDeepEqual(p.gates(),S,'survival '+n/20);
    assert.ok(archived.every(a=>JSON.stringify(plain(a.cps))!==key),'never archived');
  }
  // Even if the archive held it (an older page), it is not taken again.
  p.setHits([{cps:S,geometrySig:AG.geometrySignature(),similarity:.99,survival:.9,collisions:'off'}]);
  AG.onGenEnd(alive('off',2));
  assert.notDeepEqual(p.gates(),S);
});

test('X4: a shared layout kept after its trial is saved, archived and shared as the page\'s own',()=>{
  const p=livePage(),{AG,storage,archived}=p;
  const saved=[],set=storage.set.bind(storage);
  storage.set=(k,v)=>{if(k==='checkPointList')saved.push(JSON.parse(v));return set(k,v);};
  p.gen(4,[p.shared(sharedLayout(10))]);
  assert.equal(saved.length,0);
  p.gen(5);                                                 // 0.25 >= 0.2 + 0.03: kept
  assert.deepEqual(saved[0],sharedLayout(10),'saved first, then adapted from as the page\'s own');
  assert.doesNotMatch(AG.getStatus().status,/did not help/);
  assert.equal(AG._state.trial,null);
  assert.ok(archived.some(a=>a.measured&&JSON.stringify(plain(a.cps))===JSON.stringify(sharedLayout(10))&&a.survival===.25));
});

test('X4: a trial is kept on a rise of 3 points or more (0.25 to 0.28, 0.26 to 0.29), not of 2 (to 0.27)',()=>{
  for(const [from,n,kept] of [[25,27,false],[25,28,true],[26,29,true],[38,41,true],[26,28,false]]){
    const p=livePage(),before=p.gates();
    p.gen(from,[p.shared(sharedLayout(10))],hundred('off',from));
    assert.deepEqual(p.gates(),sharedLayout(10));
    p.gen(n,[],hundred('off',n));
    assert.equal(/did not help/.test(p.AG.getStatus().status),!kept,p.AG.getStatus().status);
    if(!kept)assert.deepEqual(p.gates(),before);
  }
});

test('X4: after 3 failed trials a track tries no more shared layouts',()=>{
  const p=livePage(),{AG}=p;
  for(let k=0;k<3;k++){
    p.gen(4,[p.shared(sharedLayout(10+k))]);
    assert.ok(AG._state.trial,'trial '+k);
    p.gen(4);
    for(let g=0;g<10;g++)p.gen(4);
  }
  assert.equal(AG._state.sharedSeen[p.walls].fails,3);
  p.gen(4,[p.shared(sharedLayout(50))]);
  assert.equal(AG._state.trial,null);
});

test('X4: a shared layout this page could not have made is never tried',()=>{
  const page=gatesPage('off'),{AG,road}=page;
  AG.setEnabled(true);
  const walls=AG.wallSignature();
  const hit=cps=>({cps,geometrySig:walls,similarity:.9,survival:.9,collisions:'off',shared:true});
  const many=Array.from({length:8},(_,i)=>[{x:10+i*50,y:2},{x:10+i*50,y:98}]);   // 5 baseline gates: at most 7
  const off=sharedLayout(10).map((g,i)=>i===2?[{x:-5,y:2},g[1]]:g);
  const far=sharedLayout(10).map((g,i)=>i===1?[g[0],{x:g[1].x,y:1800.5}]:g);
  const wide=sharedLayout(10).map((g,i)=>i===1?[g[0],{x:3200.5,y:g[1].y}]:g);
  const nan=sharedLayout(10).map((g,i)=>i===0?[{x:NaN,y:2},g[1]]:g);
  for(const bad of [many,off,far,wide,nan,[sharedLayout(10)[0]],sharedLayout(10).map(g=>[g[0]])]){
    page.setHits([hit(bad)]);
    AG.onGenEnd(alive('off',4));
    assert.match(AG.getStatus().status,/none beat survival/,JSON.stringify(bad));
    assert.equal(AG._state.trial,null);
  }
  // Seven gates (as many as adaptive gates may grow to), ends on the canvas's edge: tried.
  const edge=many.slice(0,7).map((g,i)=>i===6?[{x:3200,y:0},{x:3200,y:1800}]:g);
  page.setHits([hit(edge)]);
  AG.onGenEnd(alive('off',4));
  assert.deepEqual(plain(road.roadEditor.checkPointListEditor),edge);
});

test('X4: gates adaptive gates moved to are archived as not measured; the generation\'s own are',()=>{
  const page=gatesPage('off'),{AG,archived}=page;
  AG.setEnabled(true);
  for(let g=0;g<3;g++)AG.onGenEnd(generation('off'));
  const byGen=archived.map(a=>a.measured);
  assert.ok(byGen.includes(true)&&byGen.includes(false),JSON.stringify(byGen));
  assert.equal(archived[0].measured,true);
});

test('X4: a trial ends with the page\'s gates back: adaptive gates off, a Solid cars switch, another mode, leaving training, a reset',()=>{
  const ends=[
    ['off',p=>p.AG.setEnabled(false)],
    ['switch',p=>p.AG.onCollisionsChange()],
    ['switch outside training',p=>p.AG.onCollisionsChange(),{phase:3}],
    ['endTrial',p=>assert.equal(p.AG.endTrial(),true)],
    ['another mode',p=>p.AG.onGenEnd(alive('solid/k8',9))],
  ];
  for(const [name,end,globals] of ends){
    const p=livePage(globals),before=p.gates();
    p.gen(4,[p.shared(sharedLayout(10))]);
    assert.deepEqual(p.gates(),sharedLayout(10),name);
    end(p);
    assert.deepEqual(p.gates(),before,name);
    assert.equal(p.AG._state.trial,null,name);
    assert.deepEqual(JSON.parse(p.storage.get('checkPointList')),before,name+': saved back');
  }
  const p=livePage();
  p.gen(4,[p.shared(sharedLayout(10))]);
  p.AG.resetToBaseline();
  assert.equal(p.AG._state.trial,null);
  assert.equal(p.AG.endTrial(),false,'nothing on trial');
});

test('X4: a generation whose gates changed while it drove is archived as not measured (adaptive gates on or off)',()=>{
  const p=livePage(),{AG,archived}=p;
  // The first archive of a generation is its own map (then come the next gates').
  const own=()=>{const at=archived.length;return ()=>archived[at].measured;};
  let first=own();p.gen(4);
  assert.equal(first(),true);
  AG.resetToBaseline();                                     // mid-generation
  first=own();p.gen(4);
  assert.equal(first(),false,'the generation drove other gates');
  assert.equal(AG.gatesChangedLastGen(),true);
  first=own();p.gen(4);
  assert.equal(first(),true,'the next one drove these');
  assert.equal(AG.gatesChangedLastGen(),false);
  // Off: main.js's passive archive asks after onGenEnd.
  p.gen(4,[p.shared(sharedLayout(20))]);
  assert.ok(AG._state.trial);
  AG.setEnabled(false);                                     // the trial ends mid-generation
  AG.onGenEnd(alive('off',4));
  assert.equal(AG.gatesChangedLastGen(),true);
  AG.onGenEnd(alive('off',4));
  assert.equal(AG.gatesChangedLastGen(),false);
});

test('X4: Back and Customize Track end a trial before phase 3 saves the track',async()=>{
  const buttons=await readFile(new URL('../AI-Car-Racer/buttonResponse.js',import.meta.url),'utf8');
  for(const leave of ['backPhase','customizeTrack']){
    const p=livePage(),{context,road,storage}=p,before=p.gates();
    Object.assign(road.roadEditor,{checkPointModeChange(){},editModeChange(){}});
    road.getTrack=()=>{};
    p.window.__rvBridge.endPhase4Trajectory=()=>{};
    Object.assign(context,{phase:4,phaseToLayout(){},embedCurrentTrack(){}});
    vm.runInContext(buttons,context);
    p.gen(4,[p.shared(sharedLayout(10))]);
    assert.deepEqual(p.gates(),sharedLayout(10));
    vm.runInContext(leave+'()',context);
    while(context.phase<3)vm.runInContext('nextPhase()',context);
    assert.equal(context.phase,3,leave);
    assert.deepEqual(JSON.parse(storage.get('checkPointList')),before,leave+': the page\'s gates saved');
    assert.equal(p.AG._state.trial,null);
  }
});

test('X4: a generation begun with the gates in place is measured; pageGates gives the page\'s own gates during a trial',()=>{
  const p=livePage(),{AG,archived}=p,before=p.gates();
  // Back to the editor ends a trial outside any generation; the next
  // generation begins (main.js performBegin) with the page's gates.
  p.gen(4,[p.shared(sharedLayout(10))]);
  assert.deepEqual(plain(AG.pageGates()),before,'what a multiplayer visit comes back to');
  AG.endTrial();
  assert.equal(AG.pageGates(),null);
  AG.onGatesSent();
  const at=archived.length;
  p.gen(4);
  assert.equal(archived[at].measured,true);
  // A shared layout claiming 0.29 is chosen at 0.26 (in whole cars, as it would be kept).
  const q=livePage();
  q.gen(26,[q.shared(sharedLayout(20),{survival:.29})],hundred('off',26));
  assert.deepEqual(q.gates(),sharedLayout(20));
});
