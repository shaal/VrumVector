// "Use my driving" (H4, AI-Car-Racer/learning/demonstrationSeed.js): the
// offer rule, the dataset from one context's recordings, the start-line
// check with the real car, and the seed kind in buildPopulation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Simulation} from './helpers/simulation.mjs';
import {offerKey,sameOffer,cloneDataset,leavesStart,loadBrain,demonstrationSeed,seedPool,SEED_KIND} from '../AI-Car-Racer/learning/demonstrationSeed.js';
import {buildPopulation,cleanContext} from '../AI-Car-Racer/learning/policy.js';
import {demonstrationDataset} from '../AI-Car-Racer/learning/dataset.js';
import {CloneError} from '../AI-Car-Racer/learning/clone.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const context=cleanContext({profile:'balanced',track:'walls-a',maxSpeed:15,traction:.5,seconds:20});
const brain=value=>new Float32Array(244).fill(value);
const plan={mutation:.22,novel:.1,round:1,stagnant:0};
const FORWARD_ONLY=new Float32Array(244);FORWARD_ONLY.set([-1,1,1,1],176);
const REVERSE_ONLY=new Float32Array(244);REVERSE_ONLY.set([1,1,1,-1],176);
const sources=c=>c.archive_recall+c.localStorage_prior+c.random_init+c.demonstration;

test('the offer rule: the same walls, physics, driving style, and Solid cars mode; not the round length',()=>{
  const key=offerKey(context);
  assert.equal(typeof key,'string');
  assert.equal(offerKey({...context,seconds:45}),key,'another round length is the same context for a clone');
  assert.equal(offerKey({...context,version:7}),key);
  for(const other of [{track:'walls-b'},{maxSpeed:10},{traction:.4},{profile:'wild'},{collisions:'solid/k8'},{collisions:'solid/k8/rays'},{collisions:{heatSize:4}}])
    assert.notEqual(offerKey({...context,...other}),key,JSON.stringify(other));
  // A recording made before the recorder saved the mode counts as off.
  const {collisions,...old}=context;
  assert.equal(offerKey(old),key);
  assert.equal(offerKey({...context,collisions:null}),key);
  // The saved label and the settings it came from are the same mode.
  assert.equal(offerKey({...context,collisions:{heatSize:8}}),offerKey({...context,collisions:'solid/k8/rays'}));
  // C4: a recording from C2 (rays saw walls only) is another mode.
  assert.notEqual(offerKey({...context,collisions:'solid/k8'}),offerKey({...context,collisions:'solid/k8/rays'}));
  assert.equal(sameOffer(context,{...context,seconds:5}),true);
  assert.equal(sameOffer(context,{...context,collisions:'solid/k8'}),false);
  // No track key, no offer.
  for(const none of [null,undefined,'x',{},{...context,track:''}])assert.equal(offerKey(none),null,JSON.stringify(none));
  assert.equal(sameOffer(null,null),false);
});

// A stored demonstration: one run of `n` consecutive steps.
function record(id,ctx,{n=400,seed=id}={}){
  const random=seededRandom(String(seed));
  return {id,version:2,context:ctx,samples:n,seconds:n/60,inputs:Float32Array.from({length:n*10},()=>random()),
    keys:Uint8Array.from({length:n},()=>1+(random()<.3?2:0)),sampleSteps:Uint32Array.from({length:n},(_,i)=>i+5),rest:new Uint8Array(n),crashSteps:new Uint32Array(0)};
}

test('the dataset uses only the recordings of this context, and skips a bad one',()=>{
  const here=[record(1,context),record(3,{...context,seconds:40})];
  const elsewhere=[record(2,{...context,track:'walls-b'}),record(4,{...context,collisions:'solid/k8/rays'}),record(5,{...context,profile:'calm'})];
  const bad={...record(6,context),keys:new Uint8Array(3)};
  const {dataset,used,skipped}=cloneDataset([here[0],elsewhere[0],bad,here[1],...elsewhere.slice(1),null,'junk'],context);
  assert.deepEqual(used.map(r=>r.id),[1,3]);
  assert.equal(skipped.length,1);assert.equal(skipped[0].id,6);assert.match(skipped[0].reason,/expected/i);
  const expected=demonstrationDataset(here);
  assert.deepEqual(dataset.inputs,expected.inputs);assert.deepEqual(dataset.keys,expected.keys);assert.deepEqual(dataset.episode,expected.episode);
  assert.equal(dataset.report.options.rest,'label');assert.equal(dataset.report.options.mirror,false,"H2's defaults");
  assert.equal(new Set(dataset.episode).size,2,'one run per recording');
  // Recordings made with Solid cars on are offered only with Solid cars on.
  assert.deepEqual(cloneDataset(elsewhere,{...context,collisions:{heatSize:8}}).used.map(r=>r.id),[4]);
  assert.deepEqual(cloneDataset(elsewhere,context),{dataset:null,used:[],skipped:[]});
  assert.deepEqual(cloneDataset(here,null),{dataset:null,used:[],skipped:[]});
  assert.deepEqual(cloneDataset(undefined,context),{dataset:null,used:[],skipped:[]});
});

