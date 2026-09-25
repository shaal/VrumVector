// Behavioural cloning (AI-Car-Racer/learning/clone.js). The main tests train
// the [10, 16, 4] network on a known teacher network's own driving in the real
// car simulator, then check that the copy agrees with the teacher and drives
// like it. The measured numbers are in docs/validation/behavioural-cloning.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Simulation} from './helpers/simulation.mjs';
import {evolveTeacher,drive,record} from './helpers/teacher.mjs';
import {syntheticDataset} from './helpers/synthetic.mjs';
import {trainClone,trainCloneInWorker,prepareDataset,splitBlocks,pairRows,predict,evaluate,CloneError,CLONE_DEFAULTS,KEY_NAMES}
  from '../AI-Car-Racer/learning/clone.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';
import {lagPairs,keyBits,KEY_ORDER} from '../AI-Car-Racer/learning/demonstration.js';
import {demonstrationDataset} from '../AI-Car-Racer/learning/dataset.js';

const ROUND=30; // seconds of closed-loop driving, like one training round
// Teachers come from short genetic runs with a fixed seed, so every run is the
// same. The test refuses a teacher that never, or always, presses a key (some
// seeds give one: a Triangle teacher that holds reverse the whole time).
const TEACHER_SEED='clone-teacher-b',GENETIC={generations:24,population:24,seconds:15};
const cache=new Map(),once=(key,make)=>{if(!cache.has(key))cache.set(key,make());return cache.get(key);};
const teacher=(track,delay=0)=>once(`${track}:${delay}`,()=>{
  const t=evolveTeacher({track,seed:TEACHER_SEED,...GENETIC,delay});
  // Many short runs from jittered starts cover more states than a few long ones.
  return {...t,...record(t.sim,t.vector,{delay,episodes:40,rows:delay?12000:18000,seconds:15,seed:(delay?'clone-late-':'clone-record-')+track})};
});
// Every pair of one dataset at one lag (no split), for scoring a finished clone.
function allPairs(dataset,lag){const data=prepareDataset(dataset);return {data,rows:pairRows(data,{held:new Uint8Array(data.n)},lag).train};}
const keyShare=dataset=>KEY_NAMES.map((_,o)=>{let on=0;for(let i=o;i<dataset.keys.length;i+=4)on+=dataset.keys[i];return on/(dataset.keys.length/4);});
const fails=code=>error=>error instanceof CloneError&&error.code===code;
const round=(v,d=4)=>v==null?v:Number(v.toFixed(d));
const sum=list=>list.reduce((total,v)=>total+v,0);
// A network that holds forward and nothing else: the baseline a copy must beat.
const FORWARD_ONLY=new Float32Array(244);FORWARD_ONLY.set([-1,1,1,1],176);

test('predict() is the deployed network, bit for bit',()=>{
  const sim=new Simulation({track:'Rectangle',seed:'clone-parity'});
  const Network=vm.runInContext('NeuralNetwork',sim.scope),random=seededRandom('clone-parity');
  for(let trial=0;trial<200;trial++){
    const scale=trial<100?1:40; // genetic-run weights and large clone weights
    const flat=Float32Array.from({length:244},()=>(random()*2-1)*scale),net=new Network([10,16,4]);
    let at=0;
    for(const level of net.levels){
      for(let j=0;j<level.biases.length;j++)level.biases[j]=flat[at++];
      for(let j=0;j<level.weights.length;j++)level.weights[j]=flat[at++];
    }
    for(let s=0;s<20;s++){
      const x=Array.from({length:10},(_,j)=>j<8?random():random()*.6-.3);
      assert.deepEqual(Array.from(predict(flat,x)),Array.from(Network.feedForward(x,net)));
    }
  }
  assert.deepEqual(Array.from(predict(FORWARD_ONLY,new Float32Array(10))),[1,0,0,0]);
});

