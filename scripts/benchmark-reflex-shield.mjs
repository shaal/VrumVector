// Issue #73: does the reflex shield cut crashes without costing laps? Paired
// runTrialArm runs: both arms of a pair share every seeded stream (population
// and physics) and the live cold start (the reflex seed of #62 in slot 0).
// Arm "off" trains without the shield, arm "on" with it (car.js Car.shield).
// Every generation records the population's crash rate, the shield's frames
// and the population's laps. After K generations each champion drives one
// solo evaluation (physics has no randomness, so one run is exact) with the
// shield and without it. Each finished pair is one JSON line, so a long run
// can be split across commands and resumed (finished pairs are skipped).
//
//   node scripts/benchmark-reflex-shield.mjs --tracks=Rectangle,Triangle,Oval --family=s1 --runs=6
//     [--start=0] [--generations=30] [--seconds=20] [--population=24] [--eval-seconds=60]
//     [--front=.4] [--side=.6] [--output=test-results/reflex-shield.jsonl]
import {appendFile,mkdir,readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {Simulation} from '../tests/helpers/simulation.mjs';
import {runTrialArm} from '../AI-Car-Racer/learning/trial.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';
import {reflexBrain} from '../AI-Car-Racer/learning/reflex.js';

const options=Object.fromEntries(process.argv.slice(2).map(arg=>{const [k,...v]=arg.replace(/^--/,'').split('=');return [k,v.join('=')];}));
const tracks=(options.tracks||'Rectangle,Triangle').split(',');
const family=options.family||'s1',runs=Number(options.runs)||6,start=Number(options.start)||0;
const generations=Number(options.generations)||30,seconds=Number(options.seconds)||20,population=Number(options.population)||24;
const evalSeconds=Number(options['eval-seconds'])||60;
const shieldConfig={front:Number(options.front)||.4,side:Number(options.side)||.6};
const output=options.output||'test-results/reflex-shield.jsonl';
// The reflex this run measured: a later retune of learning/reflex.js changes it.
const reflexHash=createHash('sha256').update(Buffer.from(reflexBrain().buffer)).digest('hex').slice(0,16);

function arm({track,key,shield}){
  const sim=new Simulation({track,seed:key+':physics',shield:shield?shieldConfig:null});
  const gates=sim.road.checkPointList.length,perGeneration=[];let firstLap=null;
  const simulate=flat=>{
    sim.begin(flat);const result=sim.run(seconds);
    let shieldFrames=0,driven=0,laps=0;
    for(const c of sim.cars){shieldFrames+=c.shieldFrames;driven+=c.drivingStats?.frames||0;laps+=c.laps;}
    if(firstLap===null&&result.laps>=1)firstLap=perGeneration.length;
    perGeneration.push({crashRate:1-result.popStillAlive/result.popN,shieldFrames,driven,laps,champion:result.fitness,championLaps:result.laps});
    return result;
  };
  const context={profile:'balanced',track,maxSpeed:15,traction:.5,seconds};
  const out=runTrialArm({simulate,context,seeds:[],random:seededRandom(key+':population'),generations,population,reflex:true,returnChampion:true});
  return {best:out.best,firstLap,perGeneration,
    evaluation:{shield:evaluate(track,out.champion,true),bare:evaluate(track,out.champion,false)},gates};
}
function evaluate(track,vector,shield){
  if(!vector)return null;
  const sim=new Simulation({track,seed:'shield-eval',shield:shield?shieldConfig:null});sim.begin(vector);sim.run(evalSeconds);
  const car=sim.cars[0],gates=sim.road.checkPointList.length,laps=Array.isArray(car.lapTimes)?car.lapTimes:[];
  return {progress:car.checkPointsCount+car.laps*gates,laps:car.laps,bestLap:laps.length?Math.min(...laps):null,
    crashed:!!car.damaged,shieldFrames:car.shieldFrames,driven:car.drivingStats?.frames||0};
}

const doneKey=(key,g,s,f,sd)=>`${key}|${g}|${s}|${f}|${sd}`;
const done=new Set();
try{for(const line of (await readFile(output,'utf8')).split('\n'))if(line.trim()){const r=JSON.parse(line);done.add(doneKey(r.key,r.generations,r.seconds,r.shield.front,r.shield.side));}}catch{}
await mkdir(dirname(output),{recursive:true});
for(const track of tracks)for(let r=start;r<start+runs;r++){
  const key=`reflex-shield-v1:${family}:${track}:${r}`+(population===24?'':`:N${population}`);
  if(done.has(doneKey(key,generations,seconds,shieldConfig.front,shieldConfig.side)))continue;
  const t0=Date.now();
  const off=arm({track,key,shield:false}),on=arm({track,key,shield:true});
  const row={key,track,family,run:r,generations,seconds,population,evalSeconds,shield:shieldConfig,reflexHash,off,on,ms:Date.now()-t0};
  await appendFile(output,JSON.stringify(row)+'\n');
  const e=x=>x?`${x.laps}L ${x.bestLap??'--'}s${x.crashed?' crash':''}`:'--';
  const crash=a=>(a.perGeneration.slice(0,5).reduce((s,g)=>s+g.crashRate,0)/5*100).toFixed(0)+'%';
  console.log(`${track} ${family}#${r}: off[crash g0-4 ${crash(off)} eval ${e(off.evaluation.bare)}] on[crash g0-4 ${crash(on)} eval ${e(on.evaluation.shield)} bare ${e(on.evaluation.bare)}] ${(row.ms/1000).toFixed(0)} s`);
}
