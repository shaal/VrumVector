// Validates the training-health mapping (AI-Car-Racer/learning/health.js) on
// real-physics genetic runs. Ground truth per generation: "improving" when the
// champion improved within the last HEALTH_WINDOW generations, else "plateau".
// Agreement: Healthy on improving; Stuck or NeedsReplan on plateau.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Simulation} from '../tests/helpers/simulation.mjs';
import {LearningCoach,buildPopulation} from '../AI-Car-Racer/learning/policy.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';
import {TrainingHealth,HEALTH_MODULE_URL,HEALTH_WINDOW,HEALTH_THRESHOLDS,loadHealth} from '../AI-Car-Racer/learning/health.js';

const wasm=await import(HEALTH_MODULE_URL);
wasm.initSync({module:await readFile(new URL('../vendor/ruvector/emergent_time_wasm/emergent_time_wasm_bg.wasm',import.meta.url))});
if(!await loadHealth())throw Error('health wasm failed to load');
const output=process.argv[2]||'test-results/training-health.json';
const sets={
  tuning:{tracks:['Rectangle','Triangle'],seeds:[0,1,2,3,4,5],population:48,seconds:8},
  heldOut:{tracks:['Monza','Rectangle','Triangle'],seeds:[100,101,102],population:128,seconds:12},
};
const GENERATIONS=40,UPSTREAM_DEFAULTS=[1e-3,.5,.1,.5,.8];
function trace(track,seed,{population,seconds}){
  const key=`health-trace-v1:${track}:${seed}`,sim=new Simulation({track,seed:key}),coach=new LearningCoach(),random=seededRandom(key);
  coach.setContext({profile:'balanced',track,maxSpeed:15,traction:.5,seconds});
  const rows=[],gates=sim.road.checkPointList.length;
  for(let g=0;g<GENERATIONS;g++){
    // Adaptive exploration, so plan changes appear in the traces.
    const plan=coach.plan(.22,true,1),batch=buildPopulation({N:population,incumbent:coach.incumbent,plan,random});
    sim.begin(batch.flat);const r=sim.run(seconds);coach.record(r,r.vector);
    rows.push({best:coach.incumbent.fitness,genBest:r.fitness,gates,mutation:plan.mutation,champion:Float32Array.from(coach.incumbent.vector),improved:coach.lastImproved});
  }
  return rows;
}
function evaluate(traces,thresholds){
  const confusion={};let agree=0,total=0;
  for(const rows of traces){
    const health=new TrainingHealth({thresholds});
    rows.forEach((row,i)=>{
      const state=health.observe(row)?.state;if(i<HEALTH_WINDOW)return;
      const improving=rows.slice(i-HEALTH_WINDOW+1,i+1).some(r=>r.improved),truth=improving?'improving':'plateau';
      confusion[`${truth} → ${state}`]=(confusion[`${truth} → ${state}`]||0)+1;total++;
      if(improving?state==='Healthy':state==='Stuck'||state==='NeedsReplan')agree++;
    });
    health.reset();
  }
  return {agreement:agree/total,windows:total,confusion};
}
const report={version:1,window:HEALTH_WINDOW,generations:GENERATIONS,thresholds:{tuned:HEALTH_THRESHOLDS,upstreamDefaults:UPSTREAM_DEFAULTS},sets:{}};
for(const [name,set] of Object.entries(sets)){
  const traces=[];for(const track of set.tracks)for(const seed of set.seeds)traces.push(trace(track,seed,set));
  report.sets[name]={...set,traces:traces.length,tuned:evaluate(traces,HEALTH_THRESHOLDS),upstreamDefaults:evaluate(traces,UPSTREAM_DEFAULTS)};
  console.log(`${name}: tuned ${(report.sets[name].tuned.agreement*100).toFixed(1)}% · upstream defaults ${(report.sets[name].upstreamDefaults.agreement*100).toFixed(1)}% over ${report.sets[name].tuned.windows} windows`);
}
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(`Saved ${output}`);
