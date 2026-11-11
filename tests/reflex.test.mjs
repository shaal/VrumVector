// Issue #62: the hand-written reflex brain and its generation-0 seed.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Simulation} from './helpers/simulation.mjs';
import {reflexBrain,reflexSeedEnabled,REFLEX_SEED_DEFAULT,reflexReinjectEnabled,REFLEX_REINJECT_DEFAULT} from '../AI-Car-Racer/learning/reflex.js';
import {buildPopulation,reinjectDue,LearningCoach} from '../AI-Car-Racer/learning/policy.js';
import {runTrialArm} from '../AI-Car-Racer/learning/trial.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';
import {brainProblem,LIMITS} from '../AI-Car-Racer/cloud/wire.js';

const drive=(track,seconds=20)=>{const sim=new Simulation({track,seed:'reflex-test'});sim.begin(reflexBrain());return sim.run(seconds);};

test('the reflex brain fills the [10,16,4] layout and reacts the right way round',()=>{
  const flat=reflexBrain();
  assert.equal(flat.length,244);assert.ok(flat.every(Number.isFinite));
  // The shared cloud brain refuses weights past its limit; the reflex must fit.
  assert.equal(brainProblem(flat),null);assert.ok(flat.every(v=>Math.abs(v)<=LIMITS.maxWeight));
  // Decode with the game's own network.js (the same loader the simulators use).
  const sim=new Simulation({track:'Rectangle',seed:'reflex-layout'});sim.begin(flat);
  const brain=sim.cars[0].brain;
  assert.equal(JSON.stringify(brain.levels.map(l=>[l.inputCount,l.outputCount])),"[[10,16],[16,4]]");
  vm.runInContext('globalThis.NN=NeuralNetwork',sim.scope);
  const out=inputs=>Array.from(sim.scope.NN.feedForward(inputs,brain));
  // Inputs: rays 0..6 (1 - offset, ray 0 on the `left` side), speed, lf, lr.
  // Outputs: forward, left, right, reverse.
  assert.deepEqual(out([0,0,0,0,0,0,0,.5,0,0]),[1,0,0,0],'open road: drive straight');
  assert.deepEqual(out([.8,.8,.8,0,0,0,0,.5,0,0]).slice(1,3),[0,1],'wall on the left: turn right');
  assert.deepEqual(out([0,0,0,0,.8,.8,.8,.5,0,0]).slice(1,3),[1,0],'wall on the right: turn left');
  const close=out([0,0,0,.9,0,0,0,1,0,0]);
  assert.equal(close[0],0,'wall ahead: lift');assert.equal(close[3],1,'wall ahead at speed: brake');
  assert.equal(out([0,0,0,0,0,0,0,.5,0,.05])[2],1,'next gate to the right: turn right');
});

test('the reflex brain drives: passes gates on Rect and Tri without training',()=>{
  const rect=drive('Rectangle'),tri=drive('Triangle');
  // Frozen tuning reaches Rect 10 (one lap) and Tri 9 (every gate, no lap) at 20 s.
  assert.ok(rect.fitness>=5,`Rect progress ${rect.fitness}`);assert.ok(rect.laps>=1,'Rect: at least one lap');
  assert.ok(tri.fitness>=3,`Tri progress ${tri.fitness}`);
});

test('the reflex seed takes slot 0 of a cold start only, and leaves every other car unchanged',()=>{
  const plan={mutation:.22,novel:.1,round:0,stagnant:0};
  const plain=buildPopulation({N:24,plan,random:seededRandom('cold')}),seeded=buildPopulation({N:24,plan,random:seededRandom('cold'),reflex:true});
  assert.deepEqual(Array.from(seeded.flat.slice(0,244)),Array.from(reflexBrain()));
  assert.deepEqual(seeded.flat.slice(244),plain.flat.slice(244),'paired arms share every other car');
  assert.equal(seeded.kinds[0],'reflex');assert.ok(seeded.kinds.slice(1).every(k=>k==='random'));
  assert.deepEqual(seeded.counts,{...plain.counts,reflex:1},'the seed-source tally still sums to N');
  assert.equal(plain.counts.reflex,0);
  // A seed pool or a champion means this is not a cold start: no reflex car.
  const memory={vector:new Float32Array(244).fill(.2),id:'m'};
  const warm=buildPopulation({N:24,seeds:[memory],plan,random:seededRandom('warm'),reflex:true});
  assert.ok(!warm.kinds.includes('reflex'));
  const champ=buildPopulation({N:24,incumbent:{vector:new Float32Array(244).fill(.1),fitness:3},plan,random:seededRandom('warm'),reflex:true});
  assert.ok(!champ.kinds.includes('reflex'));
  assert.equal(buildPopulation({N:1,plan,random:seededRandom('one'),reflex:true}).kinds[0],'reflex');
});

