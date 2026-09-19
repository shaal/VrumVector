// Deterministic, real-physics experiments. This isolates the genetic policy;
// it does not measure WASM retrieval, rendering performance, or networking.
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Simulation} from '../tests/helpers/simulation.mjs';
import {LearningCoach,buildPopulation} from '../AI-Car-Racer/learning/policy.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const options=Object.fromEntries(process.argv.slice(2).map(arg=>{const [k,...v]=arg.replace(/^--/,'').split('=');return [k,v.join('=')];}));
const config={tracks:(options.tracks||'Rectangle,Triangle,Monza').split(','),
  profiles:(options.profiles||'balanced,calm,careful,wild,reckless').split(','),
  seeds:Math.max(1,Number(options.seeds)||5),generations:Math.max(1,Number(options.generations)||20),
  population:Math.max(1,Number(options.population)||32),seconds:Math.max(1,Number(options.seconds)||8),
  maxSpeed:15,traction:.5,mutation:.22,conservative:.65};
const output=options.output||'test-results/learning-benchmark.json';
const records=[];
for(const track of config.tracks)for(const profile of config.profiles)for(const adaptive of [false,true]){
  for(let seed=0;seed<config.seeds;seed++){
    const key=`learning-benchmark-v1:${track}:${seed}`;
    const random=seededRandom(key),sim=new Simulation({track,profile,seed:key}),coach=new LearningCoach();
    coach.setContext({profile,track,maxSpeed:config.maxSpeed,traction:config.traction,seconds:config.seconds});
    const exploration=sim.scope.DriverProfiles.get(profile).exploration,history=[];
    for(let generation=0;generation<config.generations;generation++){
      const plan=coach.plan(config.mutation,adaptive,exploration);
      const batch=buildPopulation({N:config.population,incumbent:coach.incumbent,plan,random,conservative:config.conservative});
      sim.begin(batch.flat);const result=sim.run(config.seconds);coach.record(result,result.vector);
      history.push({best:coach.incumbent.fitness,current:result.fitness,survival:result.popStillAlive/result.popN,
        speed:result.driving.averageSpeed,stage:plan.stage,mutation:plan.mutation});
    }
    records.push({track,profile,adaptive,seed,best:coach.incumbent.fitness,
      meanBest:history.reduce((sum,g)=>sum+g.best,0)/history.length,
      finalSurvival:history.at(-1).survival,history});
  }
  console.log(`${track} / ${profile} / ${adaptive?'adaptive':'fixed'} complete`);
}
const mean=(rows,key)=>rows.reduce((sum,row)=>sum+row[key],0)/rows.length;
const summary=[];
for(const track of config.tracks)for(const profile of config.profiles){
  const fixed=records.filter(r=>r.track===track&&r.profile===profile&&!r.adaptive);
  const adaptive=records.filter(r=>r.track===track&&r.profile===profile&&r.adaptive);
  summary.push({track,profile,fixedBest:mean(fixed,'best'),adaptiveBest:mean(adaptive,'best'),
    fixedMeanBest:mean(fixed,'meanBest'),adaptiveMeanBest:mean(adaptive,'meanBest'),
    fixedSurvival:mean(fixed,'finalSurvival'),adaptiveSurvival:mean(adaptive,'finalSurvival'),
    pairedWins:adaptive.filter((r,i)=>r.best>fixed[i].best).length,
    pairedTies:adaptive.filter((r,i)=>r.best===fixed[i].best).length});
}
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify({version:1,config,method:'60 Hz full sensor updates; real car, collisions, checkpoints, and track geometry; shared initial seeds; no vector archive',summary,records},null,2)+'\n');
console.table(summary);console.log(`Saved ${output}`);
