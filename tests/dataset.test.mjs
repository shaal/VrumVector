// The cloning dataset (H2, AI-Car-Racer/learning/dataset.js): the mirror is
// proved with the real sensors on mirrored presets, stored demonstrations from
// H1's recorder convert to the trainer's rows, and labelled rest steps teach a
// clone to pull away from rest. Measured numbers:
// docs/validation/human-demonstration.md (H2).
import test from 'node:test';
import assert from 'node:assert/strict';
import {Simulation} from './helpers/simulation.mjs';
import {evolveTeacher,drive} from './helpers/teacher.mjs';
import {demonstrate,mirroredSimulation} from './helpers/demonstrator.mjs';
import {demonstrationDataset,mirrorInputs,mirrorKeyBits,mirrorBrain,MIRROR_SOURCE,DATASET_DEFAULTS} from '../AI-Car-Racer/learning/dataset.js';
import {trainClone,prepareDataset,splitBlocks,pairRows,predict,CloneError} from '../AI-Car-Racer/learning/clone.js';
import {lagPairs,DEMO_VERSION,REST_STEPS} from '../AI-Car-Racer/learning/demonstration.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const TRACKS=['Rectangle','Triangle'];
const fails=code=>error=>error instanceof CloneError&&error.code===code;
// Scripted drivers that take the 10 inputs and return [forward, left, right, reverse].
// The wall follower keeps to the middle at a low speed and laps Rectangle.
const follower=x=>{const d=(x[0]+x[1]+x[2])-(x[4]+x[5]+x[6]);return [x[7]<.35,d<-.05,d>.05,false];};
// The racer drives fast, slides, and sometimes crashes.
const racer=x=>{const d=(x[0]+x[1]+x[2])-(x[4]+x[5]+x[6]);return [x[7]<.9,d<-.02,d>.02,x[3]>.8&&x[7]>.5];};
const row=(inputs,i)=>Array.from(inputs.subarray(i*10,(i+1)*10));
const bitsOf=(keys,i)=>keys[i*4]|keys[i*4+1]<<1|keys[i*4+2]<<2|keys[i*4+3]<<3;
const noSplit=data=>({held:new Uint8Array(data.n)});

// A car that only senses: put it at a pose and run perception once.
function probe(sim){
  const car=new sim.scope.CarClass(sim.spawn.x,sim.spawn.y,30,50,'AI',sim.maxSpeed,sim.spawn.angle);car.useBrain=false;
  return pose=>{Object.assign(car,pose,{checkPointsPassed:pose.checkPointsPassed.slice()});car.updatePerception(sim.road.borders,sim.road.checkPointList);return car.lastInputs;};
}

test('the mirror, with the real sensors: a mirrored pose on the mirrored track sees the mirrored inputs',t=>{
  const found={};
  for(const track of TRACKS){
    const sim=new Simulation({track,seed:'mirror-proof'}),mirrored=mirroredSimulation({track,seed:'mirror-proof'}),sense=probe(mirrored);
    let worst=0,poses=0;
    const check=(inputs,pose)=>{
      const seen=sense({...mirrored.mirror(pose),speed:pose.speed,checkPointsPassed:pose.checkPointsPassed});
      const expected=mirrorInputs(inputs);
      for(let j=0;j<10;j++)worst=Math.max(worst,Math.abs(seen[j]-expected[j]));
      poses++;
    };
    // Along real drives (laps, turns both ways, slides, crashes).
    for(const driver of [follower,racer]){
      const car=new sim.scope.CarClass(sim.spawn.x,sim.spawn.y,30,50,'AI',sim.maxSpeed,sim.spawn.angle);car.useBrain=false;
      let keys=[false,false,false,false];
      for(let f=1;f<=3600&&!car.damaged;f++){
        sim.scope.frameCount=f;[car.controls.forward,car.controls.left,car.controls.right,car.controls.reverse]=keys;
        car.update(sim.road.borders,sim.road.checkPointList);
        check(car.lastInputs,car);keys=driver(car.lastInputs);
      }
    }
    // Anywhere on the canvas, any heading, speed, and next checkpoint.
    const random=seededRandom('mirror-poses-'+track),gates=sim.road.checkPointList.length,sense0=probe(sim);
    for(let i=0;i<3000;i++){
      const pose={x:200+random()*2800,y:100+random()*1600,angle:(random()*2-1)*Math.PI,speed:random()*22.5-7.5,
        checkPointsPassed:random()<.2?[]:[Math.floor(random()*gates)]};
      check(Float32Array.from(sense0(pose)),pose);
    }
    assert.ok(worst<=1e-6,`${track}: largest difference ${worst}`);
    found[track]={poses,worst};
  }
  t.diagnostic(JSON.stringify(found));
});

