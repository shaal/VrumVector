import test from 'node:test';
import assert from 'node:assert/strict';
import {PairedSequentialTest} from '../AI-Car-Racer/learning/sequential.js';
import {runTrialArm,compareOutcomes} from '../AI-Car-Racer/learning/trial.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';
import {Simulation} from './helpers/simulation.mjs';

const store=new Map();
globalThis.localStorage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
const {runTransferCheck,transferGuard,isTransferPaused,resumeTransfer,applyTransferGuard,clearTransferGuards}=await import('../AI-Car-Racer/learning/transferCheck.js');
const context={profile:'careful',track:'rect-geometry',maxSpeed:15,traction:.5,seconds:4};

test('betting wealth rejects after 14 straight wins, skips ties, and latches',()=>{
  const t=new PairedSequentialTest();
  for(let i=0;i<13;i++)assert.equal(t.update(false,true),false);
  assert.ok(Math.abs(t.wealth-1.25**13)<1e-9);
  t.update(true,true);t.update(false,false);assert.equal(t.ties,2);assert.equal(t.rejected,false);
  assert.equal(t.update(false,true),true);assert.equal(t.decisiveAtRejection,14);
  for(let i=0;i<30;i++)t.update(true,false);
  assert.equal(t.rejected,true,'Rejection never un-latches');assert.ok(t.wealth<1);
  assert.deepEqual(Object.keys(t.toJSON()).sort(),['alpha','baselineWins','championWins','decisiveAtRejection','lambda','maxWealth','rejected','ties','wealth']);
});
test('under no effect, the test rejects at most alpha of the time over long runs',()=>{
  const random=seededRandom('sequential-null-v1');let rejections=0;const runs=2000;
  for(let run=0;run<runs;run++){
    const t=new PairedSequentialTest();
    for(let i=0;i<200&&!t.rejected;i++){const champion=random()<.5;t.update(!champion,champion);}
    if(t.rejected)rejections++;
  }
  assert.ok(rejections/runs<=.05,`false rejections ${(rejections/runs*100).toFixed(1)}%`);
});
test('a trial arm runs real physics deterministically from the same random stream',()=>{
  const arm=seeds=>{const sim=new Simulation({track:'Rectangle',seed:'trial-arm'});
    return runTrialArm({simulate:flat=>{sim.begin(flat);return sim.run(3);},context,seeds,random:seededRandom('trial-arm'),generations:3,population:8});};
  const fresh=arm([]),again=arm([]);
  assert.deepEqual(fresh,again);assert.equal(fresh.history.length,3);assert.ok(fresh.best>=Math.max(...fresh.history));
  assert.ok(fresh.area>=fresh.best&&Number.isFinite(fresh.lastMean));
  const seeded=arm([{vector:new Float32Array(244).fill(.1),id:'m'}]);
  assert.equal(seeded.history.length,3);
});

// Scripted workers: each trial's outcome comes from `script(trial)` as [memory, fresh] best progress.
function scripted(script){
  let spawned=0,terminated=0;
  const spawn=()=>{spawned++;const worker={postMessage(m){const outcome=script(m.id);if(!outcome)return;const [memory,fresh]=outcome;const best=m.arm==='memory'?memory:fresh;
    setTimeout(()=>worker.onmessage({data:{type:'result',id:m.id,arm:m.arm,best,area:best,lastMean:m.arm==='memory'?9:0,history:[]}}),0);},
    terminate(){terminated++;}};return worker;};
  return {spawn,counts:()=>({spawned,terminated})};
}
const memorySet=[new Float32Array(244).fill(.3)];
const base={context,track:{},profile:'careful',maxSpeed:15,traction:.5,seconds:4,seeds:memorySet};
const stored=()=>transferGuard(context);