test('the recording harness drives exactly as the game does, and keys act one step later',()=>{
  for(const track of ['Rectangle','Triangle']){
    const {vector,dataset}=teacher(track),sim=new Simulation({track,seed:'clone-harness'});
    sim.begin(vector);sim.run(20);
    const car=sim.cars[0],own=drive(new Simulation({track,seed:'clone-harness-2'}),vector,{seconds:20});
    assert.deepEqual(own.final,{x:car.x,y:car.y,angle:car.angle,speed:car.speed},track);
    assert.equal(own.progress,car.checkPointsCount+car.laps*sim.road.checkPointList.length);
    // Inputs sensed at the end of step t choose the keys held during step t + 1,
    // so at lag 1 the teacher matches its own recording on every step.
    const {data,rows}=allPairs(dataset,1);
    assert.equal(evaluate(vector,data,rows,1).agreement,1,track);
    assert.ok(evaluate(vector,data,allPairs(dataset,2).rows,2).agreement<1);
    // Like the game's recorder, the idle start is skipped: the first row of
    // every run holds the key that first moved the car.
    for(let t=0;t<data.n;t++)if(t===0||data.run[t]!==data.run[t-1])assert.ok(data.keys[t*4]||data.keys[t*4+3],`run starting at row ${t}`);
  }
});

for(const track of ['Rectangle','Triangle']){
  test(`recovers a known teacher from its own driving on ${track}`,t=>{
    const {sim,vector,dataset,runs}=teacher(track);
    const share=keyShare(dataset);
    assert.ok(share.every(s=>s>.02&&s<.98),`every key is both held and released: ${share}`);
    const {weights,report}=trainClone(dataset);
    assert.equal(weights.length,244);assert.ok(weights.every(Number.isFinite));
    assert.equal(report.lag,1,'the lag choice finds the one-step delay of the game');
    assert.ok(report.heldOut.agreement>=.95,`held-out agreement ${report.heldOut.agreement}`);
    // Fresh runs from new starts, never used for early stopping or the lag
    // choice. They can reach states that few training runs covered, so they
    // score lower than held-out blocks; this floor only catches a collapse.
    const fresh=record(sim,vector,{episodes:20,rows:6000,seconds:15,seed:'clone-fresh-'+track,jitterFirst:true});
    const {data,rows}=allPairs(fresh.dataset,1),freshAgreement=evaluate(weights,data,rows,1).agreement;
    assert.ok(freshAgreement>=.85,`fresh-run agreement ${freshAgreement}`);
    // Closed loop: teacher, clone, and a forward-only driver each drive one
    // round from the spawn and from 12 new starts. The clone must stay within
    // one checkpoint of the teacher on every start. Forward-only can do that
    // too on Triangle, so the clone's summed miss (checkpoints off, over all
    // starts) must also be at most half of forward-only's.
    const random=seededRandom('clone-loop-'+track),starts=[sim.spawn];
    for(let i=0;i<12;i++){const s=sim.spawn;starts.push({x:s.x+(random()*2-1)*12,y:s.y+(random()*2-1)*12,angle:s.angle+(random()*2-1)*.12});}
    const rounds=starts.map(start=>[vector,weights,FORWARD_ONLY].map(net=>drive(sim,net,{seconds:ROUND,start})));
    const progress=i=>rounds.map(r=>r[i].progress),[own,copy,forward]=[0,1,2].map(progress);
    const miss=list=>sum(list.map((p,i)=>Math.abs(p-own[i])));
    copy.forEach((p,i)=>assert.ok(Math.abs(p-own[i])<=1,`start ${i}: teacher ${own[i]} checkpoints, clone ${p}`));
    assert.ok(miss(copy)<=miss(forward)/2,`summed miss: clone ${miss(copy)}, forward-only ${miss(forward)}`);
    t.diagnostic(JSON.stringify({track,steps:report.split.steps,runs:runs.length,keyShare:share.map(v=>round(v,3)),
      lag:report.lag,epochs:report.epochs,bestEpoch:report.bestEpoch,heldOutAgreement:round(report.heldOut.agreement),
      trainAgreement:round(report.train.agreement),freshAgreement:round(freshAgreement),
      f1:Object.fromEntries(report.heldOut.keys.map(k=>[k.key,round(k.f1,3)])),
      spawn:{teacher:[own[0],rounds[0][0].crashedAt],clone:[copy[0],rounds[0][1].crashedAt],forwardOnly:[forward[0],rounds[0][2].crashedAt]},
      starts:{teacher:sum(own),clone:sum(copy),forwardOnly:sum(forward),cloneMiss:miss(copy),forwardMiss:miss(forward),
        cloneExact:copy.filter((p,i)=>p===own[i]).length,forwardWithinOne:forward.filter((p,i)=>Math.abs(p-own[i])<=1).length,
        crashDiffers:rounds.filter(r=>(r[0].crashedAt===null)!==(r[1].crashedAt===null)).length},
      lags:report.lags.map(l=>[l.lag,round(l.screenLoss),round(l.finalLoss)]),maxAbsWeight:round(report.maxAbsWeight,1),ms:report.ms}));
  });
}

