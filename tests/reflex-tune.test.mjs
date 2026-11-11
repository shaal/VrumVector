// Issue #70: the per-track reflex tuner and its cold-start hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Simulation} from './helpers/simulation.mjs';
import {reflexBrain,REFLEX_TUNING} from '../AI-Car-Racer/learning/reflex.js';
import {tuneReflex,toVector,fromVector,validTuning,driveScore,TUNING_BOUNDS,TUNE_STRIDES,REFLEX_MAX_WEIGHT,
  applyReflexTuning,tuningTag,pageDrive,cachedTuning,storeTuning,tuningKey,reflexTuneEnabled,REFLEX_TUNE_DEFAULT} from '../AI-Car-Racer/learning/reflexTuner.js';
import {buildPopulation} from '../AI-Car-Racer/learning/policy.js';
import {runTrialArm} from '../AI-Car-Racer/learning/trial.js';
import {testIdentity} from '../AI-Car-Racer/learning/transferCheck.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';
import {brainProblem} from '../AI-Car-Racer/cloud/wire.js';

const simDrive=(track,seconds=20)=>{
  const sim=new Simulation({track,seed:'reflex-tune-test'});
  return (flat,v)=>{sim.scope.SENSOR_STRIDE=TUNE_STRIDES[v]??1;sim.begin(flat);const r=sim.run(seconds);sim.scope.SENSOR_STRIDE=1;
    return {fitness:r.fitness,lastGateFrame:sim.cars[0].lastGateFrame};};
};
const memoryStore=()=>{const data={};return {data,getItem:k=>k in data?data[k]:null,setItem:(k,v)=>{data[k]=String(v);}};};
const context={profile:'balanced',track:'geom-abc',maxSpeed:15,traction:.5,seconds:20,collisions:'off'};

test('the tuning vector round-trips, and every tuning in bounds fits the cloud brain weight limit',()=>{
  assert.deepEqual(fromVector(toVector(REFLEX_TUNING)),{...REFLEX_TUNING,side:[...REFLEX_TUNING.side]});
  assert.ok(validTuning(REFLEX_TUNING),'the fixed tuning is inside the search bounds');
  const keys=Object.keys(TUNING_BOUNDS),random=seededRandom('bounds');
  // Corners (all low, all high) and random points: the brain stays within the limit.
  const points=[keys.map(k=>TUNING_BOUNDS[k][0]),keys.map(k=>TUNING_BOUNDS[k][1])];
  for(let i=0;i<300;i++)points.push(keys.map(k=>TUNING_BOUNDS[k][0]+random()*(TUNING_BOUNDS[k][1]-TUNING_BOUNDS[k][0])));
  for(const p of points){const t=fromVector(p),flat=reflexBrain(t);
    assert.ok(validTuning(t));assert.ok(flat.every(w=>Math.abs(w)<=REFLEX_MAX_WEIGHT));assert.equal(brainProblem(flat),null);}
  // fromVector clamps out-of-bounds values (a Gaussian draw can leave the box).
  assert.ok(validTuning(fromVector(keys.map(()=>1e6))));assert.ok(validTuning(fromVector(keys.map(()=>-1e6))));
  // Hostile or malformed tunings are refused.
  for(const bad of [null,{},{...REFLEX_TUNING,side:[1,1]},{...REFLEX_TUNING,gateGain:40},{...REFLEX_TUNING,steerGain:NaN},{...REFLEX_TUNING,side:'abc'}])
    assert.equal(validTuning(bad),false,JSON.stringify(bad));
});

test('driveScore ranks gates first, then the same gates sooner',()=>{
  assert.ok(driveScore({fitness:3,lastGateFrame:900})>driveScore({fitness:2,lastGateFrame:10}));
  assert.ok(driveScore({fitness:3,lastGateFrame:100})>driveScore({fitness:3,lastGateFrame:900}));
  assert.equal(driveScore({fitness:0,lastGateFrame:0}),0);assert.equal(driveScore(null),0);
});

test('the tuner starts from the fixed tuning, never returns a worse one, and keeps a tie on the default',()=>{
  // A drive that rewards nothing: every candidate ties, so the default wins.
  const flat=tuneReflex({drive:()=>({fitness:1,lastGateFrame:60}),random:seededRandom('flat')});
  assert.deepEqual(toVector(flat.tuning),toVector(REFLEX_TUNING));assert.equal(flat.score,flat.defaultScore);
  // A drive that only the default does well on: the tuner keeps the default.
  const def=reflexBrain();
  const sharp=tuneReflex({drive:f=>({fitness:f.every((v,i)=>v===def[i])?9:1,lastGateFrame:60}),random:seededRandom('sharp')});
  assert.deepEqual(toVector(sharp.tuning),toVector(REFLEX_TUNING));
  // A smooth objective: the tuner moves toward gateGain 0 and steerDeadband .5.
  const target=tuneReflex({drive:f=>({fitness:10-Math.abs(f[16+9*16+2])/4-Math.abs(.5-f[177])*4,lastGateFrame:0}),random:seededRandom('smooth')});
  assert.ok(target.score>target.defaultScore,`${target.score} vs ${target.defaultScore}`);
  assert.ok(target.tuning.gateGain<REFLEX_TUNING.gateGain);
  // A candidate that beats the default on the mean over strides but loses at
  // stride 1 (the leader's stride) is never picked.
  const strideTrap=tuneReflex({drive:(f,v)=>{const isDefault=f.every((x,i)=>x===def[i]);
    return {fitness:isDefault?[10,2,2][v]:[9,9,9][v],lastGateFrame:60};},random:seededRandom('trap')});
  assert.deepEqual(toVector(strideTrap.tuning),toVector(REFLEX_TUNING),'worse at stride 1: the default stays');
  // Same seed, same result.
  const a=tuneReflex({drive:simDrive('Oval',8),random:seededRandom('repeat'),drives:16}),b=tuneReflex({drive:simDrive('Oval',8),random:seededRandom('repeat'),drives:16});
  assert.deepEqual(a.tuning,b.tuning);assert.equal(a.score,b.score);
});

