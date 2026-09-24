// Real-physics transfer checks, the same code path as the in-game "Check
// transfer" button with in-process arms instead of workers. Memories are the
// champions of six seeded training runs on the source track.
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Simulation} from '../tests/helpers/simulation.mjs';
import {LearningCoach,buildPopulation} from '../AI-Car-Racer/learning/policy.js';
import {runTrialArm} from '../AI-Car-Racer/learning/trial.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const store=new Map();
globalThis.localStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
const {runTransferCheck,CHECK_DEFAULTS}=await import('../AI-Car-Racer/learning/transferCheck.js');
// Continue checks (as the in-game button does) up to this many trials in total.
const options=Object.fromEntries(process.argv.slice(2).map(arg=>{const [k,...v]=arg.replace(/^--/,'').split('=');return [k,v.join('=')];}));
const MAX_TOTAL_TRIALS=Number(options?.['max-trials'])||300;
const config={pairs:(options.pairs||'Rectangle>Triangle,Triangle>Rectangle,random>Rectangle,random>Triangle').split(',').map(p=>p.split('>')),
  seconds:Math.max(1,Number(options.seconds)||8),sources:6,sourceGenerations:15,sourcePopulation:24,profile:'balanced',...CHECK_DEFAULTS};
const output=options.output||'test-results/transfer-benchmark.json';

// Control: 'random' memories are uniform random networks, which carry no skill.
function memories(track){
  if(track==='random'){const random=seededRandom('transfer-benchmark-v1:random');return Array.from({length:config.sources},()=>new Float32Array(244).map(()=>random()*2-1));}
  const out=[];
  for(let s=0;s<config.sources;s++){
    const key=`transfer-benchmark-v1:source:${track}:${s}`,sim=new Simulation({track,seed:key}),coach=new LearningCoach(),random=seededRandom(key);
    coach.setContext({profile:config.profile,track,maxSpeed:15,traction:.5,seconds:config.seconds});
    for(let g=0;g<config.sourceGenerations;g++){
      const batch=buildPopulation({N:config.sourcePopulation,incumbent:coach.incumbent,plan:coach.plan(.22,false),random});
      sim.begin(batch.flat);const result=sim.run(config.seconds);coach.record(result,result.vector);
    }
    out.push(coach.incumbent.vector);
  }
  return out;
}
// In-process stand-in for trial-worker.js: same seeded streams, same trial loop.
const spawn=target=>()=>{const worker={postMessage(m){
  const sim=new Simulation({track:target,seed:m.key+':physics'});
  const simulate=flat=>{sim.begin(flat);const result=sim.run(m.seconds),gates=sim.road.checkPointList.length;
    return {...result,meanProgress:sim.cars.reduce((sum,c)=>sum+c.checkPointsCount+c.laps*gates,0)/sim.cars.length};};
  const result=runTrialArm({simulate,context:m.context,
    seeds:m.seeds.map((vector,i)=>({vector,id:'memory-'+i})),random:seededRandom(m.key+':population'),exploration:m.exploration,...m.options});
  setTimeout(()=>worker.onmessage({data:{type:'result',id:m.id,arm:m.arm,...result}}),0);
},terminate(){}};return worker;};

const results=[];
for(const [source,target] of config.pairs){
  const seeds=memories(source),started=Date.now(),runs=[];
  const context={profile:config.profile,track:target,maxSpeed:15,traction:.5,seconds:config.seconds};
  let result;
  do{
    result=await runTransferCheck({context,track:{},profile:config.profile,maxSpeed:15,traction:.5,seconds:config.seconds,seeds,spawn:spawn(target)});
    runs.push({state:result.state,trials:result.trials});
  }while(result.state==='inconclusive'&&result.trials<MAX_TOTAL_TRIALS);
  const summary=result;
  results.push({source,target,...summary,runs,secondsPerTrial:(Date.now()-started)/1000/Math.max(1,result.trials)});
  console.log(`${source} memories on ${target}: ${result.state} after ${result.trials} trials in ${runs.length} run(s) · memory ${result.memoryWins}, fresh ${result.freshWins}, ties ${result.ties} · evidence ${Math.max(result.evidence.memory,result.evidence.fresh).toFixed(1)}x · ${((Date.now()-started)/1000/Math.max(1,result.trials)).toFixed(2)} s/trial`);
}
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify({version:1,config,method:'Paired trials: both arms restart from generation 0 with shared seeded streams; arm A seeds from source-track champions, arm B starts fresh. Anytime-valid betting test (alpha .05 each direction, lambda .5) stops at 20x evidence; inconclusive checks are continued up to '+MAX_TOTAL_TRIALS+' trials. Trial winner: final best progress, then summed best progress over generations. Timing covers trials only.',results},null,2)+'\n');
console.log(`Saved ${output}`);