// The teachers of tests/cloning.test.mjs (short genetic runs, fixed seed).
const teachers=new Map();
const teacherFor=track=>{if(!teachers.has(track))teachers.set(track,evolveTeacher({track,seed:'clone-teacher-b',generations:24,population:24,seconds:15}));return teachers.get(track);};

test('the car physics mirrors too, except on a step where only one of the two slides ends',t=>{
  // Car.#move ends a slide when |velocity.x| - speed * sin(angle) and
  // |velocity.y| - speed * sin(angle) are both small. The mirror image flips
  // the sign of sin(angle) but not of |velocity.x|, so the two cars can
  // disagree on that step. Until then, a mirrored car driven
  // with left and right swapped follows the mirror image of the original.
  // A slider that laps Rectangle while sliding most of the time, and the teacher.
  const slider=x=>{const d=(x[0]+x[1]+x[2])-(x[4]+x[5]+x[6]);return [x[7]<.5,d<-.02,d>.02,false];};
  const found={};let separated=0;
  for(const track of TRACKS){
    const sim=new Simulation({track,seed:'mirror-physics'}),mirrored=mirroredSimulation({track,seed:'mirror-physics'}),{vector}=teacherFor(track);
    for(const [name,driver] of [['slider',slider],['teacher',x=>predict(vector,x)]]){
      const a=new sim.scope.CarClass(sim.spawn.x,sim.spawn.y,30,50,'AI',sim.maxSpeed,sim.spawn.angle);
      const b=new mirrored.scope.CarClass(mirrored.spawn.x,mirrored.spawn.y,30,50,'AI',mirrored.maxSpeed,mirrored.spawn.angle);
      a.useBrain=b.useBrain=false;
      let keys=[false,false,false,false],steps=0,slides=0,slideDiffers=null,apart=0;
      for(let f=1;f<=3600&&!a.damaged&&!b.damaged;f++){
        sim.scope.frameCount=mirrored.scope.frameCount=f;
        [a.controls.forward,a.controls.left,a.controls.right,a.controls.reverse]=Array.from(keys,Boolean);
        [b.controls.forward,b.controls.left,b.controls.right,b.controls.reverse]=[keys[0],keys[2],keys[1],keys[3]].map(Boolean);
        a.update(sim.road.borders,sim.road.checkPointList);b.update(mirrored.road.borders,mirrored.road.checkPointList);
        const m=mirrored.mirror(a);
        if(slideDiffers===null&&a.slide!==b.slide)slideDiffers=f;
        if(slideDiffers===null){
          assert.ok(Math.abs(m.x-b.x)<1e-6&&Math.abs(m.y-b.y)<1e-6&&Math.abs(m.angle-b.angle)<1e-9&&Math.abs(a.speed-b.speed)<1e-9,`${track} ${name} step ${f}`);
          assert.deepEqual(Array.from(b.checkPointsPassed),Array.from(a.checkPointsPassed)); // two vm realms
          steps=f;slides+=a.slide?1:0;
        }else apart=Math.max(apart,Math.hypot(m.x-b.x,m.y-b.y));
        keys=driver(a.lastInputs);
      }
      if(slideDiffers!==null&&apart>1)separated++;
      found[`${track} ${name}`]={mirroredSteps:steps,slidingSteps:slides,slideDiffersAt:slideDiffers,apartAfter:Math.round(apart)};
    }
  }
  // The limit is real: at least one drive splits at such a step (the
  // Rectangle teacher, at step 133), and the two paths then separate.
  assert.ok(separated>=1,JSON.stringify(found));
  t.diagnostic(JSON.stringify(found));
});

