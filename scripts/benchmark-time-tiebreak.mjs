// Paired runTrialArm runs for the time tie-break (#60): arm "off" ranks by
// gates and style only; arm "on" also prefers the car that reached its last
// gate sooner. Both arms share the population and physics streams, so they
// stay identical until the first tie the new rule breaks differently.
// Each arm's champion then drives one deterministic solo evaluation, which
// gives the best lap time, the laps, and whether it crashed.
//
//   node scripts/benchmark-time-tiebreak.mjs --track=Triangle --runs=0-5 \
//     --generations=30 --population=48 --seconds=40 --output=test-results/tiebreak-tri.json
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Simulation} from '../tests/helpers/simulation.mjs';
import {runTrialArm} from '../AI-Car-Racer/learning/trial.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const options=Object.fromEntries(process.argv.slice(2).map(arg=>{const [k,...v]=arg.replace(/^--/,'').split('=');return [k,v.join('=')];}));
const track=options.track||'Rectangle';
const [from,to]=(options.runs||'0-5').split('-').map(Number);
const generations=Number(options.generations)||30,population=Number(options.population)||48;
const seconds=Number(options.seconds)||40,evalSeconds=Number(options['eval-seconds'])||seconds;
const output=options.output||`test-results/tiebreak-${track}.json`;
const context={profile:'balanced',track,maxSpeed:15,traction:.5,seconds};

function arm(key,timeTieBreak){
  const sim=new Simulation({track,seed:key+':physics',timeTieBreak});
  let ties=0,gens=0,survival=0;
  const simulate=flat=>{
    sim.begin(flat);const result=sim.run(seconds),gates=sim.road.checkPointList.length;
    const progress=sim.cars.map(c=>c.checkPointsCount+c.laps*gates),top=Math.max(...progress);
    survival=result.popStillAlive/result.popN;gens++;if(top>0&&progress.filter(p=>p===top).length>1)ties++;
    return {...result,meanProgress:progress.reduce((a,b)=>a+b,0)/progress.length};
  };
  const out=runTrialArm({simulate,context,seeds:[],random:seededRandom(key+':population'),exploration:1,generations,population,returnChampion:true});
  // tieRate: generations whose top gate count was shared. finalSurvival: the
  // share of the last generation still undamaged at the end.
  return {best:out.best,area:out.area,tieRate:ties/gens,finalSurvival:survival,evaluation:evaluate(out.champion)};
}
// One solo drive of the champion. Physics has no randomness, so one run is exact.
function evaluate(vector){
  if(!vector)return null;
  const sim=new Simulation({track,seed:'tiebreak-eval'});sim.begin(vector);sim.run(evalSeconds);
  const car=sim.cars[0],gates=sim.road.checkPointList.length;
  const laps=Array.isArray(car.lapTimes)?car.lapTimes:[];
  return {progress:car.checkPointsCount+car.laps*gates,laps:car.laps,bestLap:laps.length?Math.min(...laps):null,
    firstLap:laps.length?laps[0]:null,crashed:!!car.damaged,lastGateFrame:car.lastGateFrame};
}

const runs=[];
for(let r=from;r<=to;r++){
  const key=`tiebreak-v1:${track}:${r}`,t=Date.now();
  const off=arm(key,false),on=arm(key,true);
  runs.push({run:r,off,on});
  const f=a=>`best ${a.best} lap ${a.evaluation?.bestLap??'--'} crash ${a.evaluation?.crashed?1:0} ties ${(a.tieRate*100).toFixed(0)}%`;
  console.log(`${track} run ${r}: off[${f(off)}] on[${f(on)}] ${((Date.now()-t)/1000).toFixed(0)} s`);
}
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify({version:1,track,generations,population,seconds,evalSeconds,runs},null,2)+'\n');
console.log(`Saved ${output}`);
