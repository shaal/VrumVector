import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {LearningCoach,buildPopulation,cleanContext,contextKey,matchContext,selectDiverse,offspringFeedback,qualityFromFitness,mergeEvaluations,evaluationFor} from '../AI-Car-Racer/learning/policy.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';
import {Simulation} from './helpers/simulation.mjs';
import {CircuitJournal} from '../AI-Car-Racer/sona/journal.js';
import {allocateVectorId,findIdenticalVector} from '../AI-Car-Racer/archive/identity.js';

const fixture=vm.createContext({});
vm.runInContext(await readFile(new URL('../AI-Car-Racer/driver/profiles.js',import.meta.url),'utf8'),fixture);
const profiles=fixture.DriverProfiles;
const brain=value=>new Float32Array(244).fill(value);
const car=(profile='balanced')=>({driverProfile:profile,maxSpeed:15,speed:9,height:50,breakAccel:.25,
  sensor:{rayLength:400,readings:Array(7).fill(null)},controls:{forward:true,left:false,right:false,reverse:false},checkPointsCount:1,laps:0,damaged:false});
const context=cleanContext({profile:'careful',track:'rectangle',maxSpeed:15,traction:.5,seconds:20});

test('balanced preserves exact neural outputs; unknown profiles are safe',()=>{
  const output=[1,0,1,0];assert.equal(profiles.apply(car(),output),output);
  assert.equal(profiles.get('__proto__').id,'balanced');assert.equal(profiles.get('unknown').id,'balanced');
});
test('careful and calm brake sooner, while wild permits more speed',()=>{
  const outputs=[1,0,0,0];
  assert.deepEqual(Array.from(profiles.apply(car('careful'),outputs)),[0,0,0,1]);
  assert.deepEqual(Array.from(profiles.apply(car('calm'),outputs)),[0,0,0,1]);
  assert.deepEqual(Array.from(profiles.apply(car('wild'),outputs)),outputs);
  const danger=car('careful');danger.speed=4;danger.sensor.readings[3]={offset:.09};
  assert.equal(profiles.apply(danger,outputs)[3],1);
  danger.driverProfile='reckless';assert.deepEqual(Array.from(profiles.apply(danger,outputs)),outputs);
});
test('style breaks progress ties but cannot outweigh a checkpoint or reward parking',()=>{
  const a=car('careful'),b=car('reckless');b.checkPointsCount=2;b.damaged=true;
  assert.ok(profiles.rank(b,5)>profiles.rank(a,5));
  a.checkPointsCount=0;assert.equal(profiles.rank(a,5),0);
  a.checkPointsCount=1;assert.ok(profiles.rank(a,5)>1&&profiles.rank(a,5)<2);
  a.driverProfile='balanced';assert.equal(profiles.rank(a,5),1);
});
test('manual input overrides a style-filtered AI brake and steering command',async()=>{
  const document=new EventTarget(),window=new EventTarget();
  const box=vm.createContext({document,window,AbortController});
  vm.runInContext(await readFile(new URL('../AI-Car-Racer/controls.js',import.meta.url),'utf8')+'\nglobalThis.Controls=Controls;',box);
  const controls=new box.Controls('WASD');controls.setAI([0,1,0,1]);
  for(const key of ['w','d']){const event=new Event('keydown');Object.defineProperty(event,'key',{value:key});document.dispatchEvent(event);}
  assert.equal(controls.forward,true);assert.equal(controls.reverse,false);assert.equal(controls.right,true);assert.equal(controls.left,false);controls.dispose();
});
test('an incumbent is copied exactly and cannot regress after a worse generation',()=>{
  const coach=new LearningCoach();coach.setContext(context);
  coach.record({fitness:6,styleScore:.4,popN:5,popStillAlive:2},brain(.2),'winner');
  coach.record({fitness:3,styleScore:1,popN:5,popStillAlive:1},brain(.8),'loser');
  assert.equal(coach.incumbent.id,'winner');
  const batch=buildPopulation({N:20,incumbent:coach.incumbent,plan:coach.plan(.22),random:seededRandom('population')});
  assert.deepEqual(batch.flat.slice(0,244),brain(.2));assert.equal(batch.kinds[0],'elite');
  assert.equal(batch.counts.archive_recall+batch.counts.localStorage_prior+batch.counts.random_init,20);
});
test('one- and two-car populations still explore instead of cloning forever',()=>{
  const incumbent={vector:brain(.2),fitness:2,id:'seed'};
  for(const N of [1,2,3,4,5]){
    const batch=buildPopulation({N,incumbent,plan:{mutation:.2,novel:.1,round:2,stagnant:0},random:seededRandom(N)});
    assert.ok(batch.kinds.includes('mutation'));assert.ok(batch.flat.every(Number.isFinite));
    if(N>1)assert.deepEqual(batch.flat.slice(0,244),incumbent.vector);
    else assert.notDeepEqual(batch.flat,incumbent.vector);
  }
  const recalled={vector:brain(.8),fitness:1,id:'older-memory'};
  const pair=buildPopulation({N:2,seeds:[recalled],incumbent,plan:{mutation:.2,novel:.1,round:2},random:seededRandom('pair')});
  assert.equal(pair.parents[1],'seed','The only challenger refines the champion even when other memories are recalled');
});
test('adaptive exploration escalates on a plateau, recovers on progress, and can be disabled',()=>{
  const coach=new LearningCoach();coach.setContext(context);
  for(let i=0;i<12;i++)coach.record({fitness:2,styleScore:0,popN:2,popStillAlive:1},brain(.1));
  assert.equal(coach.plan(.2,true).stage,'breakthrough');assert.ok(coach.plan(.2,true).mutation>.2);
  assert.equal(coach.plan(.2,false).mutation,.2);
  coach.record({fitness:3,styleScore:0,popN:2,popStillAlive:1},brain(.2));
  assert.equal(coach.plan(.2,true).stage,'refine');assert.equal(coach.stagnant,0);
});
test('context changes reset the champion and history; retrieval favors matching styles and physics',()=>{
  const coach=new LearningCoach();coach.setContext(context);coach.record({fitness:9,popN:1,popStillAlive:1},brain(.4));
  coach.setContext({...context,profile:'wild'});assert.equal(coach.incumbent,null);assert.equal(coach.history.length,0);
  assert.notEqual(contextKey(context),contextKey({...context,seconds:40}));
  const exact=matchContext({learningContext:context},context);
  assert.equal(exact.exact,true);assert.equal(exact.factor,1);
  assert.ok(matchContext({learningContext:{...context,profile:'reckless'}},context).factor<1);
  assert.match(matchContext({},context).label,/unverified/);
});
test('deduplicated brains keep separate bounded evaluations for each profile and track',()=>{
  const careful={fitness:4,learningContext:context},wild={fitness:8,learningContext:{...context,profile:'wild'}};
  let meta=mergeEvaluations(careful,wild);
  assert.equal(evaluationFor(meta,context).fitness,4);
  assert.equal(evaluationFor(meta,wild.learningContext).fitness,8);
  meta=mergeEvaluations(meta,{...careful,fitness:5});assert.equal(meta.evaluations.length,2);
  assert.equal(evaluationFor(meta,context).fitness,5);
  for(let i=0;i<30;i++)meta=mergeEvaluations(meta,{fitness:i,learningContext:{...context,track:`track-${i}`}});
  assert.equal(meta.evaluations.length,20);
  const legacy=mergeEvaluations({fitness:3,trackId:'legacy'},wild);
  assert.equal(evaluationFor(legacy,{...context,profile:'balanced'}).learningContext,null);
});
test('archive identity preserves restored IDs and never overwrites a hash collision',()=>{
  const vector=brain(.2),other=brain(.3),mirror=new Map([['vec_0',{vector}]]);
  assert.equal(findIdenticalVector(mirror,vector),'vec_0');
  assert.equal(findIdenticalVector(mirror,other),null);
  const id=allocateVectorId('brain',other,mirror);assert.notEqual(id,'vec_0');
  mirror.set(id,{vector});const collision=allocateVectorId('brain',other,mirror);
  assert.notEqual(collision,id);assert.equal(mirror.get('vec_0').vector,vector);
});
test('diverse memory selection keeps the strongest and removes exact duplicate brains',()=>{
  const a=brain(.2),b=Float32Array.from(a,(v,i)=>i%2?-v:v);
  const seeds=selectDiverse([{id:'best',vector:a,score:1},{id:'copy',vector:a,score:.99},{id:'different',vector:b,score:.98}],3);
  assert.deepEqual(seeds.map(s=>s.id),['best','different']);
});
test('offspring feedback is based on each parent’s actual descendants and permits negative evidence',()=>{
  assert.equal(offspringFeedback({meanFitness:8,count:4},4),1);
  assert.equal(offspringFeedback({meanFitness:1,count:3},4),-.75);
  assert.equal(offspringFeedback({meanFitness:1,count:3},undefined),null);
  assert.equal(offspringFeedback({meanFitness:Infinity,count:3},4),null);
});
test('zero progress is never marked as successful SONA learning',()=>{
  assert.equal(qualityFromFitness(0),0);assert.equal(qualityFromFitness(-5),0);assert.equal(qualityFromFitness(NaN),0);
  assert.ok(qualityFromFitness(10)>qualityFromFitness(2));assert.ok(qualityFromFitness(100)<1);
});
test('circuit replay journal is bounded, validates data, and preserves successful examples',()=>{
  const journal=new CircuitJournal(2,3);
  assert.equal(journal.remember([1,0,0],0),false);
  assert.equal(journal.remember([0,0,0],.5),false);
  assert.equal(journal.remember([NaN,0,0],.5),false);
  journal.remember([1,0,0],.7);journal.remember([1,0,0],.2);
  assert.equal(journal.examples.length,1);assert.equal(journal.examples[0].quality,.7);
  journal.remember([0,1,0],.4);journal.remember([0,0,1],.5);
  assert.equal(journal.examples.length,2);
  const restored=new CircuitJournal(2,3);restored.restore(journal.serialize());
  assert.deepEqual(restored.examples,journal.examples);
  restored.restore({version:1,examples:[{vector:[1,2],quality:1}]});assert.equal(restored.examples.length,0);
});
test('styles change actual driving with the same neural network and unchanged physics',()=>{
  const constant=brain(0);constant.set([-1,1,1,1],176);
  const speeds={};
  for(const profile of ['balanced','calm','careful','reckless']){
    const sim=new Simulation({profile});sim.begin(constant);
    // A long open straight isolates throttle decisions from wall collisions.
    const c=sim.cars[0];c.x=1600;c.y=1500;c.angle=0;
    sim.road.borders=[];sim.road.checkPointList=[];sim.road.borderGrid=null;sim.road.cpGrid=null;
    sim.run(2.5);speeds[profile]=c.speed;
    assert.equal(c.maxSpeed,15);assert.equal(c.acceleration,.3);
  }
  assert.ok(speeds.careful<speeds.calm&&speeds.calm<speeds.balanced,JSON.stringify(speeds));
  assert.equal(speeds.reckless,speeds.balanced);
});
test('stopping mid-drift with steering held never corrupts the car position',()=>{
  const sim=new Simulation(),flat=brain(0);flat.set([1,-1,1,1],176);sim.begin(flat);
  const c=sim.cars[0];c.slide=true;c.speed=.05;c.velocity={x:.05,y:0};c.controls.left=true;
  sim.road.borders=[];sim.road.checkPointList=[];sim.road.borderGrid=null;sim.road.cpGrid=null;
  c.update([],[]);assert.equal(c.speed,0);assert.equal(c.slide,true);
  for(let i=0;i<20;i++)c.update([],[]);
  assert.ok([c.x,c.y,c.speed,c.angle,c.velocity.x,c.velocity.y].every(Number.isFinite));
  assert.equal(c.speed,0);
});
test('real simulation preserves the best progress across genetic generations',()=>{
  const sim=new Simulation({track:'Triangle',seed:'learning-regression'}),coach=new LearningCoach();
  coach.setContext({...context,profile:'balanced',track:'Triangle',seconds:3});
  const random=seededRandom('genetic-regression');let previous=0;
  for(let generation=0;generation<5;generation++){
    const batch=buildPopulation({N:12,incumbent:coach.incumbent,plan:coach.plan(.22),random});
    sim.begin(batch.flat);const result=sim.run(3);coach.record(result,result.vector);
    assert.ok(coach.incumbent.fitness>=previous);previous=coach.incumbent.fitness;
  }
  assert.equal(coach.rounds,5);assert.ok(previous>=1);
});
