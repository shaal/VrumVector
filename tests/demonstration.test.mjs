// Recording human demonstrations (H1): scripted WASD keys drive the real car
// physics and sensors in the Node simulator, and the recorder must log exactly
// the inputs the network saw and the keys that moved the car.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Simulation} from './helpers/simulation.mjs';
import {cleanContext} from '../AI-Car-Racer/learning/policy.js';
import {DemonstrationRecorder,lagPairs,keyBits,INPUT_COUNT,MAX_SAMPLES,MAX_DEMONSTRATIONS,MIN_SAMPLES,STEP_HZ} from '../AI-Car-Racer/learning/demonstration.js';

const NO_KEYS={forward:false,left:false,right:false,reverse:false};
// A key-only wall follower: it laps Rectangle without crashing.
const follow=car=>{
  const x=car.lastInputs;if(!x)return {forward:true};
  const d=(x[0]+x[1]+x[2])-(x[4]+x[5]+x[6]);
  return {forward:x[7]<.35,left:d<-.05,right:d>.05};
};
const hash=value=>{let h=2166136261;for(const c of JSON.stringify(value))h=Math.imul(h^c.charCodeAt(0),16777619);return (h>>>0).toString(16);};
function rig({track='Rectangle',maxSamples}={}){
  const sim=new Simulation({track});
  // WASD controls listen for keys; the simulator has no page.
  Object.assign(sim.scope,{document:new EventTarget(),window:new EventTarget(),AbortController});
  const env={multiplayer:false,simSpeed:1,assist:false,profile:'balanced'},saved=[];
  const newCar=(maxSpeed=15)=>{const s=sim.spawn;return new sim.scope.CarClass(s.x,s.y,30,50,'WASD',maxSpeed,s.angle);};
  const recorder=new DemonstrationRecorder({maxSamples,
    environment:{state:()=>env,
      signature:car=>[car,sim.road.borders,sim.road.checkPointList,car.maxSpeed,car.traction,env.profile],
      snapshot:car=>({context:cleanContext({profile:env.profile,track:hash(sim.road.checkPointList),maxSpeed:car.maxSpeed,traction:car.traction}),
        track:{checkPointList:sim.road.checkPointList}})},
    store:{save:async demonstration=>{saved.push(demonstration);return {id:saved.length,dropped:0,count:saved.length};}}});
  let frame=0;
  // One physics step as main.js runs it: keys, car.update(), then the recorder.
  const step=(car,keys)=>{
    sim.scope.frameCount=++frame;
    if(keys){Object.assign(car.controls.manual,NO_KEYS,keys);car.controls.resolve();}
    const bits=keyBits(car.controls);
    car.update(sim.road.borders,sim.road.checkPointList);
    const inputs=Float32Array.from(car.lastInputs);
    const before=recorder.progress()?.samples;recorder.step(car);
    return {bits,inputs,recorded:recorder.progress()?.samples>before};
  };
  return {sim,env,newCar,recorder,step,saved};
}
const row=(demo,i)=>demo.inputs.slice(i*INPUT_COUNT,(i+1)*INPUT_COUNT);

test('Car.lastInputs is exactly what the network received in the last perception',()=>{
  const {sim,newCar,step}=rig();
  const car=newCar();
  for(let i=0;i<90;i++){
    step(car,follow(car));
    assert.equal(car.lastInputs.length,10);
    assert.deepEqual(car.lastInputs,car.brain.levels[0].inputs);
    assert.equal(car.lastInputs[7],Math.fround(car.speed/car.maxSpeed));
  }
  // AI cars in the trial simulator write it too.
  sim.begin(new Float32Array(244*2).fill(.1));sim.run(1);
  for(const ai of sim.cars)assert.deepEqual(ai.lastInputs,ai.brain.levels[0].inputs);
});

