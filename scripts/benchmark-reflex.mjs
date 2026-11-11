// Issue #62: does one hand-written reflex car in a cold generation 0 cut the
// generations to the first lap? Paired runTrialArm runs: both arms of a pair
// share every seeded stream (population and physics), and the reflex arm
// differs only in slot 0 of generation 0. Cold start: no memories, no saved
// driver. Each finished pair is appended as one JSON line, so a long run can
// be split across commands and resumed (finished pairs are skipped).
//
//   node scripts/benchmark-reflex.mjs --tracks=Rectangle,Triangle --family=s1 --runs=12
//     [--generations=80] [--seconds=20] [--population=24] [--output=test-results/reflex-benchmark.jsonl]
import {appendFile,mkdir,readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Simulation} from '../tests/helpers/simulation.mjs';
import {runTrialArm} from '../AI-Car-Racer/learning/trial.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const options=Object.fromEntries(process.argv.slice(2).map(arg=>{const [k,...v]=arg.replace(/^--/,'').split('=');return [k,v.join('=')];}));
const tracks=(options.tracks||'Rectangle,Triangle').split(',');
const family=options.family||'s1',runs=Number(options.runs)||6,start=Number(options.start)||0;
const generations=Number(options.generations)||80,seconds=Number(options.seconds)||20,population=Number(options.population)||24;
const output=options.output||'test-results/reflex-benchmark.jsonl';

// First generation whose champion completed a lap (laps >= 1), or null if
// none did in `generations`. After the first lap the metric is fixed, so the
// arm stops simulating and repeats the last result.
function firstLapArm({track,key,reflex}){
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
  runTrialArm({simulate,context,seeds:[],random:seededRandom(key+':population'),generations,population,reflex});
  // history: champion progress per generation, up to the first lap.
  return {firstLap,best:Math.max(0,...history),history};
}

let done=new Set();
// Resume: skip a pair already in the file with the same settings.
const doneKey=(key,g,s)=>`${key}|${g}|${s}`;
try{for(const line of (await readFile(output,'utf8')).split('\n'))if(line.trim()){const row=JSON.parse(line);done.add(doneKey(row.key,row.generations,row.seconds));}}catch{}
await mkdir(dirname(output),{recursive:true});
for(const track of tracks)for(let r=start;r<start+runs;r++){
  const key=`reflex-benchmark-v1:${family}:${track}:${r}`+(population===24?'':`:N${population}`);
  if(done.has(doneKey(key,generations,seconds)))continue;
  const t0=Date.now();
  const baseline=firstLapArm({track,key,reflex:false}),reflex=firstLapArm({track,key,reflex:true});
  const row={key,track,family,run:r,generations,seconds,population,baseline,reflex,ms:Date.now()-t0};
  await appendFile(output,JSON.stringify(row)+'\n');
  console.log(`${track} ${family}#${r}: baseline first lap ${baseline.firstLap??'>'+(generations-1)} · reflex ${reflex.firstLap??'>'+(generations-1)} · ${(row.ms/1000).toFixed(1)} s`);
}