test('runTrialArm passes the reflex option through, and the reflex arm starts ahead on Rect',()=>{
  const arm=reflex=>{const sim=new Simulation({track:'Rectangle',seed:'reflex-arm'});
    return runTrialArm({simulate:flat=>{sim.begin(flat);return sim.run(8);},context:{profile:'balanced',track:'Rectangle',maxSpeed:15,traction:.5,seconds:8},
      random:seededRandom('reflex-arm'),generations:2,population:8,reflex});};
  const a=arm(false),b=arm(true);
  assert.ok(b.history[0]>=drive('Rectangle',8).fitness,'the reflex car is in generation 0');
  assert.ok(b.history[0]>a.history[0],`reflex ${b.history[0]} vs cold ${a.history[0]}`);
});

test('the generation-0 reflex seed is on by default and follows localStorage.reflexSeed',()=>{
  const store=v=>({getItem:k=>k==='reflexSeed'?v:null});
  assert.equal(REFLEX_SEED_DEFAULT,true);
  assert.equal(reflexSeedEnabled(store(null)),true);assert.equal(reflexSeedEnabled(null),true);
  assert.equal(reflexSeedEnabled(store('1')),true);assert.equal(reflexSeedEnabled(store('0')),false);
  assert.equal(reflexSeedEnabled({getItem(){throw Error('blocked');}}),true);
  // Reading localStorage itself can throw (blocked storage).
  const saved=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('SecurityError');}});
  try{assert.equal(reflexSeedEnabled(),true);}
  finally{if(saved)Object.defineProperty(globalThis,'localStorage',saved);else delete globalThis.localStorage;}
});

test('a transfer check gives the reflex car to the fresh arm only, and keys its test on it',async()=>{
  const store=new Map();
  const saved=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)}});
  try{
    const {runTransferCheck,testIdentity,clearTransferGuards}=await import('../AI-Car-Racer/learning/transferCheck.js');
    const posted=[];
    const spawn=()=>{const w={postMessage(m){posted.push(m);setTimeout(()=>w.onmessage({data:{type:'result',id:m.id,arm:m.arm,best:1,area:1,lastMean:0,history:[]}}),0);},terminate(){}};return w;};
    const context={profile:'balanced',track:'rect-geometry',maxSpeed:15,traction:.5,seconds:4};
    const base={context,track:{},profile:'balanced',maxSpeed:15,traction:.5,seconds:4,seeds:[new Float32Array(244).fill(.3)],spawn,trialsPerRun:1};
    await runTransferCheck(base);
    assert.ok(posted.length===2&&posted.every(m=>m.options.reflex===true),'on by default; the memory arm has seeds, so buildPopulation never seeds it');
    clearTransferGuards();posted.length=0;store.set('reflexSeed','0');
    await runTransferCheck(base);
    assert.ok(posted.every(m=>!('reflex' in m.options)),'off: the options are as before #62');
    const settings={mutation:.22,conservative:.65,generations:6,population:24,seconds:4};
    assert.equal(testIdentity([],settings)+'|r1',testIdentity([],{...settings,reflex:true}));
  }finally{if(saved)Object.defineProperty(globalThis,'localStorage',saved);else delete globalThis.localStorage;}
});

// Issue #72: the reflex re-joins a stalled population.
const champion={vector:new Float32Array(244).fill(.1),fitness:3,styleScore:0};
const memory2={vector:new Float32Array(244).fill(.2),id:'m'};
const stalled=stagnant=>({mutation:.22,novel:.1,round:stagnant+3,stagnant});

test('reinjectDue fires on the stagnation flag and then once every M stagnant generations',()=>{
  const due=(s,m)=>reinjectDue({stagnant:s},m);
  assert.deepEqual([0,1,4,5,6,9,10,11,15,20].filter(s=>due(s)),[5,10,15,20],'default M = 5');
  assert.deepEqual([4,5,6,7,8,9].filter(s=>due(s,2)),[5,7,9]);
  assert.deepEqual([3,4,5,6,7].filter(s=>due(s,1)),[5,6,7]);
  // Hostile periods fall back to a sane one; a plan without a count never fires.
  assert.ok(due(5,0)&&due(5,-3)&&due(5,'x')&&due(10,NaN));
  assert.ok(!due(undefined)&&!reinjectDue(null)&&!reinjectDue({stagnant:5.5})&&!reinjectDue({stagnant:'5'}));
  // It reads the coach's own counter.
  const coach=new LearningCoach();coach.setContext({track:'t'});
  for(let g=0;g<6;g++)coach.record({fitness:2,styleScore:0},champion.vector);
  assert.equal(coach.plan(.22,false).stagnant,5);assert.ok(reinjectDue(coach.plan(.22,false)));
});

