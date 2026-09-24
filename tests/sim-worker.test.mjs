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
