// Runs the real classic worker script in a Node vm with a minimal worker scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const channels=[];
class TrackedChannel extends MessageChannel{constructor(){super();channels.push(this);}}
const closeChannels=()=>{for(const c of channels.splice(0)){c.port1.close();c.port2.close();}};
function loadWorker(){
  const posted=[],scope={performance,MessageChannel:TrackedChannel,console,Math,postMessage:m=>posted.push(m)};
  scope.self=scope;scope.globalThis=scope;
  const context=vm.createContext(scope);
  scope.importScripts=(...files)=>{for(const f of files)vm.runInContext(readFileSync(new URL('../AI-Car-Racer/'+f,import.meta.url),'utf8'),context,{filename:f});};
  vm.runInContext(readFileSync(new URL('../AI-Car-Racer/sim-worker.js',import.meta.url),'utf8'),context,{filename:'sim-worker.js'});
  return {send:data=>scope.onmessage({data}),posted,scope};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,30));

test('unpausing a worker before init does not step a missing road',async()=>{
  const errors=[],onError=error=>errors.push(error);
  process.on('uncaughtException',onError);
  try{
    const worker=loadWorker();
    worker.send({type:'setPause',pause:false});
    await settle();
    assert.deepEqual(errors.map(String),[]);
    assert.equal(worker.scope.road,null);
  }finally{process.off('uncaughtException',onError);closeChannels();}
});

test('pose jitter still keeps every spawn clear of the walls (Car.polygonAt)',async()=>{
  const {Simulation}=await import('./helpers/simulation.mjs');
  const sim=new Simulation({track:'Triangle'}),polygonAt=sim.scope.CarClass.polygonAt,touches=sim.scope.polysIntersect;
  try{
    const worker=loadWorker(),N=64,{seededRandom}=await import('../AI-Car-Racer/graphics/state.js');
    worker.scope.Math=Object.assign(Object.create(Math),{random:seededRandom('pose-jitter')});
    worker.send({type:'init',canvasW:3200,canvasH:1800,borders:sim.road.borders,checkPointList:sim.road.checkPointList});
    worker.send({type:'begin',N,seconds:1,maxSpeed:15,traction:.5,driverProfile:'balanced',brains:new Float32Array(N*244),
      startInfo:{x:sim.spawn.x,y:sim.spawn.y,heading:sim.spawn.angle},poseJitter:{radiusPx:400,angleDeg:30,maxAttempts:8}});
    worker.send({type:'setPause',pause:true});
    const jitter=worker.posted.find(m=>m.event==='poseJitter'),snap=worker.posted.find(m=>m.type==='snapshot');
    assert.ok(jitter.rejected>0,'some jittered poses touched a wall and were rejected');
    for(let i=0;i<N;i++){
      const body=polygonAt(snap.positions[i*5],snap.positions[i*5+1],snap.positions[i*5+2],30,50);
      assert.ok(!sim.road.borders.some(b=>touches(body,b)),`car ${i} spawned touching a wall`);
    }
  }finally{closeChannels();}
});
