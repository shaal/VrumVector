// How H2's dataset choices change a clone (AI-Car-Racer/learning/dataset.js):
// rest steps (labelled, dropped, or with the keys actually held), mirroring,
// and dropping the last steps before a crash. Teachers are short genetic runs
// (tests/helpers/teacher.mjs). A scripted person (tests/helpers/demonstrator.mjs)
// lets each teacher drive the WASD car through H1's recorder: every run waits
// 40 steps at rest, then the teacher drives for up to 15 s. Noisy recordings add
// mistakes: the steering goes the wrong way ('swap'), or the keys stay held
// too long ('late'), for 10-30 steps, about once every 3 seconds. Every clone
// trains twice: with the trainer's defaults (it chooses the key lag, as H4
// will), and with the lag fixed at 1, the teachers' true lag, so the effect of
// the data is measured on its own. Clones are scored against the clean teacher.
//
//   node scripts/benchmark-dataset.mjs run <session> <track> [teachers=6]
//     writes test-results/dataset-benchmark/s<session>-<track>.json
//   node scripts/benchmark-dataset.mjs summary [output=docs/validation/cloning-dataset.json]
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {Simulation} from '../tests/helpers/simulation.mjs';
import {evolveTeacher,drive,record} from '../tests/helpers/teacher.mjs';
import {demonstrate,mirroredSimulation} from '../tests/helpers/demonstrator.mjs';
import {trainClone,evaluate,prepareDataset,pairRows,predict} from '../AI-Car-Racer/learning/clone.js';
import {demonstrationDataset,mirrorBrain} from '../AI-Car-Racer/learning/dataset.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const DIR='test-results/dataset-benchmark',ROUND=30,STARTS=13;
const GENETIC={generations:24,population:24,seconds:15};
const RECORDING={runs:40,rows:18000,seconds:15,wait:40};
const SLIPS={every:180,min:10,max:30};
const ARMS=[
  {name:'rest-keep',recording:'clean',options:{rest:'keep'}},
  {name:'rest-drop',recording:'clean',options:{rest:'drop'}},
  {name:'label',recording:'clean',options:{}},
  {name:'label-mirror',recording:'clean',options:{mirror:true}},
  {name:'label-trim30',recording:'clean',options:{crashTrim:30}},
  ...['swap','late'].flatMap(kind=>[0,30,60].map(crashTrim=>({name:`${kind}-trim${crashTrim}`,recording:kind,options:{crashTrim}}))),
];
const FORWARD_ONLY=new Float32Array(244);FORWARD_ONLY.set([-1,1,1,1],176);
const sum=list=>list.reduce((a,b)=>a+b,0);
const round=(v,d=4)=>v==null?v:Number(v.toFixed(d));
const keyShare=dataset=>[0,1,2,3].map(o=>{let on=0;for(let i=o;i<dataset.keys.length;i+=4)on+=dataset.keys[i];return on/(dataset.keys.length/4);});

function closedLoop(sim,weights,starts,teacher){
  const rounds=starts.map(start=>drive(sim,weights,{seconds:ROUND,start}));
  const progress=rounds.map(r=>r.progress);
  return {checkpoints:sum(progress),miss:teacher?sum(progress.map((p,i)=>Math.abs(p-teacher[i]))):null,
    withinOne:teacher?progress.filter((p,i)=>Math.abs(p-teacher[i])<=1).length:null,crashes:rounds.filter(r=>r.crashedAt!==null).length,progress};
}
// Left the start: more than 20 px from where it stood after 3 seconds.
// (In any direction: a teacher that first moves in reverse is copied too.)
const pulledAway=(sim,weights,starts)=>starts.filter(start=>{const r=drive(sim,weights,{seconds:3,start});return Math.hypot(r.final.x-start.x,r.final.y-start.y)>20;}).length;
const TRAINERS={default:{},lag1:{lags:[1]}};
// Mistakes in a noisy recording: how many rows hold them; how many crashes
// follow one within 60 steps, and, for comparison, how many recorded steps
// do; and how many of the rows a crash trim drops are mistakes.
function mistakes(recording,trims){
  const demo=recording.demonstration,wrong=new Set(recording.wrongSteps),steps=demo.sampleSteps,crashes=Array.from(demo.crashSteps);
  let rows=0;for(const s of steps)if(wrong.has(s))rows++;
  const near=c=>{for(let s=c-60;s<c;s++)if(wrong.has(s))return true;return false;};
  let nearSteps=0;for(const s of steps)if(near(s))nearSteps++;
  const out={rows:steps.length,mistakeRows:rows,share:round(rows/steps.length),crashes:crashes.length,
    crashesAfterMistake:crashes.length?round(crashes.filter(near).length/crashes.length):null,stepsAfterMistake:round(nearSteps/steps.length),dropped:{},droppedMistakes:{},droppedRows:{}};
  for(const n of trims){
    let dropped=0,bad=0;
    for(const s of steps)if(crashes.some(c=>c-n<=s&&s<c)){dropped++;if(wrong.has(s))bad++;}
    out.dropped[n]=dropped?round(bad/dropped):null;out.droppedRows[n]=dropped;out.droppedMistakes[n]=bad;
  }
  return out;
}

