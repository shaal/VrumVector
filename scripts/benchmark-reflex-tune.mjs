// Issue #70: does a reflex tuned for the track (reflexTuner.js) cut the
// generations to the first lap, against the fixed reflex of #62? Paired
// runTrialArm runs: both arms are cold starts with the reflex car in slot 0 of
// generation 0, and share every seeded stream (population and physics). The
// only difference is the reflex car's tuning. The tuner's own drives are
// timed and reported, so the time cost can be set against the generations saved.
// Each finished pair is one JSON line; finished pairs are skipped on a re-run.
//
//   node scripts/benchmark-reflex-tune.mjs --tracks=Oval,Monza --family=s1 --runs=6
//     [--start=0] [--generations=80] [--seconds=20] [--population=24] [--output=test-results/reflex-tune.jsonl]
import {appendFile,mkdir,readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Simulation} from '../tests/helpers/simulation.mjs';
import {runTrialArm} from '../AI-Car-Racer/learning/trial.js';
import {tuneReflex,TUNE_STRIDES} from '../AI-Car-Racer/learning/reflexTuner.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const options=Object.fromEntries(process.argv.slice(2).map(arg=>{const [k,...v]=arg.replace(/^--/,'').split('=');return [k,v.join('=')];}));
const tracks=(options.tracks||'Rectangle,Triangle').split(',');
const family=options.family||'s1',runs=Number(options.runs)||6,start=Number(options.start)||0;
const generations=Number(options.generations)||80,seconds=Number(options.seconds)||20,population=Number(options.population)||24;
const output=options.output||'test-results/reflex-tune.jsonl';

// The tuner drives one car on its own simulator, with the generation length.
function tuneFor(track,key){
  const sim=new Simulation({track,seed:key+':tune'});
  // Variant v drives at sensor stride TUNE_STRIDES[v] (frames between sensor reads).
  const drive=(flat,v)=>{sim.scope.SENSOR_STRIDE=TUNE_STRIDES[v]??1;sim.begin(flat);const r=sim.run(seconds);sim.scope.SENSOR_STRIDE=1;
    return {fitness:r.fitness,lastGateFrame:sim.cars[0].lastGateFrame};};
  return tuneReflex({drive,random:seededRandom(key+':tuner')});
}

// First generation whose champion completed a lap (laps >= 1), or null.
// tuning: the reflex car (slot 0 of a cold generation 0) uses it (runTrialArm reflexTuning).
function firstLapArm({track,key,tuning}){
  const sim=new Simulation({track,seed:key+':physics'});
  let generation=0,firstLap=null,last=null;const history=[];
  const simulate=flat=>{
    if(firstLap!==null){generation++;return last;}
    sim.begin(flat);const result=sim.run(seconds);
    if(result.laps>=1)firstLap=generation;
    history.push(result.fitness);
    generation++;last=result;return result;
  };
  const context={profile:'balanced',track,maxSpeed:15,traction:.5,seconds};
  runTrialArm({simulate,context,seeds:[],random:seededRandom(key+':population'),generations,population,reflex:true,reflexTuning:tuning});
  return {firstLap,best:Math.max(0,...history),history};
}

const done=new Set(),doneKey=(key,g,s)=>`${key}|${g}|${s}`;
try{for(const line of (await readFile(output,'utf8')).split('\n'))if(line.trim()){const row=JSON.parse(line);done.add(doneKey(row.key,row.generations,row.seconds));}}catch{}
await mkdir(dirname(output),{recursive:true});
for(const track of tracks)for(let r=start;r<start+runs;r++){
  const key=`reflex-tune-v2:${family}:${track}:${r}`+(population===24?'':`:N${population}`);
  if(done.has(doneKey(key,generations,seconds)))continue;
  const t0=Date.now();
  const tune=tuneFor(track,key);
  const fixed=firstLapArm({track,key,tuning:null}),tunedArm=firstLapArm({track,key,tuning:tune.tuning});
  const row={key,track,family,run:r,generations,seconds,population,
    tune:{score:tune.score,defaultScore:tune.defaultScore,searchScore:tune.searchScore,drives:tune.drives,ms:tune.ms,tuning:tune.tuning},
    fixed,tuned:tunedArm,ms:Date.now()-t0};
  await appendFile(output,JSON.stringify(row)+'\n');
  const f=v=>v??'>'+(generations-1);
  console.log(`${track} ${family}#${r}: fixed ${f(fixed.firstLap)} · tuned ${f(tunedArm.firstLap)} · tune ${tune.defaultScore}->${tune.score.toFixed(2)} in ${tune.ms} ms · ${(row.ms/1000).toFixed(1)} s`);
}