test('mirrorBrain drives the mirror image: same keys on mirrored inputs, left and right swapped',()=>{
  const random=seededRandom('mirror-brain');let checked=0;
  for(let n=0;n<300;n++){
    const scale=n<150?1:40,flat=Float32Array.from({length:244},()=>(random()*2-1)*scale),mirror=mirrorBrain(flat);
    assert.deepEqual(mirrorBrain(mirror),flat,'the mirror of the mirror is the original');
    for(let s=0;s<20;s++){
      const x=Float32Array.from({length:10},(_,j)=>j<8?random():random()*.6-.3);
      const a=predict(flat,x),b=predict(mirror,mirrorInputs(x));
      assert.deepEqual([b[0],b[1],b[2],b[3]],[a[0],a[2],a[1],a[3]]);checked++;
    }
  }
  assert.equal(checked,6000);
  assert.deepEqual([0,1,2,4,6,8,9,15].map(mirrorKeyBits),[0,1,4,2,6,8,9,15]);
  assert.deepEqual(MIRROR_SOURCE,[6,5,4,3,2,1,0,7,8,9]);
  assert.throws(()=>mirrorBrain(new Float32Array(10)),fails('invalid-data'));
  for(const bad of [NaN,Infinity,'1'])assert.throws(()=>mirrorBrain(Array.from({length:244},(_,k)=>k===7?bad:0)),fails('invalid-data'),String(bad));
  const x=Float32Array.from({length:10},(_,j)=>j/10-.3),copy=mirrorInputs(x);
  assert.deepEqual(mirrorInputs(x,x),copy,'mirroring in place gives the same result');
  assert.equal(Object.is(mirrorInputs(new Float32Array(10))[9],0),true,'no negative zero');
});

// Recorded by H1's recorder in the simulator: runs that wait at rest, then drive.
const recorded=(()=>{let cache=null;return ()=>cache??=(()=>{
  const sim=new Simulation({track:'Rectangle',seed:'dataset-record'});
  const out=demonstrate(sim,racer,{runs:12,rows:6000,seconds:12,wait:40,seed:'dataset-record'});
  return {...out,sim};
})();})();

test("H1's stored demonstrations convert to the trainer's rows: episodes at gaps, key bits, the same pairs as lagPairs",()=>{
  const {demonstration:demo}=recorded();
  assert.equal(demo.version,DEMO_VERSION);assert.ok(demo.crashes>=2,'some runs end in a crash');
  assert.ok(demo.restSamples>=REST_STEPS*6,'each run keeps its rest steps');
  const ds=demonstrationDataset(demo,{rest:'keep'}),n=demo.samples;
  assert.equal(ds.episode.length,n);assert.equal(ds.inputs.length,n*10);assert.equal(ds.keys.length,n*4);assert.equal(ds.sameSplitAs,undefined);
  assert.deepEqual(ds.inputs,demo.inputs);
  for(let i=0;i<n;i++)assert.equal(bitsOf(ds.keys,i),demo.keys[i]);
  // A new episode exactly where the step numbers jump.
  for(let i=1;i<n;i++)assert.equal(ds.episode[i]!==ds.episode[i-1],demo.sampleSteps[i]!==demo.sampleSteps[i-1]+1,`row ${i}`);
  const data=prepareDataset(ds);
  for(const k of [1,2,9,16])assert.deepEqual(pairRows(data,noSplit(data),k).train,lagPairs(demo,k),`lag ${k}`);
  assert.deepEqual([ds.report.samples,ds.report.rows,ds.report.runs,ds.report.restRows,ds.report.crashes],[n,n,ds.episode[n-1]+1,demo.restSamples,demo.crashes]);
  // The key balance: the share of rows with each key held.
  ['forward','left','right','reverse'].forEach((key,o)=>assert.equal(ds.report.keyBalance[key],demo.keys.reduce((sum,k)=>sum+(k>>o&1),0)/n,key));
  // Several demonstrations: each starts a run of its own, even if its step numbers go on.
  const next={...demo,sampleSteps:Uint32Array.from(demo.sampleSteps,s=>s+demo.sampleSteps[n-1]+1),crashSteps:Uint32Array.from(demo.crashSteps,s=>s+demo.sampleSteps[n-1]+1)};
  next.sampleSteps.set(Uint32Array.from(next.sampleSteps.subarray(0,1),()=>demo.sampleSteps[n-1]+1));
  const two=demonstrationDataset([demo,next],{rest:'keep'});
  assert.equal(two.episode[n],two.episode[n-1]+1);assert.equal(two.report.demonstrations,2);
  // A JSON copy (plain arrays) converts the same.
  const plain=JSON.parse(JSON.stringify({...demo,inputs:Array.from(demo.inputs),keys:Array.from(demo.keys),sampleSteps:Array.from(demo.sampleSteps),rest:Array.from(demo.rest),crashSteps:Array.from(demo.crashSteps)}));
  const again=demonstrationDataset(plain);assert.deepEqual([again.inputs,again.keys,again.episode],[...(({inputs,keys,episode})=>[inputs,keys,episode])(demonstrationDataset(demo))]);
  // A version 1 demonstration (before H2) has no rest rows.
  const {rest:_rest,restSamples:_count,...v1}=demo;
  const old=demonstrationDataset({...v1,version:1});
  assert.equal(old.report.restRows,0);assert.equal(old.report.rows,n);
});