test('the start-line check drives the real car: forward and reverse pull away, a network that presses nothing does not',()=>{
  for(const track of ['Rectangle','Triangle']){
    const sim=new Simulation({track,seed:'start-line'}),s=sim.spawn;
    const makeCar=()=>new sim.scope.CarClass(s.x,s.y,30,50,'AI',sim.maxSpeed,s.angle);
    const forward=leavesStart({makeCar,road:sim.road,vector:FORWARD_ONLY});
    assert.equal(forward.leaves,true,track);assert.ok(forward.moved>20);
    assert.equal(leavesStart({makeCar,road:sim.road,vector:REVERSE_ONLY}).leaves,true,`${track}: reverse counts too`);
    const still=leavesStart({makeCar,road:sim.road,vector:new Float32Array(244)});
    assert.deepEqual([still.leaves,still.moved,still.steps,still.crashed],[false,0,180,false],track);
    // A crash stops the check early, and a crashed car that moved has left.
    const crash=leavesStart({makeCar,road:sim.road,vector:FORWARD_ONLY,seconds:60});
    assert.ok(crash.crashed&&crash.steps<3600&&crash.leaves,track);
  }
  const sim=new Simulation({track:'Rectangle'});
  assert.throws(()=>leavesStart({makeCar:()=>null,road:sim.road,vector:new Float32Array(10)}),error=>error instanceof CloneError);
  // loadBrain writes the flat layout the network reads: biases, then weights, per level.
  const car=loadBrain(new sim.scope.CarClass(0,0,30,50,'AI',15,0),Float32Array.from({length:244},(_,i)=>i));
  assert.deepEqual([car.brain.levels[0].biases[0],car.brain.levels[0].weights[0],car.brain.levels[1].biases[0],car.brain.levels[1].weights.at(-1)],[0,16,176,243]);
});

test('a demonstration seed takes the protected elite slot when there is no champion, and its cars are counted',()=>{
  const clone=demonstrationSeed(brain(.3),{recordings:2});
  assert.deepEqual([clone.kind,clone.id,clone.meta.source,clone.meta.recordings],[SEED_KIND,null,'demonstration',2]);
  const memory={vector:brain(-.4),id:'memory-1'};
  for(const N of [1,2,24,500]){
    const batch=buildPopulation({N,seeds:[clone,memory],plan:{...plan,round:0},random:seededRandom('demo'+N)});
    if(N>1){
      assert.deepEqual(batch.flat.slice(0,244),clone.vector,`N=${N}: the clone is the elite`);
      assert.equal(batch.kinds[0],'elite');assert.equal(batch.counts.protected_elite,1);
    }
    assert.equal(sources(batch.counts),N,`N=${N}: every car counts once`);
    assert.ok(batch.counts.demonstration>=1,`N=${N}`);
    assert.equal(batch.parents.slice(0,Math.min(N,2)).every(p=>p===null),true,'the clone has no archive id');
  }
  // 24 cars: the elite and the 11 odd slots are the clone; the 10 even slots
  // from 2 alternate clone and memory; the last 2 are fresh.
  const batch=buildPopulation({N:24,seeds:[clone,memory],plan,random:seededRandom('demo')});
  assert.deepEqual([batch.counts.demonstration,batch.counts.archive_recall,batch.counts.random_init,batch.counts.localStorage_prior],[17,5,2,0]);
  // Without the clone, the same slots were counted as memory or saved drivers.
  const before=buildPopulation({N:24,seeds:[{vector:brain(.3),id:null},memory],plan,random:seededRandom('demo')});
  assert.deepEqual(before.flat,batch.flat,'the kind only changes the counts');
  assert.deepEqual([before.counts.demonstration,before.counts.localStorage_prior,before.counts.archive_recall],[0,17,5]);
});

test('your driving leads the seed pool, after a driver loaded explicitly',()=>{
  const clone=demonstrationSeed(brain(.3)),memory={vector:brain(-.4),id:'memory-1'},saved={vector:brain(.5),id:null};
  const pool=[memory];
  assert.deepEqual(seedPool(pool,clone),[clone,memory]);
  assert.deepEqual(pool,[memory],'the caller\'s pool is not changed');
  assert.deepEqual(seedPool([saved],clone,{forceSaved:true}),[saved,clone]);
  assert.deepEqual(seedPool(pool,null),[memory]);
  assert.deepEqual(seedPool(null,clone),[clone]);
  // In the population, the pool's first seed is the protected elite.
  const batch=buildPopulation({N:24,seeds:seedPool(pool,clone),plan,random:seededRandom('pool')});
  assert.deepEqual(batch.flat.slice(0,244),clone.vector);
});

test('with a champion in this context, the champion keeps the elite slot and the clone joins the pool',()=>{
  const clone=demonstrationSeed(brain(.3)),champion={vector:brain(.7),fitness:9,id:'champion'};
  const batch=buildPopulation({N:24,seeds:[clone],incumbent:champion,plan,random:seededRandom('champ')});
  assert.deepEqual(batch.flat.slice(0,244),champion.vector);
  // The elite and the 11 odd slots are the champion; the 10 even slots from 2 mutate the clone.
  assert.deepEqual([batch.counts.archive_recall,batch.counts.demonstration,batch.counts.random_init],[12,10,2]);
  assert.equal(sources(batch.counts),24);
  assert.equal(batch.parents.filter(p=>p==='champion').length,12);
});

test('a seed must be a whole, finite brain',()=>{
  for(const bad of [null,new Float32Array(10),Float32Array.from({length:244},(_,i)=>i===5?NaN:0)])
    assert.throws(()=>demonstrationSeed(bad),error=>error instanceof CloneError&&error.code==='invalid-data');
  const vector=brain(.1),seed=demonstrationSeed(vector);vector[0]=9;
  assert.equal(seed.vector[0],Math.fround(.1),'the seed keeps its own copy');
});