test('the same seed gives the same weights, and the dataset is left unchanged',()=>{
  const {dataset}=teacher('Triangle');
  const before=[dataset.inputs.slice(),dataset.keys.slice(),dataset.episode.slice()];
  const options={lags:[1,2],maxEpochs:12};
  const a=trainClone(dataset,options),b=trainClone(dataset,options);
  assert.deepEqual(a.weights,b.weights);
  const {ms:_a,...reportA}=a.report,{ms:_b,...reportB}=b.report;
  assert.deepEqual(reportA,reportB);
  assert.notDeepEqual(trainClone(dataset,{...options,seed:'another seed'}).weights,a.weights);
  assert.deepEqual([dataset.inputs,dataset.keys,dataset.episode],before);
  const synthetic=syntheticDataset({seed:'clone-determinism'});
  assert.deepEqual(trainClone(synthetic,{maxEpochs:5}).weights,trainClone(synthetic,{maxEpochs:5}).weights);
});

test('the lag choice finds keys that act late, or the nearest candidate',t=>{
  // Teachers evolved with keys that act 9 steps late (a 150 ms reaction), so
  // they are adapted to that delay, as a person is. They crash often and hold
  // some keys almost always; the timing shows in the keys that change. The
  // keys that fit the inputs of step t are held at step t + 10.
  const found={},nearest={},loss=report=>Object.fromEntries(report.lags.map(l=>[l.lag,round(l.finalLoss??l.screenLoss)]));
  for(const track of ['Rectangle','Triangle']){
    const {dataset}=teacher(track,9);
    assert.ok(keyShare(dataset).filter(s=>s>.02&&s<.98).length>=2,'at least two keys change');
    const all=trainClone(dataset).report,below=trainClone(dataset,{lags:[1,4,9,13,16]}).report,above=trainClone(dataset,{lags:[1,4,7,11,16]}).report;
    assert.equal(all.lag,10,track);
    assert.equal(below.lag,9,`${track}: 9 is nearer to 10 than 13 is`);
    assert.equal(above.lag,11,`${track}: 11 is nearer to 10 than 7 is`);
    found[track]={lag:all.lag,agreement:round(all.heldOut.agreement),loss:loss(all)};
    nearest[track]={below:{lag:below.lag,agreement:round(below.heldOut.agreement),loss:loss(below)},above:{lag:above.lag,agreement:round(above.heldOut.agreement),loss:loss(above)}};
  }
  // The game-timed Triangle teacher with its keys delayed 5 steps in the
  // simulator (it drives worse, but differently enough).
  const late=teacher('Triangle'),late5=record(late.sim,late.vector,{delay:5,episodes:40,rows:12000,seconds:15,seed:'clone-late5-Triangle'});
  const five=trainClone(late5.dataset).report;
  assert.equal(five.lag,6);
  t.diagnostic(JSON.stringify({delay9:found,delay9Without10:nearest,triangleDelay5:{lag:five.lag,agreement:round(five.heldOut.agreement),loss:loss(five)}}));
});

test('known limit: the lag cannot be found when every run is the same short crash',{todo:'the lag is not identifiable from this data'},()=>{
  // The game-timed Rectangle teacher with keys 9 steps late crashes after
  // about 2.2 s in every run, with few key changes. It picks 8 instead of 10.
  const {sim,vector}=teacher('Rectangle');
  const {dataset}=record(sim,vector,{delay:9,episodes:40,rows:12000,seconds:15,seed:'clone-late-Rectangle'});
  assert.equal(trainClone(dataset).report.lag,10);
});

