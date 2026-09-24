import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {AutoTrainPolicy,autoTrain,PLATEAU_GENERATIONS,BOUNCE_GENERATIONS,START_GATE_CREDIT} from '../AI-Car-Racer/learning/autoTrain.js';
import {TrainingHealth,HEALTH_MODULE_URL,loadHealth} from '../AI-Car-Racer/learning/health.js';
import {Simulation} from './helpers/simulation.mjs';

(await import(HEALTH_MODULE_URL)).initSync({module:await readFile(new URL('../vendor/ruvector/emergent_time_wasm/emergent_time_wasm_bg.wasm',import.meta.url))});
assert.equal(await loadHealth(),true);

const gen=(fitness,laps=0)=>({fitness,laps});
const plateau=(since,state='Stuck')=>({state,sinceProgress:since});
// Drive a policy to Polish and return it.
function inPolish(){const p=new AutoTrainPolicy();p.observe(gen(2));p.observe(gen(9,1));assert.equal(p.phase,'polish');return p;}

test('the plateau length matches the plan; the start gate is worth one checkpoint',()=>{
  assert.equal(PLATEAU_GENERATIONS,20);assert.equal(BOUNCE_GENERATIONS,8);assert.equal(START_GATE_CREDIT,1);
});
test('every car spawns touching the start gate, so a score of 1 stays in Fresh',()=>{
  for(const track of ['Rectangle','Triangle']){
    // An all-zero network never moves and still scores the start gate.
    const sim=new Simulation({track,seed:'auto-train-spawn'});sim.begin(new Float32Array(244));const r=sim.run(1);
    assert.equal(r.fitness,START_GATE_CREDIT,track);
    const p=new AutoTrainPolicy();assert.equal(p.observe(r),null);assert.equal(p.phase,'fresh',track);
  }
});
test('Fresh waits for a checkpoint past the start line, then Grind waits for a lap',()=>{
  const p=new AutoTrainPolicy();
  assert.equal(p.phase,'fresh');for(let i=0;i<5;i++)assert.equal(p.observe(gen(1)),null);
  assert.equal(p.observe(gen(2)),'grind');assert.match(p.reason,/passed a checkpoint/);
  for(let i=0;i<30;i++)assert.equal(p.observe(gen(7)),null,'checkpoints alone never reach Polish');
  assert.equal(p.observe(gen(9,1)),'polish');assert.match(p.reason,/lap/);
});
test('one phase step per generation, even for a lapping car',()=>{
  const p=new AutoTrainPolicy();
  assert.equal(p.observe(gen(12,1)),'grind');assert.equal(p.observe(gen(12,1)),'polish');
});
test('Polish bounces to Grind only after a full plateau in Polish',()=>{
  const p=inPolish();
  // The clock reads Stuck from its second generation; that alone must not bounce.
  for(let since=1;since<PLATEAU_GENERATIONS;since++)assert.equal(p.observe(gen(9,1),plateau(since)),null,`since ${since}`);
  assert.equal(p.observe(gen(9,1),plateau(PLATEAU_GENERATIONS)),'grind');assert.match(p.reason,/Plateau/);
  // Plateau while exploring, and states that read as losing ground, bounce too.
  for(const state of ['NeedsReplan','Contradicting','Collapsing']){
    const q=inPolish();for(let i=1;i<PLATEAU_GENERATIONS;i++)assert.equal(q.observe(gen(9,1),plateau(i,state)),null);
    assert.equal(q.observe(gen(9,1),plateau(PLATEAU_GENERATIONS,state)),'grind',state);
  }
});
test('the state guard: an improving reading never bounces',()=>{
  // Not reached on real traces (the counter resets on every gain); the guard
  // keeps a clock that disagrees with the counter from forcing a bounce.
  const q=inPolish();for(let i=0;i<40;i++)assert.equal(q.observe(gen(9,1),plateau(40,i%2?'Healthy':'Drifting')),null);
});
test('generations before Polish do not count toward its plateau',()=>{
  // A health clock that was not reset still reports the older, longer count.
  const p=inPolish();
  for(let i=1;i<PLATEAU_GENERATIONS;i++)assert.equal(p.observe(gen(9,1),plateau(100+i)),null,`generation ${i} in Polish`);
  assert.equal(p.observe(gen(9,1),plateau(200)),'grind');
});
test('after a bounce Grind explores before a lap returns it to Polish',()=>{
  const p=inPolish();for(let i=1;i<=PLATEAU_GENERATIONS;i++)p.observe(gen(9,1),plateau(i));
  assert.equal(p.phase,'grind');assert.equal(p.bounced,true);
  const text=p.nextStep();
  for(let i=1;i<BOUNCE_GENERATIONS;i++){assert.equal(p.observe(gen(9,1)),null,`grind generation ${i}`);assert.equal(p.nextStep(),text,'the status text does not change every generation');}
  assert.equal(p.observe(gen(9,1)),'polish');
  // A normal Grind (no bounce) still moves at the first lap.
  assert.equal(p.bounced,false);
});
test('without the health clock a plain counter of generations without a new best is used',()=>{
  const p=inPolish();
  p.observe(gen(9,1));p.observe(gen(10,1));// a new best resets the counter
  for(let i=1;i<PLATEAU_GENERATIONS;i++)assert.equal(p.observe(gen(10,1),null,false),null);
  assert.equal(p.observe(gen(8,1),null,false),'grind');
});
test('a loaded clock without a reading (first generation after a context change) never bounces',()=>{
  const p=inPolish();
  for(let i=0;i<40;i++)assert.equal(p.observe(gen(9,1),null,true),null);
  // The next reading decides.
  assert.equal(p.observe(gen(9,1),plateau(PLATEAU_GENERATIONS),true),'grind');
});
test('unusable results are ignored',()=>{
  const p=new AutoTrainPolicy();
  for(const bad of [null,{},{fitness:NaN},{fitness:Infinity,laps:1},{fitness:'3'}])assert.equal(p.observe(bad),null);
  assert.equal(p.phase,'fresh');assert.equal(p.inPhase,0);
});
test('real health snapshots: a flat Polish run bounces after 20 generations without a gain',()=>{
  const champion=new Float32Array(244).fill(.3),health=new TrainingHealth(),p=inPolish();
  // The health clock resets when Polish starts (its round length is a new learning context).
  let bouncedAt=null;
  for(let g=1;g<=40&&bouncedAt===null;g++){
    const snapshot=health.observe({best:9,genBest:9,gates:8,mutation:.05,champion});
    if(p.observe(gen(9,1),snapshot)==='grind')bouncedAt=g;
  }
  assert.equal(bouncedAt,PLATEAU_GENERATIONS+1,'the first Polish generation sets the baseline');
  // Steady gains in Polish never bounce.
  const h2=new TrainingHealth(),q=inPolish();
  for(let g=0;g<40;g++){
    const best=9+Math.floor(g/4),snapshot=h2.observe({best,genBest:best,gates:8,mutation:.05,champion:new Float32Array(244).fill(best/20)});
    assert.equal(q.observe(gen(best,1),snapshot),null,`generation ${g}: ${snapshot?.state}`);
  }
});
test('controller: presets follow the phase, a new track restarts at Fresh, moved gates do not',()=>{
  const applied=[],walls=[[{x:0,y:0},{x:9,y:0},{x:9,y:9}],[{x:-5,y:-5},{x:20,y:-5},{x:20,y:20}]];
  globalThis.window={DriverLearning:{healthState:null}};globalThis.applyTrainingPreset=name=>applied.push(name);globalThis.presentationRunSerial=10;
  globalThis.road={innerList:walls[0],outerList:walls[1],checkPointList:[[{x:1,y:1},{x:2,y:2}]]};
  try{
    assert.equal(autoTrain.onGeneration(gen(5,1)),null,'off: nothing happens');assert.deepEqual(applied,[]);
    autoTrain.setEnabled(true);assert.deepEqual(applied,['fresh']);
    assert.equal(autoTrain.onGeneration(gen(3)),'grind');assert.equal(autoTrain.onGeneration(gen(9,1)),'polish');
    assert.deepEqual(applied,['fresh','grind','polish']);
    // Adaptive gates rewrite checkpoints between generations; the walls stay.
    road.checkPointList=[[{x:3,y:3},{x:4,y:4}]];assert.equal(autoTrain.syncTrack(),false);
    assert.equal(autoTrain.onGeneration(gen(9,1)),null);assert.equal(autoTrain.policy.phase,'polish');
    // New walls: back to Fresh at once, and the generation that ends there is judged in Fresh.
    road={innerList:[{x:1,y:1},{x:8,y:1},{x:4,y:8}],outerList:walls[1],checkPointList:[]};
    assert.equal(autoTrain.syncTrack(),true,'before the panel begins a generation');assert.equal(autoTrain.policy.phase,'fresh');assert.match(autoTrain.policy.reason,/New track/);
    assert.deepEqual(applied.slice(3),['fresh']);assert.equal(autoTrain.syncTrack(),false,'seen once');
    // Found at the end of a generation: restart, and do not judge a run built on the old track and preset.
    road={...road,innerList:[{x:2,y:2},{x:8,y:2},{x:4,y:8}]};
    assert.equal(autoTrain.onGeneration(gen(5)),'fresh');assert.equal(autoTrain.policy.phase,'fresh');assert.equal(autoTrain.policy.inPhase,0);
    // A generation that was already running when the preset changed is not judged.
    assert.equal(autoTrain.onGeneration({...gen(5),runSerial:10}),null);assert.equal(autoTrain.policy.inPhase,0);
    presentationRunSerial=11;assert.equal(autoTrain.onGeneration({...gen(5),runSerial:11}),'grind');
    // A begin queued before the worker was ready keeps the old settings: skip it too.
    globalThis.pendingBegin={N:500};autoTrain.apply('grind');assert.equal(autoTrain.judgeFrom,13);delete globalThis.pendingBegin;
    autoTrain.apply('grind');assert.equal(autoTrain.judgeFrom,12);applied.splice(-2);
    // A knob changed by other code (multiplayer forces 1×) is re-applied; 1× stays while multiplayer is on.
    Object.assign(globalThis,{TRAINING_PRESETS:{grind:{N:600,seconds:15,mutate:.18,conservativeInit:.5,simSpeed:20}},
      batchSize:600,nextSeconds:15,mutateValue:.18,conservativeInit:.5,simSpeed:20});
    const before=applied.length;assert.equal(autoTrain.onGeneration({...gen(5),runSerial:12}),null);assert.equal(applied.length,before,'no drift, no apply');
    simSpeed=1;window.LiveSession={enabled:true};autoTrain.onGeneration({...gen(5),runSerial:12});assert.equal(applied.length,before,'multiplayer keeps 1×');
    window.LiveSession.enabled=false;autoTrain.onGeneration({...gen(5),runSerial:12});assert.deepEqual(applied.slice(before),['grind']);
    autoTrain.setEnabled(false,'off');assert.equal(autoTrain.syncTrack(),false);assert.equal(autoTrain.onGeneration(gen(9,1)),null);
  }finally{for(const key of ['window','applyTrainingPreset','road','presentationRunSerial','TRAINING_PRESETS','batchSize','nextSeconds','mutateValue','conservativeInit','simSpeed'])delete globalThis[key];}
});
