// The reflex shield (#73): car.js Car.makeShield / Car.shieldDanger, the
// sim-worker 'begin' flag and main.js reflexShieldFlag. The Rust port's
// parity is cloud-brain/sim/tests/traces.rs (shield-traces.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {Simulation} from './helpers/simulation.mjs';
import {reflexBrain} from '../AI-Car-Racer/learning/reflex.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const randomBrains=(seed,n)=>{const r=seededRandom(seed);return Float32Array.from({length:244*n},()=>r()*2-1);};
const states=sim=>sim.cars.map(c=>[c.x,c.y,c.angle,c.speed,c.damaged,c.checkPointsCount,c.laps]);
const bits=c=>(c.forward?1:0)|(c.left?2:0)|(c.right?4:0)|(c.reverse?8:0);

test('the shield is off by default and Car.makeShield refuses unusable configs',()=>{
  const sim=new Simulation({track:'Rectangle'}),Car=sim.scope.CarClass,brain=reflexBrain();
  assert.equal(Car.shield,null);
  for(const bad of [null,undefined,false,true,1,'on',{},{brain:brain.slice(0,243)},{brain,front:NaN},{brain,side:Infinity},
    {brain:Float32Array.from(brain,(v,i)=>i===7?NaN:v)}])assert.equal(Car.makeShield(bad),null,JSON.stringify(bad));
  const s=Car.makeShield({brain});
  assert.equal(s.front,Car.SHIELD_DEFAULTS.front);assert.equal(s.side,Car.SHIELD_DEFAULTS.side);
  assert.deepEqual([Car.makeShield({brain,front:.5,side:.6}).front,Car.makeShield({brain,front:.5,side:.6}).side],[.5,.6]);
  assert.ok(Object.isFrozen(s));
});

test('making a shield draws nothing from Math.random',()=>{
  const sim=new Simulation({track:'Rectangle',seed:'draws'}),Car=sim.scope.CarClass;
  const math=sim.scope.Math,before=math.random;let calls=0;math.random=()=>{calls++;return before();};
  try{Car.makeShield({brain:reflexBrain()});}finally{math.random=before;}
  assert.equal(calls,0);
});

test('Car.shieldDanger: the front ray above front, or another ray above side',()=>{
  const Car=new Simulation({track:'Rectangle'}).scope.CarClass,s={front:.75,side:.85};
  const rays=(i,v)=>{const a=[0,0,0,0,0,0,0,.9,.1,-.1];a[i]=v;return a;};
  assert.equal(Car.shieldDanger(rays(3,.75),s),false);assert.equal(Car.shieldDanger(rays(3,.76),s),true);
  assert.equal(Car.shieldDanger(rays(3,.84),s),true);
  for(const i of [0,1,2,4,5,6]){assert.equal(Car.shieldDanger(rays(i,.8),s),false,'side '+i);assert.equal(Car.shieldDanger(rays(i,.86),s),true,'side '+i);}
  // Speed and the gate inputs never trigger it.
  assert.equal(Car.shieldDanger([0,0,0,0,0,0,0,5,5,5],s),false);
});

test('a shield that never fires drives exactly as no shield',()=>{
  const flat=randomBrains('never',24),off=new Simulation({track:'Triangle',seed:'p'}),on=new Simulation({track:'Triangle',seed:'p',shield:{front:2,side:2}});
  off.begin(flat);on.begin(flat);off.run(20);on.run(20);
  assert.deepEqual(states(on),states(off));
  assert.equal(on.cars.reduce((a,c)=>a+c.shieldFrames,0),0);
});

test('on a firing frame the reflex sets all four controls; on the others the brain does',()=>{
  const sim=new Simulation({track:'Rectangle',seed:'fire',shield:true}),Car=sim.scope.CarClass;
  const feedForward=vm.runInContext('NeuralNetwork.feedForward',sim.scope);
  const flat=randomBrains('fire',24);sim.begin(flat);
  let fired=0,quiet=0;
  for(let f=1;f<=600;f++){
    sim.scope.frameCount=f;
    for(const car of sim.cars){
      if(car.damaged){car.update(sim.road.borders,sim.road.checkPointList);continue;}
      const before=car.shieldFrames;car.update(sim.road.borders,sim.road.checkPointList);
      const inputs=car.lastInputs,danger=Car.shieldDanger(inputs,Car.shield);
      assert.equal(car.shieldFrames-before,danger?1:0);
      const net=danger?Car.shield.network:car.brain;
      const want=Array.from(feedForward(Array.from(inputs),net));
      assert.equal(bits(car.controls),want[0]|want[1]<<1|want[2]<<2|want[3]<<3);
      danger?fired++:quiet++;
    }
  }
  assert.ok(fired>50&&quiet>50,`fired ${fired}, quiet ${quiet}`);
});