test('the tuner keeps to its drive count and time budget, and always re-scores the finalists',()=>{
  const variants=[];
  const r=tuneReflex({drive:(f,v)=>{variants.push(v);return {fitness:1,lastGateFrame:1};},random:seededRandom('count')});
  assert.equal(r.searched,52);assert.equal(r.drives,r.searched+5*2,'default + 4 finalists, 2 more variants each');
  assert.equal(variants.length,r.drives);assert.deepEqual([...new Set(variants)].sort(),[0,1,2]);
  // A clock that jumps 100 ms per drive and a 250 ms budget: 3 search drives, then the finalists.
  let t=0;const timed=tuneReflex({drive:()=>{t+=100;return {fitness:1,lastGateFrame:1};},now:()=>t,budgetMs:250,random:seededRandom('time')});
  assert.equal(timed.searched,3);assert.equal(timed.drives,3+3*2);
  // A zero budget still scores the default, so the result is the default.
  const none=tuneReflex({drive:()=>({fitness:2,lastGateFrame:1}),budgetMs:0,now:()=>0});
  assert.deepEqual(toVector(none.tuning),toVector(REFLEX_TUNING));
});

test('on a weak preset the tuned reflex passes more gates than the fixed one, at every tuned stride',()=>{
  const drive=simDrive('Oval');
  const r=tuneReflex({drive,random:seededRandom('oval')});
  assert.ok(r.score>r.defaultScore+2,`Oval: tuned ${r.score} vs fixed ${r.defaultScore}`);
  const tuned=reflexBrain(r.tuning),fixed=reflexBrain();
  for(let v=0;v<TUNE_STRIDES.length;v++)assert.ok(drive(tuned,v).fitness>drive(fixed,v).fitness,`stride ${TUNE_STRIDES[v]}`);
});

test('pageDrive (the live hook) scores a car the same way as the Node simulator and restores the globals',()=>{
  const sim=new Simulation({track:'Monza',seed:'page-drive'});
  sim.scope.frameCount=1234;sim.scope.SENSOR_STRIDE=8;
  const drive=pageDrive({makeCar:()=>{const c=new sim.scope.CarClass(sim.spawn.x,sim.spawn.y,30,50,'AI',15,sim.spawn.angle);c.driverProfile='balanced';return c;},
    road:sim.road,seconds:20,scope:sim.scope});
  const reference=simDrive('Monza');
  for(const flat of [reflexBrain(),reflexBrain({gateGain:8,steerGain:2})])for(let v=0;v<3;v++){
    assert.deepEqual(drive(flat,v),reference(flat,v),`variant ${v}`);
    assert.equal(sim.scope.frameCount,1234);assert.equal(sim.scope.SENSOR_STRIDE,8);
  }
  assert.throws(()=>drive(new Float32Array(10),0),/244 values/);
  // A throwing car still restores the globals.
  const broken=pageDrive({makeCar:()=>{throw Error('no car');},road:sim.road,seconds:1,scope:sim.scope});
  assert.throws(()=>broken(reflexBrain(),1),/no car/);assert.equal(sim.scope.SENSOR_STRIDE,8);
});

test('applyReflexTuning changes only the reflex car of a cold start',()=>{
  const plan={mutation:.22,novel:.1,round:0,stagnant:0},tuning=fromVector(toVector({...REFLEX_TUNING,gateGain:4}));
  const cold=buildPopulation({N:12,plan,random:seededRandom('cold'),reflex:true}),plain=buildPopulation({N:12,plan,random:seededRandom('cold'),reflex:true});
  assert.equal(applyReflexTuning(cold,tuning),true);
  assert.deepEqual(Array.from(cold.flat.slice(0,244)),Array.from(reflexBrain(tuning)));
  assert.deepEqual(cold.flat.slice(244),plain.flat.slice(244),'every other car is unchanged');
  const off=buildPopulation({N:12,plan,random:seededRandom('cold')}),before=off.flat.slice();
  assert.equal(applyReflexTuning(off,tuning),false);assert.deepEqual(off.flat,before,'no reflex car: nothing changes');
  const warm=buildPopulation({N:12,seeds:[{vector:new Float32Array(244).fill(.2),id:'m'}],plan,random:seededRandom('w'),reflex:true}),warmBefore=warm.flat.slice();
  assert.equal(applyReflexTuning(warm,tuning),false);assert.deepEqual(warm.flat,warmBefore);
  assert.equal(applyReflexTuning(plain,{...tuning,gateGain:99}),false,'an invalid tuning is refused');
  assert.equal(applyReflexTuning(null,tuning),false);
});