test('scripted keys give one sample per step: the inputs the network saw and the keys that moved the car',async()=>{
  const {newCar,recorder,step,saved}=rig();
  const car=newCar();assert.equal(recorder.start(),true);
  // The idle start is not recorded, and neither is the first step of a car.
  for(let i=0;i<30;i++)assert.equal(step(car,NO_KEYS).recorded,false);
  assert.equal(recorder.progress().reason,'idle');
  const expected=[];
  for(let i=0;i<400;i++){
    const keys=i>=300&&i<320?{reverse:true}:follow(car);
    const r=step(car,keys);assert.equal(r.recorded,true,`step ${i}`);expected.push(r);
  }
  assert.ok(expected.some(r=>r.bits&2)&&expected.some(r=>r.bits&4)&&expected.some(r=>r.bits&8)&&expected.some(r=>r.bits===0),'every key and no key occur');
  const demo=recorder.stop();
  assert.equal(demo.samples,400);assert.equal(demo.inputs.length,400*INPUT_COUNT);
  assert.ok(demo.inputs instanceof Float32Array&&demo.keys instanceof Uint8Array&&demo.sampleSteps instanceof Uint32Array);
  expected.forEach((r,i)=>{assert.deepEqual(row(demo,i),r.inputs,`inputs ${i}`);assert.equal(demo.keys[i],r.bits,`keys ${i}`);});
  // The sample right after the start: W moved the car away from rest.
  assert.equal(demo.keys[0]&1,1);assert.ok(row(demo,0)[7]>0);
  assert.deepEqual(Array.from(demo.sampleSteps),Array.from({length:400},(_,i)=>30+i),'step 0 registers the car, 1-29 are idle');
  // Pairing is the trainer's job; k = 1 pairs a state with the key that acts on it.
  const pairs=lagPairs(demo,1);assert.equal(pairs.length,399);
  for(const i of pairs){assert.deepEqual(row(demo,i),expected[i].inputs);assert.equal(demo.keys[i+1],expected[i+1].bits);}
  assert.equal(demo.context.maxSpeed,15);assert.equal(demo.context.traction,.5);assert.ok(demo.track.checkPointList.length>3);
  assert.equal(demo.stopReason,'user');assert.equal(demo.car,'WASD');assert.equal(demo.elapsedSteps,430);
  await recorder.last.done;assert.equal(recorder.last.saved,true);assert.equal(saved.length,1);assert.equal(saved[0],demo);
});

test('laps and checkpoints count the progress of the human car',()=>{
  const {sim,newCar,recorder,step}=rig();
  const car=newCar();recorder.start();
  let gates=0,count=0,laps=0;
  for(let i=0;i<60*STEP_HZ;i++){
    const {recorded}=step(car,follow(car));
    if(recorded&&car.laps>laps)gates+=car.laps-laps;else if(recorded&&car.checkPointsCount>count)gates+=car.checkPointsCount-count;
    laps=car.laps;count=car.checkPointsCount;
    assert.equal(car.damaged,false,'the wall follower does not crash');
  }
  const p=recorder.progress();
  assert.ok(car.laps>=2,`laps ${car.laps}`);assert.equal(p.laps,car.laps);assert.equal(p.checkpoints,gates);
  // The parked car already touches the start gate, so the drive itself
  // earns one gate less than the AI's fitness count.
  assert.equal(gates,car.laps*sim.road.checkPointList.length+car.checkPointsCount-1);
  const demo=recorder.stop();
  assert.equal(demo.laps,car.laps);assert.equal(demo.checkpoints,gates);assert.equal(demo.crashes,0);
});