test('shieldFrames counts per car, and stays 0 with the shield off',()=>{
  // Whether it cuts crashes is the benchmark's question (docs/validation/reflex-shield.md).
  const flat=randomBrains('crashes',48);
  const run=shield=>{const s=new Simulation({track:'Rectangle',seed:'c',shield});s.begin(flat);s.run(20);return s;};
  const off=run(null),on=run(true);
  assert.ok(on.cars.filter(c=>c.shieldFrames>0).length>5);
  assert.ok(off.cars.every(c=>c.shieldFrames===0));
});

const channels=[];
class TrackedChannel extends MessageChannel{constructor(){super();channels.push(this);}}
test.after(()=>{for(const c of channels.splice(0)){c.port1.close();c.port2.close();}});
function loadWorker(carSource){
  const posted=[],scope={performance,MessageChannel:TrackedChannel,console:{...console,warn(){}},Math,postMessage:m=>posted.push(m)};
  scope.self=scope;scope.globalThis=scope;
  const context=vm.createContext(scope);
  scope.importScripts=(...files)=>{for(const f of files)vm.runInContext(f==='car.js'&&carSource!=null?carSource:readFileSync(new URL('../AI-Car-Racer/'+f,import.meta.url),'utf8'),context,{filename:f});};
  vm.runInContext(readFileSync(new URL('../AI-Car-Racer/sim-worker.js',import.meta.url),'utf8'),context,{filename:'sim-worker.js'});
  return {send:data=>scope.onmessage({data}),posted,context};
}

test('sim-worker: every begin sets the shield again, and genEnd reports its frames',async()=>{
  const sim=new Simulation({track:'Rectangle'});
  const worker=loadWorker(),N=8;
  // The worker loads the reflex with import(), which a vm cannot run: give it the brain.
  vm.runInContext('reflexFlat=globalThis.__reflex;',Object.assign(worker.context,{__reflex:reflexBrain()}));
  const shieldOf=()=>vm.runInContext('Car.shield',worker.context);
  worker.send({type:'init',canvasW:3200,canvasH:1800,borders:sim.road.borders,checkPointList:sim.road.checkPointList});
  const begin=shield=>{worker.send({type:'begin',N,seconds:1,maxSpeed:15,traction:.5,driverProfile:'balanced',brains:randomBrains('w',N),
    startInfo:{x:sim.spawn.x,y:sim.spawn.y,heading:sim.spawn.angle},shield});worker.send({type:'setPause',pause:true});};
  begin({front:.6});
  assert.equal(shieldOf().front,.6);assert.equal(shieldOf().side,.6);
  begin(undefined);assert.equal(shieldOf(),null,'a begin without shield turns it off');
  begin({});assert.equal(shieldOf().front,.4);
  begin(null);assert.equal(shieldOf(),null);
  begin(true);assert.equal(shieldOf(),null,'only an object turns it on in the worker');
  // genEnd carries the summary only while the shield is on.
  vm.runInContext('endGen()',worker.context);
  assert.equal(worker.posted.filter(m=>m.type==='genEnd').at(-1).shield,undefined);
  begin({});vm.runInContext('endGen()',worker.context);
  const s=worker.posted.filter(m=>m.type==='genEnd').at(-1).shield;
  assert.deepEqual(Object.keys(s).sort(),['cars','drivenFrames','frames','laps']);assert.equal(s.cars,N);
});

test('sim-worker: an older cached car.js without the shield still begins',()=>{
  const sim=new Simulation({track:'Rectangle'});
  const old=readFileSync(new URL('../AI-Car-Racer/car.js',import.meta.url),'utf8').replace(/static makeShield\(/,'static _noShield(');
  const worker=loadWorker(old);
  worker.send({type:'init',canvasW:3200,canvasH:1800,borders:sim.road.borders,checkPointList:sim.road.checkPointList});
  worker.send({type:'begin',N:2,seconds:1,maxSpeed:15,traction:.5,brains:randomBrains('o',2),startInfo:{x:sim.spawn.x,y:sim.spawn.y,heading:sim.spawn.angle},shield:{}});
  worker.send({type:'setPause',pause:true});
  assert.equal(vm.runInContext('Car.shield',worker.context),null);
});

test('main.js reflexShieldFlag: off unless vvReflexShield is true or an object',()=>{
  const source=readFileSync(new URL('../AI-Car-Racer/main.js',import.meta.url),'utf8');
  const at=source.indexOf('function reflexShieldFlag(');let depth=0,i=source.indexOf('{',at);
  for(;i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'&&--depth===0)break;}
  const flag=v=>{const scope=vm.createContext({vvReflexShield:v});vm.runInContext(source.slice(at,i+1)+';globalThis.f=reflexShieldFlag;',scope);return scope.f();};
  for(const v of [undefined,null,false,0,1,'true'])assert.equal(flag(v),null,String(v));
  assert.equal(JSON.stringify(flag(true)),'{}');
  assert.equal(JSON.stringify(flag({front:.6,side:'x',extra:1})),'{"front":0.6}');
});