test('runTrialArm passes reflexTuning through, and only to the cold generation 0',()=>{
  const tuning=fromVector(toVector({...REFLEX_TUNING,gateGain:4}));
  const arm=reflexTuning=>{const firsts=[],kinds=[];const sim=new Simulation({track:'Oval',seed:'arm'});
    runTrialArm({simulate:(flat,batch)=>{firsts.push(flat.slice(0,244));kinds.push(batch.kinds[0]);sim.begin(flat);return sim.run(4);},
      context:{profile:'balanced',track:'Oval',maxSpeed:15,traction:.5,seconds:4},
      random:seededRandom('arm'),generations:2,population:4,reflex:true,reflexTuning});return {firsts,kinds};};
  const fixed=arm(null),tuned=arm(tuning);
  assert.deepEqual(Array.from(fixed.firsts[0]),Array.from(reflexBrain()));
  assert.deepEqual(Array.from(tuned.firsts[0]),Array.from(reflexBrain(tuning)));
  // Generation 1 has a champion, so there is no reflex car to tune.
  assert.deepEqual(tuned.kinds,['reflex',fixed.kinds[1]]);assert.notEqual(tuned.kinds[1],'reflex');
});

test('the per-track cache round-trips, refuses bad entries, and survives broken storage',()=>{
  const store=memoryStore(),tuning=fromVector(toVector({...REFLEX_TUNING,gateGain:4}));
  assert.equal(cachedTuning(context,store),null);
  assert.equal(storeTuning(context,{tuning,score:8,defaultScore:1},store),true);
  assert.deepEqual(cachedTuning(context,store),tuning);
  // Another track, physics or style is another key.
  for(const other of [{track:'geom-x'},{maxSpeed:10},{profile:'cautious'},{seconds:30},{collisions:'on'}])
    assert.equal(cachedTuning({...context,...other},store),null,JSON.stringify(other));
  assert.equal(tuningKey(null),null);assert.equal(tuningKey({}),null);
  // A tampered entry is dropped on read.
  const raw=JSON.parse(store.data['vv.reflexTuning']);raw[tuningKey(context)].tuning.gateGain=500;store.data['vv.reflexTuning']=JSON.stringify(raw);
  assert.equal(cachedTuning(context,store),null);
  store.data['vv.reflexTuning']='not json';assert.equal(cachedTuning(context,store),null);
  assert.equal(storeTuning(context,{tuning:{...tuning,gateGain:500}},store),false);
  const broken={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
  assert.equal(cachedTuning(context,broken),null);assert.equal(storeTuning(context,{tuning},broken),false);
  assert.equal(cachedTuning(context,null),null);
  // At most 20 tracks are kept, newest first.
  const many=memoryStore();for(let i=0;i<25;i++)storeTuning({...context,track:'t'+i},{tuning},many);
  assert.equal(Object.keys(JSON.parse(many.data['vv.reflexTuning'])).length,20);
});

test('the reflex tuner flag follows localStorage.reflexTune and the shipped default',()=>{
  const store=v=>({getItem:k=>k==='reflexTune'?v:null});
  assert.equal(reflexTuneEnabled(store(null)),REFLEX_TUNE_DEFAULT);assert.equal(reflexTuneEnabled(null),REFLEX_TUNE_DEFAULT);
  assert.equal(reflexTuneEnabled(store('1')),true);assert.equal(reflexTuneEnabled(store('0')),false);
  assert.equal(reflexTuneEnabled({getItem(){throw Error('blocked');}}),REFLEX_TUNE_DEFAULT);
});

test('a transfer test with a tuned reflex has its own identity',()=>{
  const settings={mutation:.22,conservative:.65,generations:6,population:24,seconds:20,reflex:true};
  const seeds=[new Float32Array(244).fill(.1)],t1=fromVector(toVector({...REFLEX_TUNING,gateGain:4})),t2=fromVector(toVector({...REFLEX_TUNING,gateGain:5}));
  const base=testIdentity(seeds,settings);
  assert.equal(testIdentity(seeds,{...settings,reflexTuning:null}),base,'no tuning: the #62 identity is unchanged');
  assert.notEqual(testIdentity(seeds,{...settings,reflexTuning:t1}),base);
  assert.notEqual(testIdentity(seeds,{...settings,reflexTuning:t1}),testIdentity(seeds,{...settings,reflexTuning:t2}));
  assert.equal(tuningTag(t1),tuningTag(fromVector(toVector(t1))));assert.match(tuningTag(t1),/^[0-9a-f]{8}$/);
});