test('AI driving, a crash, another speed, invincibility, and a paused simulation break the log; lag pairs never span a break',()=>{
  const {env,newCar,recorder,step}=rig();
  const car=newCar();recorder.start();step(car,NO_KEYS);
  // A co-driver network that presses nothing, so held keys decide.
  for(const level of car.brain.levels){level.weights.fill(0);level.biases.fill(0);}
  const drive=(n,keys)=>{let added=0;for(let i=0;i<n;i++)added+=step(car,keys?.(car)??follow(car)).recorded;return added;};
  assert.equal(drive(100),100);
  const pausedFor=(reason,n,keys)=>{assert.equal(drive(n,keys),0,reason);assert.equal(recorder.progress().reason,reason);};
  env.assist=true;pausedFor('ai',20);env.assist=false;assert.equal(drive(20),20);
  // The co-driver's network drives the car itself; held keys still override.
  car.aiDriving=true;pausedFor('ai',10);car.aiDriving=false;car.controls.setAI(null);assert.equal(drive(20),20);
  env.simSpeed=2;pausedFor('speed',10);env.simSpeed=1;assert.equal(drive(20),20);
  car.invincible=true;pausedFor('invincible',10);car.invincible=false;assert.equal(drive(50),50);
  // Full throttle, no steering: the car hits a wall.
  let crashStep=-1,approach=0;
  for(let i=0;i<400&&!car.damaged;i++){approach+=step(car,{forward:true}).recorded;if(car.damaged)crashStep=recorder.progress().steps-1;}
  assert.equal(car.damaged,true);assert.equal(recorder.progress().crashes,1);assert.equal(recorder.progress().reason,'damaged');
  const before=recorder.progress().samples;
  // 40 damaged steps, then the reset to the start: the parked car is idle.
  for(let i=0;i<60;i++)step(car,NO_KEYS);
  assert.equal(recorder.progress().samples,before);assert.equal(recorder.progress().reason,'idle');
  assert.equal(car.damaged,false);assert.equal(car.x,car.origin.x);
  assert.equal(drive(60),60,'recording resumes once the car moves again');
  // Pause or a hidden tab: no physics steps, but the person may change keys.
  recorder.interrupt();recorder.interrupt();
  assert.equal(drive(40),40,'the steps after a pause are recorded');
  const demo=recorder.stop();
  assert.deepEqual(Array.from(demo.crashSteps),[crashStep]);assert.equal(demo.crashes,1);
  // Seven unbroken runs of samples, known from the script above.
  const runs=[100,20,20,20,50+approach,60,40];
  assert.equal(demo.samples,runs.reduce((a,b)=>a+b));
  for(const k of [1,12]){
    const pairs=lagPairs(demo,k);
    assert.equal(pairs.length,runs.reduce((sum,n)=>sum+Math.max(0,n-k),0),`k=${k}`);
    for(const i of pairs)assert.equal(demo.sampleSteps[i+k]-demo.sampleSteps[i],k);
  }
  const gaps=[...demo.sampleSteps].filter((s,i,a)=>i&&s-a[i-1]!==1).length;assert.equal(gaps,6);
});