async function run(session,track,wanted){
  const sim=new Simulation({track,seed:`h2-bench-${session}`}),mirrored=mirroredSimulation({track,seed:`h2-bench-${session}`});
  const teachers=[],refused=[];
  for(let i=0;teachers.length<wanted&&i<5*wanted;i++){
    const seed=`h2-s${session}-${i}`,started=performance.now();
    const {vector}=evolveTeacher({track,seed,...GENETIC});
    const recordings={clean:demonstrate(sim,vector,{...RECORDING,seed:`${seed}:clean`})};
    if(!recordings.clean.demonstration||recordings.clean.demonstration.samples<6000){refused.push({seed,reason:'drives too little'});console.log(track,seed,'refused: drives too little');continue;}
    const clean=demonstrationDataset(recordings.clean.demonstration,{rest:'drop'}),share=keyShare(clean);
    // The rule of the lag test in tests/cloning.test.mjs: at least two keys
    // change (each held on 2-98% of the steps). Many good drivers hold forward all the time.
    if(share.filter(s=>s>.02&&s<.98).length<2){refused.push({seed,keyShare:share.map(v=>round(v,3))});console.log(track,seed,'refused',share);continue;}
    for(const kind of ['swap','late'])recordings[kind]=demonstrate(sim,vector,{...RECORDING,seed:`${seed}:${kind}`,slips:{kind,...SLIPS}});
    // Scored on fresh clean runs from new starts, never used in training.
    const fresh=record(sim,vector,{episodes:20,rows:6000,seconds:15,seed:`${seed}:fresh`,jitterFirst:true});
    const freshData=prepareDataset(fresh.dataset),freshRows=pairRows(freshData,{held:new Uint8Array(freshData.n)},1).train;
    const random=seededRandom(`${seed}:starts`),starts=[sim.spawn];
    for(let s=1;s<STARTS;s++){const p=sim.spawn;starts.push({x:p.x+(random()*2-1)*12,y:p.y+(random()*2-1)*12,angle:p.angle+(random()*2-1)*.12});}
    const mirrorStarts=starts.map(mirrored.mirror);
    const own=closedLoop(sim,vector,starts),mirrorOwn=closedLoop(mirrored,mirrorBrain(vector),mirrorStarts);
    const teacherAtRest=Array.from(predict(vector,(()=>{const c=new sim.scope.CarClass(sim.spawn.x,sim.spawn.y,30,50,'AI',sim.maxSpeed,sim.spawn.angle);c.useBrain=false;c.update(sim.road.borders,sim.road.checkPointList);return c.lastInputs;})()));
    // The mistake log lines up with the recording: a row is a mistake exactly
    // when its keys differ from the teacher's choice on the row before.
    for(const kind of ['swap','late']){
      const {demonstration:d,wrongSteps}=recordings[kind],wrong=new Set(wrongSteps),x=new Float32Array(10);
      for(let i=1;i<d.samples;i++){
        if(d.sampleSteps[i]!==d.sampleSteps[i-1]+1||d.rest[i])continue;
        x.set(d.inputs.subarray((i-1)*10,i*10));const k=predict(vector,x),bits=k[0]|k[1]<<1|k[2]<<2|k[3]<<3;
        if((bits!==d.keys[i])!==wrong.has(d.sampleSteps[i]))throw new Error(`${seed} ${kind}: mistake log out of step at row ${i}`);
      }
    }
    const entry={seed,keyShare:share.map(v=>round(v,3)),
      recordings:Object.fromEntries(Object.entries(recordings).map(([k,r])=>[k,{rows:r.demonstration.samples,restRows:r.demonstration.restSamples,
        crashes:r.demonstration.crashes,runs:r.runs.length,slipSteps:r.slipSteps,...(k==='clean'?{}:{mistakes:mistakes(r,[30,60])})}])),
      teacher:{checkpoints:own.checkpoints,crashes:own.crashes,mirrorTrack:mirrorOwn.checkpoints,onMirrorTrack:closedLoop(mirrored,vector,mirrorStarts).checkpoints,
        pulledAway:pulledAway(sim,vector,starts),keysAtRest:teacherAtRest},
      forwardOnly:closedLoop(sim,FORWARD_ONLY,starts,own.progress),arms:{}};
    const spawnCar=new sim.scope.CarClass(sim.spawn.x,sim.spawn.y,30,50,'AI',sim.maxSpeed,sim.spawn.angle);spawnCar.useBrain=false;
    spawnCar.update(sim.road.borders,sim.road.checkPointList);
    for(const arm of ARMS){
      const dataset=demonstrationDataset(recordings[arm.recording].demonstration,arm.options);
      entry.arms[arm.name]={rows:dataset.report.rows,restRows:dataset.report.restRows,crashDropped:dataset.report.crashDropped};
      for(const [trainer,options] of Object.entries(TRAINERS)){
        const {weights,report}=trainClone(dataset,options);
        const loop=closedLoop(sim,weights,starts,own.progress),mirrorLoop=closedLoop(mirrored,weights,mirrorStarts,mirrorOwn.progress);
        entry.arms[arm.name][trainer]={lag:report.lag,epochs:report.epochs,heldOut:round(report.heldOut.agreement),fresh:round(evaluate(weights,freshData,freshRows,1).agreement),
          keysAtRest:Array.from(predict(weights,spawnCar.lastInputs)),pulledAway:pulledAway(sim,weights,starts),
          checkpoints:loop.checkpoints,miss:loop.miss,withinOne:loop.withinOne,crashes:loop.crashes,
          mirrorTrack:{checkpoints:mirrorLoop.checkpoints,miss:mirrorLoop.miss},maxAbsWeight:round(report.maxAbsWeight,1),ms:report.ms};
      }
    }
    entry.seconds=Math.round((performance.now()-started)/1000);
    teachers.push(entry);
    console.log(track,seed,entry.seconds+'s',JSON.stringify(Object.fromEntries(Object.entries(entry.arms).map(([k,a])=>[k,[a.default.fresh,a.lag1.fresh,a.default.lag,a.default.pulledAway,a.default.checkpoints]]))));
  }
  await mkdir(DIR,{recursive:true});
  const file=`${DIR}/s${session}-${track}.json`;
  await writeFile(file,JSON.stringify({session,track,node:process.version,genetic:GENETIC,recording:RECORDING,slips:SLIPS,teachers,refused},null,1));
  console.log('wrote',file);
}