test('rest steps get the keys that first moved the car, or are dropped',()=>{
  const {demonstration:demo}=recorded(),n=demo.samples;
  const label=demonstrationDataset(demo),drop=demonstrationDataset(demo,{rest:'drop'}),keep=demonstrationDataset(demo,{rest:'keep'});
  assert.equal(DATASET_DEFAULTS.rest,'label');
  let blocks=0;
  for(let i=0;i<n;i++){
    if(!demo.rest[i]){assert.equal(bitsOf(label.keys,i),demo.keys[i]);continue;}
    let end=i;while(demo.rest[end])end++;
    assert.equal(demo.sampleSteps[end],demo.sampleSteps[end-1]+1,'the move follows the last rest step');
    for(let r=i;r<end;r++){assert.equal(bitsOf(label.keys,r),demo.keys[end],`row ${r}`);assert.equal(bitsOf(keep.keys,r),demo.keys[r]);}
    assert.equal(demo.keys[end]&1,1,'the racer pulls away with W');blocks++;i=end;
  }
  assert.ok(blocks>=6);assert.equal(label.report.restRows,demo.restSamples);
  assert.equal(drop.report.rows,n-demo.restSamples);assert.equal(drop.report.restDropped,demo.restSamples);
  // Dropped rest rows leave the first moving row at the start of its run.
  const kept=[...Array(n).keys()].filter(i=>!demo.rest[i]);
  kept.forEach((i,r)=>assert.deepEqual(row(drop.inputs,r),row(demo.inputs,i)));
  // A rest block that is not followed by the move (the recorder never stores
  // one) is dropped, whatever the mode.
  const odd={version:2,inputs:new Float32Array(8*10),keys:Uint8Array.from([0,0,1,1,0,0,1,1]),sampleSteps:Uint32Array.from([1,2,3,4,6,7,9,10]),
    rest:Uint8Array.from([1,1,0,0,1,1,0,0])};
  for(const mode of ['label','keep','drop']){
    const d=demonstrationDataset(odd,{rest:mode});
    assert.equal(d.report.rows,mode==='drop'?4:6,mode);
    if(mode!=='drop')assert.equal(d.report.restDropped,2,'the block at steps 6-7 is followed by a gap');
  }
  assert.deepEqual(Array.from(demonstrationDataset(odd).keys.subarray(0,8)),[1,0,0,0,1,0,0,0],'labelled with the keys of step 3');
  // A crash soon after the start: crashTrim drops the move, so the rest steps
  // before it go too (they would teach nothing about pulling away).
  // Rest at steps 1-30, the move at 31, a crash at step 40.
  const quick={version:2,inputs:new Float32Array(39*10),keys:Uint8Array.from({length:39},(_,i)=>i<30?0:1),
    sampleSteps:Uint32Array.from({length:39},(_,i)=>i+1),rest:Uint8Array.from({length:39},(_,i)=>i<30?1:0),crashSteps:Uint32Array.from([40])};
  const counts=d=>[d.report.rows,d.report.crashDropped,d.report.restDropped,d.report.restRows];
  for(const mode of ['label','keep'])assert.deepEqual(counts(demonstrationDataset(quick,{rest:mode,crashTrim:9})),[0,9,30,0],mode);
  assert.deepEqual(counts(demonstrationDataset(quick,{crashTrim:15})),[0,15,24,0],'the window reaches into the rest steps');
  assert.deepEqual(counts(demonstrationDataset(quick,{crashTrim:5})),[34,5,0,30],'the move is kept, and so are its rest steps');
});