test('empty, malformed, and non-finite datasets are refused with a reason',()=>{
  const empty={inputs:new Float32Array(0),keys:new Uint8Array(0),episode:new Uint32Array(0)};
  assert.throws(()=>trainClone(empty),fails('not-enough-data'));
  assert.throws(()=>trainClone(undefined),fails('invalid-data'));
  assert.throws(()=>trainClone({inputs:new Float32Array(10),keys:new Uint8Array(4),episode:new Uint32Array(2)}),fails('invalid-data'));
  assert.throws(()=>trainClone({inputs:new Float32Array(20),keys:new Uint8Array(8)}),fails('invalid-data'));
  for(const bad of [NaN,Infinity]){
    const d=syntheticDataset({runs:1,steps:600});d.inputs[123]=bad;
    assert.throws(()=>trainClone(d),fails('invalid-data'));
  }
  const tooLarge=syntheticDataset({runs:1,steps:600});
  assert.throws(()=>trainClone({...tooLarge,inputs:Float64Array.from(tooLarge.inputs,(v,i)=>i===3?1e39:v)}),fails('invalid-data'),'1e39 is not a 32-bit number');
  assert.throws(()=>trainClone({...tooLarge,inputs:BigInt64Array.from(tooLarge.inputs,()=>1n)}),fails('invalid-data'),'BigInt inputs');
  const plain=syntheticDataset({runs:1,steps:600});
  const nulls={...plain,inputs:Array.from(plain.inputs,(v,i)=>i===7?null:v)};
  assert.throws(()=>trainClone(nulls),fails('invalid-data'),'null is not an input');
  for(const key of [2,-1,.5,'1',255]){
    const d=syntheticDataset({runs:1,steps:600});const keys=Array.from(d.keys);keys[9]=key;
    assert.throws(()=>trainClone({...d,keys}),fails('invalid-data'),String(key));
  }
  const booleans=syntheticDataset({runs:2,steps:600,seed:'booleans'});
  assert.deepEqual(trainClone({...booleans,keys:Array.from(booleans.keys,Boolean)},{maxEpochs:2}).weights,trainClone(booleans,{maxEpochs:2}).weights);
  const d=syntheticDataset({runs:1,steps:600});
  for(const options of [{lags:[0]},{lags:[1.5]},{lags:[200]},{lags:[]},{lags:4},{heldOutFraction:0},{heldOutFraction:1},{batchSize:0},
    {learningRate:NaN},{learningRate:0},{learningRate:2},{patience:0},{screenEpochs:0},{finalists:1.5},{rareCap:.5},{minScoredPairs:0}])
    assert.throws(()=>trainClone(d,options),fails('invalid-options'),JSON.stringify(options));
  // Options left undefined take their defaults.
  const small=syntheticDataset({runs:2,steps:600,seed:'undefined-options'});
  assert.deepEqual(trainClone(small,{maxEpochs:3,batchSize:undefined,lags:undefined}).weights,trainClone(small,{maxEpochs:3}).weights);
  assert.ok(trainClone(small,null).weights.every(Number.isFinite),"null options use the defaults");
});

test('a dataset too small to compare lags is refused; a small one that can still trains',()=>{
  assert.throws(()=>trainClone(syntheticDataset({runs:1,steps:130})),fails('not-enough-data'),'130 steps are one block');
  assert.throws(()=>trainClone(syntheticDataset({runs:1,steps:1})),fails('not-enough-data'));
  // 480 steps = four 120-step blocks, one held out: 120 - k held-out pairs at lag k.
  const d=syntheticDataset({runs:1,steps:480,seed:'small'});
  const {weights,report}=trainClone(d);
  assert.ok(weights.every(Number.isFinite));
  assert.deepEqual([report.split.blocks,report.split.heldOutBlocks,report.skippedLags],[4,1,[]]);
  assert.equal(report.scoredPairs,104);
  // Asking for 110 scored pairs drops the lags that leave fewer (12, 14, 16).
  const strict=trainClone(d,{minScoredPairs:110}).report;
  assert.deepEqual(strict.skippedLags,[12,14,16]);assert.equal(strict.scoredPairs,110);
  assert.throws(()=>trainClone(d,{minScoredPairs:200}),fails('not-enough-data'));
});