test('a new car, a changed track or physics, multiplayer, and the size cap split or end a recording',async()=>{
  // A replaced car: its first step is never recorded, even while moving.
  let r=rig();let car=r.newCar();r.recorder.start();r.step(car,NO_KEYS);
  for(let i=0;i<80;i++)r.step(car,follow(car));
  car=r.newCar();assert.equal(r.step(car,{forward:true}).recorded,false);assert.equal(r.step(car,{forward:true}).recorded,true);
  let demo=r.recorder.stop();assert.equal(demo.samples,81);assert.equal(demo.sampleSteps[80]-demo.sampleSteps[79],2);

  // A track change before the first sample is adopted; after it, the recording ends and is kept.
  r=rig();car=r.newCar();r.recorder.start();r.step(car,NO_KEYS);
  const gates=r.sim.road.checkPointList;
  r.sim.road.checkPointList=gates.slice(0,-1);r.step(car,NO_KEYS);assert.equal(r.recorder.recording,true);
  r.sim.road.checkPointList=gates;
  for(let i=0;i<80;i++)r.step(car,follow(car));
  r.sim.road.checkPointList=gates.slice();r.step(car,follow(car));
  assert.equal(r.recorder.recording,true,'the same gates in a new array are the same track');
  r.sim.road.checkPointList=gates.slice(0,-1);r.step(car,follow(car));
  assert.equal(r.recorder.recording,false);assert.equal(r.recorder.last.reason,'context');
  await r.recorder.last.done;assert.equal(r.saved[0].samples,81);assert.equal(r.saved[0].context.track,hash(gates));
  // A car moved in place (as loading a track preset does) breaks the log, even with W held.
  r=rig();car=r.newCar();r.recorder.start();r.step(car,NO_KEYS);
  for(let i=0;i<80;i++)r.step(car,follow(car));
  Object.assign(car,{x:r.sim.spawn.x,y:r.sim.spawn.y,angle:r.sim.spawn.angle,speed:0,velocity:{x:0,y:0}});
  assert.equal(r.step(car,{forward:true}).recorded,false);assert.equal(r.step(car,{forward:true}).recorded,true);
  demo=r.recorder.stop();assert.equal(lagPairs(demo,1).length,79,'no pair joins the two places');
  // Another driving style ends it: trials run under the recording's style.
  r=rig();car=r.newCar();r.recorder.start();r.step(car,NO_KEYS);
  for(let i=0;i<80;i++)r.step(car,follow(car));
  r.env.profile='wild';r.step(car,follow(car));
  assert.equal(r.recorder.last.reason,'context');await r.recorder.last.done;assert.equal(r.saved[0].context.profile,'balanced');
  // New physics (a car rebuilt with another top speed) end it too.
  r=rig();car=r.newCar();r.recorder.start();r.step(car,NO_KEYS);
  for(let i=0;i<80;i++)r.step(car,follow(car));
  r.step(r.newCar(10),NO_KEYS);assert.equal(r.recorder.last.reason,'context');assert.equal(r.recorder.last.samples,80);

  // Multiplayer: no recording starts, and turning it on ends one.
  r=rig();car=r.newCar();r.env.multiplayer=true;
  assert.equal(r.recorder.blocked(),'multiplayer');assert.equal(r.recorder.start(),false);assert.equal(r.recorder.recording,false);
  r.env.multiplayer=false;r.recorder.start();r.step(car,NO_KEYS);for(let i=0;i<80;i++)r.step(car,follow(car));
  r.env.multiplayer=true;r.step(car,follow(car));
  assert.equal(r.recorder.recording,false);assert.equal(r.recorder.last.reason,'multiplayer');assert.equal(r.recorder.last.samples,80);
  // Polling covers training that is paused (no physics steps).
  r.env.multiplayer=false;r.recorder.start();r.env.multiplayer=true;r.recorder.poll();assert.equal(r.recorder.recording,false);
  // A hidden panel (another phase, the A/B view) hides Stop, so recording ends.
  r.env.multiplayer=false;r.recorder.start();r.step(car,follow(car));r.env.hidden=true;r.step(car,follow(car));
  assert.equal(r.recorder.last.reason,'away');
  r.env.hidden=false;r.recorder.start();r.env.hidden=true;r.recorder.poll();assert.equal(r.recorder.last.reason,'away');r.env.hidden=false;
  // An error inside a step ends the recording, never the animation loop.
  r.recorder.start();const signature=r.recorder.environment.signature;r.recorder.environment.signature=()=>{throw Error('broken');};
  const warn=console.warn;console.warn=()=>{};
  try{assert.doesNotThrow(()=>r.step(car,follow(car)));}finally{console.warn=warn;r.recorder.environment.signature=signature;}
  assert.equal(r.recorder.recording,false);assert.equal(r.recorder.last.reason,'error');

  // Five minutes of samples end a recording; less than a second is not saved.
  assert.equal(MAX_SAMPLES,5*60*60);assert.equal(MAX_DEMONSTRATIONS,10);assert.equal(MIN_SAMPLES,60);
  r=rig({maxSamples:120});car=r.newCar();r.recorder.start();r.step(car,NO_KEYS);
  for(let i=0;i<200&&r.recorder.recording;i++)r.step(car,follow(car));
  assert.equal(r.recorder.last.reason,'full');await r.recorder.last.done;assert.equal(r.saved[0].samples,120);
  r=rig();car=r.newCar();r.recorder.start();r.step(car,NO_KEYS);
  for(let i=0;i<59;i++)r.step(car,follow(car));
  assert.equal(r.recorder.stop(),null);assert.equal(r.recorder.last.tooShort,true);assert.equal(r.saved.length,0);
});