test('trial outcomes compare by final best, then the same best sooner; population mean never decides',()=>{
  assert.equal(compareOutcomes({best:3,area:5,lastMean:0},{best:2,area:9,lastMean:9}),1);
  assert.equal(compareOutcomes({best:3,area:5,lastMean:9},{best:3,area:9,lastMean:0}),-1);
  assert.equal(compareOutcomes({best:3,area:9,lastMean:9},{best:3,area:9,lastMean:0}),0);
});
test('fresh starts that keep winning pause transfer for this context only',async()=>{
  store.clear();const workers=scripted(()=>[1,3]),progress=[];
  const result=await runTransferCheck({...base,spawn:workers.spawn,onProgress:p=>progress.push(p)});
  assert.equal(result.state,'paused');assert.equal(result.trials,14);assert.equal(result.freshWins,14);
  assert.equal(progress.length,14);assert.deepEqual(workers.counts(),{spawned:2,terminated:2});
  assert.equal(stored().verdict.state,'paused');assert.equal(stored().test,null);
  assert.equal(isTransferPaused(context),true);assert.equal(isTransferPaused({...context,profile:'wild'}),false);
  const seeds=[{id:'same',exactContext:true},{id:'other',exactContext:false}];
  assert.deepEqual(applyTransferGuard(context,seeds),{seeds:[seeds[0]],held:1});
  assert.deepEqual(applyTransferGuard({...context,profile:'wild'},seeds),{seeds,held:0});
  const again=await runTransferCheck({...base,spawn:scripted(()=>[9,0]).spawn});
  assert.equal(again.state,'paused');assert.equal(again.decided,true,'A decided test is not re-run');
  resumeTransfer(context);assert.equal(stored(),null);assert.equal(isTransferPaused(context),false);
});
test('memories that keep winning confirm transfer; ties and mixed results stay inconclusive',async()=>{
  store.clear();
  const confirmed=await runTransferCheck({...base,spawn:scripted(()=>[4,2]).spawn});
  assert.equal(confirmed.state,'confirmed');assert.equal(isTransferPaused(context),false);
  store.clear();
  const tied=await runTransferCheck({...base,spawn:scripted(()=>[2,2]).spawn,trialsPerRun:8});
  assert.equal(tied.state,'inconclusive');assert.equal(tied.ties,8,'Population means differ but do not decide');assert.equal(tied.trials,8);
  store.clear();
  const mixed=await runTransferCheck({...base,spawn:scripted(t=>t%2?[3,1]:[1,3]).spawn,trialsPerRun:30});
  assert.equal(mixed.state,'inconclusive');assert.equal(stored().test.state,'inconclusive');assert.equal(stored().verdict,null);
});
test('continuing keeps the evidence; new memories or settings start a new test and keep the old verdict',async()=>{
  store.clear();
  const first=await runTransferCheck({...base,spawn:scripted(()=>[1,3]).spawn,trialsPerRun:10});
  assert.equal(first.state,'inconclusive');assert.equal(stored().test.nextTrial,10);
  const keys=[];const spawn=()=>{const w={postMessage(m){keys.push(m.key);setTimeout(()=>w.onmessage({data:{type:'result',id:m.id,arm:m.arm,best:m.arm==='memory'?1:3,area:0}}),0);},terminate(){}};return w;};
  const continued=await runTransferCheck({...base,spawn,trialsPerRun:10});
  assert.equal(continued.state,'paused');assert.equal(continued.trials,14,'Four more wins reach 20x');assert.equal(continued.restarted,false);
  assert.ok(keys.every(k=>/:1[0-3]$/.test(k)),'Continued trials use new trial numbers');
  const settingsChanged=await runTransferCheck({...base,mutation:.05,spawn:scripted(()=>[3,1]).spawn,trialsPerRun:5});
  assert.equal(settingsChanged.trials,5);assert.notEqual(settingsChanged.identity,continued.identity);
  assert.equal(stored().verdict.state,'paused','An unfinished new test keeps the earlier pause');assert.equal(stored().test.trials,5);
  assert.equal(isTransferPaused(context),true);
  const other=[new Float32Array(244).fill(-.3)];
  const stopped=await runTransferCheck({...base,seeds:other,spawn:scripted(()=>[3,1]).spawn,trialsPerRun:0});
  assert.equal(stopped.restarted,true);assert.equal(isTransferPaused(context),true,'A stopped 0-trial check does not lift a pause');
  assert.equal(stored().test.trials,5,'nor replace the unfinished test');
});
test('progress is saved after every trial, so a closed tab keeps it',async()=>{
  store.clear();const controller=new AbortController();
  const running=runTransferCheck({...base,spawn:scripted(t=>t<4?[1,3]:null).spawn,signal:controller.signal});
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(stored().test.trials,4);assert.equal(stored().test.state,'running');
  controller.abort();assert.equal((await running).state,'cancelled');assert.equal(stored().test.state,'cancelled');
  const resumed=await runTransferCheck({...base,spawn:scripted(()=>[1,3]).spawn});
  assert.equal(resumed.state,'paused');assert.equal(resumed.trials,14,'The stopped check continues from trial 4');
});
test('no memories, Start Fresh during a run, worker errors, and damaged entries are handled',async()=>{
  store.clear();
  assert.equal((await runTransferCheck({...base,seeds:[],spawn:scripted(()=>[1,1]).spawn})).state,'no-memories');
  assert.equal(stored(),null,'A no-memories result is not stored');
  const controller=new AbortController();
  const cleared=await runTransferCheck({...base,spawn:scripted(()=>[1,3]).spawn,signal:controller.signal,
    onProgress:p=>{if(p.trials===3){clearTransferGuards();controller.abort();}}});
  assert.equal(cleared.state,'cancelled');assert.equal(store.get('vv.transferGuard'),undefined,'An aborted run cannot write back after a reset');
  const failing=()=>{const w={postMessage(m){setTimeout(()=>w.onmessage({data:{type:'error',id:m.id,arm:m.arm,message:'boom'}}),0);},terminate(){}};return w;};
  await assert.rejects(runTransferCheck({...base,spawn:failing}),/boom/);
  assert.equal(stored(),null,'A failed check is not stored');
  const key=JSON.stringify([1,'careful','rect-geometry',15,.5,4]);
  for(const bad of [{verdict:{state:'paused'}},{test:{identity:'x',trials:2,memoryWins:0,freshWins:0,ties:0,evidence:{memory:1,fresh:1},threshold:20}},{verdict:5},'junk']){
    store.set('vv.transferGuard',JSON.stringify({[key]:bad}));
    assert.equal(stored(),null,JSON.stringify(bad));assert.equal(isTransferPaused(context),false);
  }
  const good=await runTransferCheck({...base,spawn:scripted(()=>[1,3]).spawn});
  assert.equal(good.state,'paused','A damaged entry is replaced by a new test');
});
test('the sequential test state survives a JSON round trip',()=>{
  const t=new PairedSequentialTest();for(let i=0;i<5;i++)t.update(false,true);t.update(true,true);
  const copy=PairedSequentialTest.fromJSON(JSON.parse(JSON.stringify(t)));
  assert.deepEqual(copy.toJSON(),t.toJSON());copy.update(false,true);t.update(false,true);assert.deepEqual(copy.toJSON(),t.toJSON());
});