test('crashTrim drops the last steps before each crash',()=>{
  const {demonstration:demo}=recorded();
  for(const trim of [30,60]){
    const ds=demonstrationDataset(demo,{crashTrim:trim}),keep=[];
    for(let i=0;i<demo.samples;i++)if(!demo.crashSteps.some(c=>c-trim<=demo.sampleSteps[i]&&demo.sampleSteps[i]<c))keep.push(i);
    assert.equal(ds.report.rows,keep.length);assert.equal(ds.report.crashDropped,demo.samples-keep.length);
    assert.ok(ds.report.crashDropped>=trim*2,'at least two crashed runs lose their tail');
    keep.forEach((i,r)=>assert.deepEqual(row(ds.inputs,r),row(demo.inputs,i)));
    for(let r=1;r<keep.length;r++)assert.equal(ds.episode[r]!==ds.episode[r-1],demo.sampleSteps[keep[r]]!==demo.sampleSteps[keep[r-1]]+1);
  }
  assert.equal(demonstrationDataset(demo).report.crashDropped,0,'the default keeps them');
});

test('mirroring adds each run as its mirror image, linked so a block and its mirror share a side of the split',()=>{
  const {demonstration:demo}=recorded();
  const base=demonstrationDataset(demo),ds=demonstrationDataset(demo,{mirror:true}),n=base.report.rows;
  assert.equal(ds.report.rows,2*n);assert.equal(ds.report.mirroredRows,n);assert.equal(ds.report.runs,2*base.report.runs);
  assert.deepEqual(ds.inputs.subarray(0,n*10),base.inputs);assert.deepEqual(ds.keys.subarray(0,n*4),base.keys);
  const originals=new Set(base.episode),mirrors=new Set();
  for(let t=0;t<n;t++){
    const u=n+t;
    assert.equal(ds.sameSplitAs[t],-1);assert.equal(ds.sameSplitAs[u],t);
    assert.deepEqual(row(ds.inputs,u),Array.from(mirrorInputs(base.inputs.subarray(t*10,t*10+10))));
    assert.equal(bitsOf(ds.keys,u),mirrorKeyBits(bitsOf(base.keys,t)));
    assert.ok(!originals.has(ds.episode[u]));mirrors.add(ds.episode[u]);
    if(t)assert.equal(ds.episode[u]===ds.episode[u-1],base.episode[t]===base.episode[t-1]);
  }
  assert.equal(mirrors.size,originals.size,'one mirrored run per run');
  // Left and right are balanced once mirrored.
  assert.equal(ds.report.keyBalance.left,ds.report.keyBalance.right);
  const data=prepareDataset(ds),split=splitBlocks(data,{blockSteps:120,heldOutFraction:.2,seed:'mirror-split'});
  for(let t=0;t<n;t++)assert.equal(split.held[n+t],split.held[t]);
  assert.ok(trainClone(ds,{lags:[1],maxEpochs:2}).weights.every(Number.isFinite));
});