// Per track, arm, and trainer: means over teachers, and paired differences
// from the arm's base (the same teacher, the same starts), with wins, ties,
// and losses, overall and per session.
async function summary(output){
  const files=(await readdir(DIR)).filter(f=>/^s\d+-.+\.json$/.test(f)).sort();
  const runs=await Promise.all(files.map(async f=>JSON.parse(await readFile(`${DIR}/${f}`,'utf8'))));
  const tracks={};
  for(const r of runs)(tracks[r.track]??=[]).push(...r.teachers.map(t=>({...t,session:r.session})));
  const mean=list=>list.length?sum(list)/list.length:null;
  const sessions=[...new Set(runs.map(r=>r.session))];
  const paired=(teachers,get)=>{
    const d=teachers.map(get).filter(v=>v!=null);
    return {mean:round(mean(d),4),better:d.filter(v=>v>1e-9).length,same:d.filter(v=>Math.abs(v)<=1e-9).length,worse:d.filter(v=>v<-1e-9).length};
  };
  const result={generated:'node scripts/benchmark-dataset.mjs summary',node:runs[0]?.node,genetic:runs[0]?.genetic,recording:runs[0]?.recording,slips:runs[0]?.slips,
    trainers:TRAINERS,sessions,tracks:{}};
  for(const [track,teachers] of Object.entries(tracks)){
    const arms={};
    for(const arm of ARMS){
      const base=arm.recording==='clean'?'label':`${arm.recording}-trim0`;
      arms[arm.name]={n:teachers.length,base:arm.name===base?null:base};
      for(const trainer of Object.keys(TRAINERS)){
        const a=teachers.map(t=>t.arms[arm.name][trainer]),at=(t,name)=>t.arms[name][trainer];
        const vs=get=>paired(teachers,t=>get(at(t,arm.name))-get(at(t,base)));
        const bySession=get=>Object.fromEntries(sessions.map(s=>[s,paired(teachers.filter(t=>t.session===s),t=>get(at(t,arm.name))-get(at(t,base))).mean]));
        arms[arm.name][trainer]={fresh:round(mean(a.map(x=>x.fresh))),heldOut:round(mean(a.map(x=>x.heldOut))),
          keysForwardAtRest:a.filter(x=>x.keysAtRest[0]).length,pulledAwayAll:a.filter(x=>x.pulledAway===STARTS).length,pulledAway:sum(a.map(x=>x.pulledAway)),
          checkpoints:round(mean(a.map(x=>x.checkpoints)),2),miss:round(mean(a.map(x=>x.miss)),2),crashes:round(mean(a.map(x=>x.crashes)),2),
          mirrorTrack:round(mean(a.map(x=>x.mirrorTrack.checkpoints)),2),lags:a.map(x=>x.lag),lagNot1:a.filter(x=>x.lag!==1).length,
          maxAbsWeight:round(mean(a.map(x=>x.maxAbsWeight)),1),
          vsBase:arm.name===base?null:{fresh:vs(x=>x.fresh),checkpoints:vs(x=>x.checkpoints),mirrorTrack:vs(x=>x.mirrorTrack.checkpoints),
            pulledAway:vs(x=>x.pulledAway),bySession:{fresh:bySession(x=>x.fresh),checkpoints:bySession(x=>x.checkpoints)}}};
      }
    }
    // Totals over all teachers, for the mistake shares.
    const pooled=k=>{const m=teachers.map(t=>t.recordings[k].mistakes),total=f=>sum(m.map(f));
      return {mistakeRows:total(x=>x.mistakeRows),rows:total(x=>x.rows),
        ...Object.fromEntries([30,60].map(n=>[`trim${n}`,{droppedRows:total(x=>x.droppedRows[n]),droppedMistakes:total(x=>x.droppedMistakes[n]),
          mistakeShareOfDropped:round(total(x=>x.droppedMistakes[n])/total(x=>x.droppedRows[n]),3),shareOfMistakesRemoved:round(total(x=>x.droppedMistakes[n])/total(x=>x.mistakeRows),3)}]))};};
    const rec=k=>({crashes:round(mean(teachers.map(t=>t.recordings[k].crashes)),1),rows:round(mean(teachers.map(t=>t.recordings[k].rows)),0),
      runs:round(mean(teachers.map(t=>t.recordings[k].runs)),1),crashedRuns:round(mean(teachers.map(t=>t.recordings[k].crashes/t.recordings[k].runs)),3),
      ...(k==='clean'?{}:{mistakeShare:round(mean(teachers.map(t=>t.recordings[k].mistakes.share)),3),
        crashesAfterMistake:round(mean(teachers.map(t=>t.recordings[k].mistakes.crashesAfterMistake).filter(v=>v!=null)),3),
        stepsAfterMistake:round(mean(teachers.map(t=>t.recordings[k].mistakes.stepsAfterMistake)),3),pooled:pooled(k),
        mistakeShareOfDropped:Object.fromEntries([30,60].map(n=>[n,round(mean(teachers.map(t=>t.recordings[k].mistakes.dropped[n]).filter(v=>v!=null)),3)]))})});
    result.tracks[track]={teachers:teachers.length,refused:runs.filter(r=>r.track===track).flatMap(r=>r.refused.map(x=>x.seed)),
      // Share of the clean recordings' moving steps with each key held (forward, left, right, reverse).
      keyBalance:[0,1,2,3].map(o=>round(mean(teachers.map(t=>t.keyShare[o])),3)),
      teacher:{checkpoints:round(mean(teachers.map(t=>t.teacher.checkpoints)),2),mirrorTrack:round(mean(teachers.map(t=>t.teacher.mirrorTrack)),2),
        pulledAway:sum(teachers.map(t=>t.teacher.pulledAway)),pulledAwayAll:teachers.filter(t=>t.teacher.pulledAway===STARTS).length,
        onMirrorTrack:round(mean(teachers.map(t=>t.teacher.onMirrorTrack)),2),crashes:round(mean(teachers.map(t=>t.teacher.crashes)),2)},
      forwardOnly:{checkpoints:round(mean(teachers.map(t=>t.forwardOnly.checkpoints)),2)},
      recordings:Object.fromEntries(['clean','swap','late'].map(k=>[k,rec(k)])),arms,
      // One line per teacher and arm: [fresh agreement, pulled away, checkpoints, lag] with the trainer's
      // lag choice, then the same with the lag fixed at 1.
      perTeacher:teachers.map(t=>({seed:t.seed,session:t.session,keyShare:t.keyShare,
        teacher:[t.teacher.checkpoints,t.teacher.pulledAway,t.teacher.keysAtRest.join('')],
        arms:Object.fromEntries(Object.entries(t.arms).map(([name,a])=>[name,[...['default','lag1'].flatMap(k=>[a[k].fresh,a[k].pulledAway,a[k].checkpoints,a[k].lag]),a.default.keysAtRest.join('')]]))}))};
  }
  await writeFile(output,JSON.stringify(result,null,1)+'\n');
  console.log('wrote',output);
}

const [mode,...args]=process.argv.slice(2);
if(mode==='run')await run(Number(args[0]),args[1],Number(args[2]??6));
else if(mode==='summary')await summary(args[0]??'docs/validation/cloning-dataset.json');
else{console.error('usage: benchmark-dataset.mjs run <session> <track> [teachers] | summary [output]');process.exit(2);}