test('a key that is never pressed, or always pressed, is copied as such',()=>{
  const d=syntheticDataset({runs:6,steps:400,seed:'one-key',never:[3],always:[0]});
  const {weights,report}=trainClone(d);
  assert.equal(report.keyBalance.reverse,0);assert.equal(report.keyBalance.forward,1);
  const reverse=report.heldOut.keys[3],forward=report.heldOut.keys[0];
  assert.deepEqual([reverse.support,reverse.predicted,reverse.f1,reverse.precision,reverse.recall],[0,0,null,null,null]);
  assert.equal(forward.f1,1);assert.equal(forward.predicted,report.heldOut.pairs);
  assert.ok(weights.every(Number.isFinite));
  // The copy never presses reverse on any step of the recording.
  const {data,rows}=allPairs(d,1);
  assert.equal(evaluate(weights,data,rows,1).keys[3].predicted,0);
});

test('pairs never cross a run boundary or a train/held-out boundary',()=>{
  // Episode ids 7, 3, 7: the reused 7 is a new run, because its rows do not follow on.
  const dataset={inputs:new Float32Array(8*10),keys:new Uint8Array(8*4),episode:Uint32Array.from([7,7,7,3,3,3,7,7])};
  const data=prepareDataset(dataset),none={held:new Uint8Array(8)};
  assert.deepEqual(Array.from(data.run),[0,0,0,1,1,1,2,2]);
  assert.deepEqual(Array.from(pairRows(data,none,1).train),[0,1,3,4,6]);
  assert.deepEqual(Array.from(pairRows(data,none,2).train),[0,3]);
  assert.deepEqual(Array.from(pairRows(data,none,3).train),[]);
  const split={held:Uint8Array.from([0,0,1,1,1,0,0,0])};
  const both=pairRows(data,split,1);
  assert.deepEqual([Array.from(both.train),Array.from(both.heldOut)],[[0,6],[3]]);
  // Runs of two steps have no pair at lag 2, however many rows there are.
  const pairsOfTwo=syntheticDataset({runs:1,steps:2000});
  pairsOfTwo.episode=Uint32Array.from(pairsOfTwo.episode,(_,t)=>t>>1);
  assert.throws(()=>trainClone(pairsOfTwo,{lags:[2]}),fails('not-enough-data'));
  const report=trainClone(pairsOfTwo,{lags:[1,2],maxEpochs:3}).report;
  assert.equal(report.lag,1);assert.deepEqual(report.skippedLags,[2]);assert.equal(report.train.pairs+report.heldOut.pairs,1000);
});

test('held-out rows are whole blocks of consecutive steps, chosen by the seed',()=>{
  const d=syntheticDataset({runs:3,steps:1000,seed:'blocks'}),data=prepareDataset(d);
  const split=splitBlocks(data,{blockSteps:120,heldOutFraction:.2,seed:'s'});
  // 1000 = 8 blocks of 120 and 40 left over; less than half a block joins the last one.
  assert.equal(split.blocks,24);
  const sizes=new Map();for(const b of split.block)sizes.set(b,(sizes.get(b)||0)+1);
  assert.deepEqual([...new Set(sizes.values())].sort((a,b)=>a-b),[120,160]);
  for(let t=1;t<data.n;t++)if(split.block[t]===split.block[t-1]){
    assert.equal(split.held[t],split.held[t-1],'a block is never split');assert.equal(data.run[t],data.run[t-1],'a block stays in one run');
  }
  const heldShare=split.held.reduce((s,v)=>s+v,0)/data.n;
  assert.ok(heldShare>=.2&&heldShare<.2+160/data.n,`held-out share ${heldShare}`);assert.equal(split.heldOutShare,heldShare);
  assert.deepEqual(splitBlocks(data,{blockSteps:120,heldOutFraction:.2,seed:'s'}).held,split.held);
  assert.notDeepEqual(splitBlocks(data,{blockSteps:120,heldOutFraction:.2,seed:'t'}).held,split.held);
  const two=splitBlocks(prepareDataset(syntheticDataset({runs:1,steps:240})),{blockSteps:120,heldOutFraction:.9,seed:'s'});
  assert.equal(two.heldOutBlocks,1,'at least one block always trains');
  // A run shorter than a block is one block; with the last piece of 60 or more, it is its own block.
  assert.equal(splitBlocks(prepareDataset(syntheticDataset({runs:2,steps:100})),{blockSteps:120,heldOutFraction:.2,seed:'s'}).blocks,2);
  assert.equal(splitBlocks(prepareDataset(syntheticDataset({runs:1,steps:300})),{blockSteps:120,heldOutFraction:.2,seed:'s'}).blocks,3);
});