test('leaving the start is not a checkpoint, even with W held through a crash reset; the crash step still counts',()=>{
  const {sim,newCar,recorder,step}=rig();
  const car=newCar();recorder.start();step(car,NO_KEYS);
  // W from the start: the car touches the start gate before and while it leaves.
  step(car,{forward:true});assert.equal(car.checkPointsCount,1);assert.equal(recorder.progress().checkpoints,0);
  let crashed=false;
  for(let i=0;i<400&&!crashed;i++){step(car,{forward:true});crashed=car.damaged;}
  assert.equal(crashed,true);
  const before=recorder.progress().checkpoints;
  // W stays held through the 40 damaged steps and the reset.
  let first=null;
  for(let i=0;i<50&&!first;i++){const r=step(car,{forward:true});if(r.recorded)first=r;}
  assert.ok(first,'recording resumed');assert.equal(car.checkPointsCount,1,'the car touched the start gate again');
  assert.equal(recorder.progress().checkpoints,before,'leaving the start again is not counted');
  // A lap that ends on the step that crashes is the person's lap.
  const r2=rig(),c2=r2.newCar();r2.recorder.start();r2.step(c2,NO_KEYS);
  for(let i=0;i<60*STEP_HZ&&c2.laps===0;i++)r2.step(c2,follow(c2));
  assert.equal(c2.laps,1);assert.equal(r2.recorder.progress().laps,1);
  // car.update() checks the wall before the gate, so one step can end a lap
  // and crash. Apply that step's result and let the recorder see it.
  c2.laps++;c2.damaged=true;r2.recorder.step(c2);
  const p=r2.recorder.progress();
  assert.deepEqual([p.reason,p.crashes,p.laps],['damaged',1,2],'the lap counts, the step is not recorded');
});

test('the saved count follows each save, even after the next recording starts',async()=>{
  const {newCar,recorder,step}=rig();
  const car=newCar();recorder.start();step(car,NO_KEYS);
  for(let i=0;i<80;i++)step(car,follow(car));
  recorder.stop();const pending=recorder.last.done;
  recorder.start();await pending;
  assert.equal(recorder.last,null);assert.equal(recorder.storedCount,1);
});

test('a freeze over 250 ms breaks the log; losing focus pauses; Adaptive green gates block or end recording',()=>{
  const {env,newCar,recorder,step}=rig();
  // A wall clock with 16 ms frames.
  let clock=0;recorder.environment.now=()=>clock;
  const car=newCar();recorder.start();step(car,NO_KEYS);
  const drive=n=>{for(let i=0;i<n;i++){clock+=16;step(car,follow(car));}};
  drive(60);
  clock+=224;drive(1); // a 240 ms stutter: no break
  drive(20);
  const stallAt=recorder.progress().samples;clock+=384;drive(1); // a 400 ms freeze
  drive(20);
  // Several steps in one frame share a time: no break.
  for(let i=0;i<5;i++)step(car,follow(car));
  // Without the keyboard the page releases every key: those steps are not the person's.
  const unfocusAt=recorder.progress().samples;
  env.focused=false;assert.equal(step(car,NO_KEYS).recorded,false);assert.equal(recorder.progress().reason,'unfocused');
  env.focused=true;clock+=16;assert.equal(step(car,follow(car)).recorded,true);
  const demo=recorder.stop();
  const gaps=[...demo.sampleSteps].map((s,i,a)=>i&&s-a[i-1]!==1?i:-1).filter(i=>i>0);
  assert.deepEqual(gaps,[stallAt,unfocusAt],'breaks exactly at the freeze and the lost focus');
  assert.equal(demo.sampleSteps[stallAt]-demo.sampleSteps[stallAt-1],2);
  // Adaptive green gates move gates between generations: no start, and turning them on ends a recording.
  env.adaptive=true;assert.equal(recorder.blocked(),'adaptive');assert.equal(recorder.start(),false);
  env.adaptive=false;recorder.start();step(car,follow(car));env.adaptive=true;step(car,follow(car));
  assert.equal(recorder.last.reason,'adaptive');
  env.adaptive=false;recorder.start();env.adaptive=true;recorder.poll();assert.equal(recorder.last.reason,'adaptive');
});
