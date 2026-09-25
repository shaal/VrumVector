// Crash-map retrieval must report true cosine similarity, so the adaptive-gate
// threshold means what its comment says. Uses the vendored browser WASM.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {similarityFromDistance} from '../AI-Car-Racer/archive/similarity.js';
import {crashLayoutFromHit} from '../AI-Car-Racer/archive/crashRecall.js';
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