test('linked rows (for mirrored copies) stay on the side of the row they copy',()=>{
  const base=syntheticDataset({runs:2,steps:600,seed:'mirror'}),n=1200;
  // Rows 1200..2399 copy rows 0..1199 as separate runs.
  const dataset={inputs:new Float32Array(2*n*10),keys:new Uint8Array(2*n*4),episode:new Uint32Array(2*n),sameSplitAs:new Int32Array(2*n).fill(-1)};
  dataset.inputs.set(base.inputs);dataset.inputs.set(base.inputs,n*10);dataset.keys.set(base.keys);dataset.keys.set(base.keys,n*4);
  for(let t=0;t<n;t++){dataset.episode[t]=base.episode[t];dataset.episode[n+t]=base.episode[t]+2;dataset.sameSplitAs[n+t]=t;}
  const data=prepareDataset(dataset),split=splitBlocks(data,{blockSteps:120,heldOutFraction:.2,seed:'m'});
  for(let t=0;t<n;t++)assert.equal(split.held[n+t],split.held[t]);
  assert.ok(split.held.subarray(0,n).some(Boolean),'the originals were split');
  assert.ok(trainClone(dataset,{maxEpochs:2}).weights.every(Number.isFinite));
  for(const bad of [[5,5],[5,-2],[5,2*n],[5,1.5],[5,-1.5],[5,'-1'],[n+1,n]]){
    const links=Array.from(dataset.sameSplitAs);links[bad[0]]=bad[1];
    assert.throws(()=>prepareDataset({...dataset,sameSplitAs:links}),fails('invalid-data'),JSON.stringify(bad));
  }
  assert.throws(()=>prepareDataset({...dataset,sameSplitAs:new Int32Array(3)}),fails('invalid-data'));
  // Only whole runs may be linked.
  const half=dataset.sameSplitAs.slice();half.fill(-1,n,n+300);
  assert.throws(()=>prepareDataset({...dataset,sameSplitAs:half}),fails('invalid-data'));
});

test("H1's stored demonstrations convert to the trainer's dataset as the plan says",()=>{
  // A stored demonstration: keys as a bitmask, and the physics step of each
  // sample, with gaps (a pause, a crash) between runs of consecutive steps.
  const sampleSteps=Uint32Array.from([...Array(300).keys()].map(i=>i+1).concat([...Array(200).keys()].map(i=>i+400),[...Array(250).keys()].map(i=>i+700)));
  const n=sampleSteps.length,random=seededRandom('h1-store');
  const demo={sampleSteps,inputs:Float32Array.from({length:n*10},()=>random()),keys:Uint8Array.from({length:n},()=>Math.floor(random()*16))};
  // The conversion in the plan's H3 note, done by H2's learning/dataset.js
  // (tests/dataset.test.mjs checks it on recorder output).
  const {inputs,keys,episode}=demonstrationDataset(demo);
  assert.deepEqual(inputs,demo.inputs);assert.deepEqual(Array.from(new Set(episode)),[0,1,2]);
  for(let i=0;i<n;i++)for(let o=0;o<4;o++)assert.equal(keys[i*4+o],demo.keys[i]>>o&1);
  const data=prepareDataset({inputs,keys,episode});
  assert.equal(data.run[n-1],2,'three runs');
  for(const k of [1,2,9,16])assert.deepEqual(pairRows(data,{held:new Uint8Array(n)},k).train,lagPairs(demo,k),`lag ${k}`);
  // Bit o of H1's key mask is key o of the trainer.
  assert.deepEqual(KEY_ORDER,KEY_NAMES);
  KEY_NAMES.forEach((key,o)=>assert.equal(keyBits({[key]:true}),1<<o,key));
});