test('a re-injected reflex takes the first novel slot when stalled, and every other car is unchanged',()=>{
  const build=(stagnant,reinjectReflex,extra={})=>buildPopulation({N:24,incumbent:champion,seeds:[memory2],plan:stalled(stagnant),random:seededRandom('stall'+stagnant),reflex:true,reinjectReflex,...extra});
  for(const s of [5,10]){
    const off=build(s,null),on=build(s,5),slot=on.kinds.indexOf('reflex');
    assert.equal(slot,24-2,'first of floor(24 * .1) = 2 novel slots');assert.equal(off.kinds[slot],'random');
    assert.deepEqual(Array.from(on.flat.slice(slot*244,(slot+1)*244)),Array.from(reflexBrain()));
    const rest=(b)=>Array.from(b.flat).filter((_,j)=>Math.floor(j/244)!==slot);
    assert.deepEqual(rest(on),rest(off),'paired: every other car matches');
    assert.equal(on.kinds.filter(k=>k==='reflex').length,1);assert.equal(on.kinds[0],'elite');
    assert.deepEqual(on.counts,{...off.counts,reflex:1},'the tally still sums to N');
  }
  for(const s of [0,4,6,9]){
    const off=build(s,null),on=build(s,5);
    assert.deepEqual(on.flat,off.flat,`stagnant ${s}: no re-injection`);assert.deepEqual(on.kinds,off.kinds);
  }
  // true means the default period; off (null/false/0) is the build from before #72.
  assert.equal(build(10,true).counts.reflex,1);assert.equal(build(15,true).counts.reflex,1);assert.equal(build(7,true).counts.reflex,0);
  for(const flag of [null,false,0,undefined])assert.deepEqual(build(5,flag).flat,buildPopulation({N:24,incumbent:champion,seeds:[memory2],plan:stalled(5),random:seededRandom('stall5'),reflex:true}).flat);
  // The live explore plan has more novel slots; the reflex is the first of them.
  const explore=buildPopulation({N:20,incumbent:champion,plan:{mutation:.27,novel:.2,round:9,stagnant:5},random:seededRandom('ex'),reinjectReflex:5});
  assert.equal(explore.kinds.indexOf('reflex'),16);
});

test('re-injection leaves the cold start, N = 1 and N = 2 alone',()=>{
  // Cold: the #62 seed only, in slot 0; stagnation cannot add a second one.
  const cold=buildPopulation({N:24,plan:stalled(5),random:seededRandom('c'),reflex:true,reinjectReflex:5});
  assert.equal(cold.counts.reflex,1);assert.equal(cold.kinds[0],'reflex');
  assert.equal(buildPopulation({N:24,plan:stalled(5),random:seededRandom('c'),reinjectReflex:5}).counts.reflex,0);
  // N = 1: the only car is the champion or its mutation; never the reflex.
  for(const s of [5,10])assert.ok(!buildPopulation({N:1,incumbent:champion,plan:{...stalled(s),round:10},random:seededRandom('one'),reinjectReflex:5}).kinds.includes('reflex'));
  // N = 2: slot 0 stays the elite; the reflex may take the novel slot 1 only.
  const two=buildPopulation({N:2,incumbent:champion,plan:{...stalled(5),round:10},random:seededRandom('two'),reinjectReflex:5});
  assert.equal(two.kinds[0],'elite');assert.equal(two.kinds[1],'reflex');
  const twoNoNovel=buildPopulation({N:2,incumbent:champion,plan:{...stalled(5),round:11},random:seededRandom('two'),reinjectReflex:5});
  assert.deepEqual(twoNoNovel.kinds,['elite','mutation']);
});

test('runTrialArm passes reinjectReflex through',()=>{
  let reflexCars=0;
  runTrialArm({simulate:(flat,batch)=>{reflexCars+=batch.counts.reflex;return {fitness:1,styleScore:0,vector:flat.slice(0,244),popN:6,popStillAlive:0};},
    context:{profile:'balanced',track:'t',maxSpeed:15,traction:.5,seconds:4},random:seededRandom('arm'),generations:12,population:20,reinjectReflex:5});
  // Stalled from generation 1: stagnant 5 at generation 6 and 10 at generation 11.
  assert.equal(reflexCars,2);
});

test('re-injection is off by default and follows localStorage.reflexReinject',()=>{
  const store=v=>({getItem:k=>k==='reflexReinject'?v:null});
  assert.equal(REFLEX_REINJECT_DEFAULT,false);
  assert.equal(reflexReinjectEnabled(store(null)),false);assert.equal(reflexReinjectEnabled(null),false);
  assert.equal(reflexReinjectEnabled(store('1')),true);assert.equal(reflexReinjectEnabled(store('0')),false);
  assert.equal(reflexReinjectEnabled({getItem(){throw Error('blocked');}}),false);
});