test('malformed demonstrations and options are refused with a reason',()=>{
  const {demonstration:demo}=recorded();
  const bad=(change,why)=>assert.throws(()=>demonstrationDataset({...demo,...change}),fails('invalid-data'),why);
  assert.throws(()=>demonstrationDataset(null),fails('invalid-data'));
  assert.throws(()=>demonstrationDataset([demo,'x']),fails('invalid-data'));
  bad({inputs:undefined},'no inputs');bad({keys:'abc'},'keys as a string');bad({sampleSteps:null},'no steps');
  bad({inputs:demo.inputs.subarray(10)},'inputs too short');bad({sampleSteps:demo.sampleSteps.subarray(1)},'steps too short');
  const with_=(field,i,value,Type)=>{const a=Type.from(demo[field]);a[i]=value;return {[field]:a};};
  bad(with_('sampleSteps',5,demo.sampleSteps[4],Array),'a repeated step');bad(with_('sampleSteps',5,1.5,Array),'a fractional step');
  bad(with_('sampleSteps',0,-1,Array),'a negative step');
  for(const key of [16,-1,1.5,'1',null])bad(with_('keys',3,key,Array),`key ${key}`);
  for(const input of [NaN,Infinity,null,'1',1e39])bad(with_('inputs',7,input,Array),`input ${input}`);
  bad(with_('rest',2,2,Array),'rest 2');bad({rest:demo.rest.subarray(1)},'rest too short');
  bad({crashSteps:5},'crash steps not a list');bad({crashSteps:[-3]},'a negative crash step');
  for(const version of [0,3,'2',1.5])bad({version},`version ${version}`);
  for(const options of [{rest:'yes'},{crashTrim:-1},{crashTrim:1.5},{crashTrim:'30'},{mirror:'yes'},{mirror:1},{crashtrim:30},{toString:1},
    {crashtrim:undefined},JSON.parse('{"__proto__":{"mirror":true}}'),5,true,'label'])
    assert.throws(()=>demonstrationDataset(demo,options),fails('invalid-options'),JSON.stringify(options));
  assert.throws(()=>demonstrationDataset([demo,,demo]),fails('invalid-data'),'a hole in the list');
  // Options left undefined take their defaults; an empty list gives no rows.
  assert.deepEqual(demonstrationDataset(demo,{rest:undefined,mirror:undefined}).keys,demonstrationDataset(demo).keys);
  assert.equal(demonstrationDataset([]).report.rows,0);
  assert.throws(()=>trainClone(demonstrationDataset([])),fails('not-enough-data'));
  // Too little driving for the split: the refusal counts the recorded steps, not the mirrored copies.
  const short={version:2,inputs:demo.inputs.subarray(0,150*10),keys:demo.keys.subarray(0,150),sampleSteps:Uint32Array.from({length:150},(_,i)=>i+1)};
  assert.throws(()=>trainClone(demonstrationDataset(short,{mirror:true})),error=>fails('not-enough-data')(error)&&/got 150 steps/.test(error.message));
});

// Labelled rest steps are what lets a clone pull away from rest (H3 found
// that unlabelled ones teach "press nothing at rest"). Real teachers, H1's
// recorder, the conversion, and the trainer, on both tracks.
for(const track of TRACKS){
  test(`on ${track}, a clone trained on labelled rest steps pulls away from rest; on unlabelled ones it stays`,t=>{
    const {sim,vector}=teacherFor(track);
    const {demonstration:demo}=demonstrate(sim,vector,{runs:40,rows:12000,seconds:15,wait:40,seed:'dataset-rest-'+track});
    assert.ok(demo.restSamples>=REST_STEPS*10,`${demo.restSamples} rest rows`);
    const random=seededRandom('dataset-rest-starts-'+track),starts=[sim.spawn];
    for(let i=0;i<8;i++){const s=sim.spawn;starts.push({x:s.x+(random()*2-1)*12,y:s.y+(random()*2-1)*12,angle:s.angle+(random()*2-1)*.12});}
    const moved=weights=>starts.map(start=>{const r=drive(sim,weights,{seconds:3,start});return Math.hypot(r.final.x-start.x,r.final.y-start.y)>20;});
    const atRest=(weights,start)=>{
      const car=new sim.scope.CarClass(start.x,start.y,30,50,'AI',sim.maxSpeed,start.angle);car.useBrain=false;
      car.update(sim.road.borders,sim.road.checkPointList);return Array.from(predict(weights,car.lastInputs));
    };
    const result={};
    for(const rest of ['label','keep']){
      const ds=demonstrationDataset(demo,{rest}),{weights,report}=trainClone(ds,{lags:[1,2]});
      result[rest]={lag:report.lag,heldOut:Number(report.heldOut.agreement.toFixed(4)),keysAtRest:atRest(weights,sim.spawn),moved:moved(weights).filter(Boolean).length};
    }
    assert.equal(atRest(vector,sim.spawn)[0],1,'the teacher presses forward at rest');
    assert.equal(result.label.keysAtRest[0],1,'labelled: forward at rest');assert.equal(result.label.moved,starts.length,'labelled: pulls away from every start');
    assert.deepEqual(result.keep.keysAtRest,[0,0,0,0],'unlabelled: nothing at rest');assert.equal(result.keep.moved,0,'unlabelled: never leaves');
    t.diagnostic(JSON.stringify({track,rows:demo.samples,restRows:demo.restSamples,...result}));
  });
}