// The real module worker script, driven through a stand-in worker scope
// (Node has no `self`; the script reads it on every message).
async function workerSpawner(){
  const scope={};
  globalThis.self=scope;
  await import('../AI-Car-Racer/learning/clone-worker.js');
  const workers=[];
  const spawn=()=>{
    const worker={terminated:false,onmessage:null,onerror:null,
      postMessage(message){setTimeout(()=>{if(!worker.terminated)scope.onmessage({data:structuredClone(message)});},0);},
      terminate(){worker.terminated=true;}};
    scope.postMessage=message=>{const copy=structuredClone(message);setTimeout(()=>{if(!worker.terminated)worker.onmessage?.({data:copy});},0);};
    workers.push(worker);return worker;
  };
  return {spawn,workers};
}

test('the worker wrapper returns the same clone, reports progress, errors, and cancels',async()=>{
  const {spawn,workers}=await workerSpawner(),dataset=syntheticDataset({seed:'clone-worker'}),options={lags:[1,2],maxEpochs:6};
  const progress=[];
  const result=await trainCloneInWorker(dataset,{...options,spawn,onProgress:p=>progress.push(p)});
  assert.deepEqual(result.weights,trainClone(dataset,options).weights);
  assert.ok(result.weights instanceof Float32Array&&result.report.lag>=1);
  assert.ok(progress.length>0&&progress.every(p=>['screen','train'].includes(p.phase)&&Number.isFinite(p.loss)));
  assert.equal(workers.at(-1).terminated,true,'the worker is stopped after a result');
  await assert.rejects(trainCloneInWorker({inputs:new Float32Array(0),keys:new Uint8Array(0),episode:new Uint32Array(0)},{spawn}),fails('not-enough-data'));
  assert.equal(workers.at(-1).terminated,true);
  await assert.rejects(trainCloneInWorker(dataset,{spawn,signal:AbortSignal.abort()}),{name:'AbortError'});
  const controller=new AbortController(),pending=trainCloneInWorker(dataset,{...options,spawn,signal:controller.signal});
  controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(workers.at(-1).terminated,true,'cancelling stops the worker');
  // A worker that fails to load, or cannot start, rejects instead of hanging.
  const broken=()=>{const w={terminate(){w.terminated=true;},postMessage(){setTimeout(()=>w.onerror({message:'load failed',preventDefault(){}}),0);}};return w;};
  await assert.rejects(trainCloneInWorker(dataset,{spawn:broken}),fails('worker-failed'));
  await assert.rejects(trainCloneInWorker(dataset,{spawn:()=>{throw new Error('no workers here');}}),fails('worker-failed'));
  await assert.rejects(trainCloneInWorker(dataset,null),fails('worker-failed'),'Node has no Worker');
  // A progress callback that throws is logged, and the result still arrives.
  const logged=[],error=console.error;console.error=(...args)=>logged.push(args);
  try{
    const again=await trainCloneInWorker(dataset,{...options,spawn,onProgress:()=>{throw new Error('panel gone');}});
    assert.deepEqual(again.weights,result.weights);assert.ok(logged.length>0);
  }finally{console.error=error;}
});

test('defaults match the plan',()=>{
  assert.equal(CLONE_DEFAULTS.blockSteps,120,'2-second held-out blocks at 60 steps per second');
  assert.equal(CLONE_DEFAULTS.lags[0],1);assert.ok(CLONE_DEFAULTS.lags.includes(10)&&CLONE_DEFAULTS.lags.at(-1)>=16,'covers a 150-250 ms reaction');
  assert.ok(Object.isFrozen(CLONE_DEFAULTS));
});
