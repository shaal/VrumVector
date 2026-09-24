// Runs Auto Train (AI-Car-Racer/learning/autoTrain.js) end to end on real
// physics, with the preset values from buttonResponse.js, the genetic policy,
// and the training-health clock, and records every phase change. It follows
// the app's path with Vector Memory off: each learning context (the round
// length is part of it) keeps its own champion, the health clock resets when
// the context changes, and the last generation's best brain seeds the next.
// Not modelled: Vector Memory seeds, and the sensor stride the app uses above
// 2x (Grind runs at 20x). This shows when the phase changes fire; it does not
// compare Auto Train with a fixed preset.
// Usage: node scripts/benchmark-auto-train.mjs [output.json] [generations]
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import vm from 'node:vm';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {Simulation} from '../tests/helpers/simulation.mjs';
import {LearningCoach,buildPopulation,contextKey} from '../AI-Car-Racer/learning/policy.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';
import {TrainingHealth,HEALTH_MODULE_URL,loadHealth} from '../AI-Car-Racer/learning/health.js';
import {AutoTrainPolicy,PLATEAU_GENERATIONS,BOUNCE_GENERATIONS,START_GATE_CREDIT} from '../AI-Car-Racer/learning/autoTrain.js';

const TRACES=['Rectangle','Triangle'].flatMap(track=>[0,1,2,3,4,5].map(seed=>[track,seed]));

async function presets(){
  const source=await readFile(new URL('../AI-Car-Racer/buttonResponse.js',import.meta.url),'utf8');
  const start=source.indexOf('const TRAINING_PRESETS'),end=source.indexOf('};',start)+2;
  const scope=vm.createContext({});vm.runInContext(source.slice(start,end).replace('const TRAINING_PRESETS','globalThis.TRAINING_PRESETS'),scope);
  return scope.TRAINING_PRESETS;
}

async function trace({track,seed,generations}){
  const wasm=await import(HEALTH_MODULE_URL);
  wasm.initSync({module:await readFile(new URL('../vendor/ruvector/emergent_time_wasm/emergent_time_wasm_bg.wasm',import.meta.url))});
  if(!await loadHealth())throw Error('health wasm failed to load');
  const P=await presets(),key=`auto-train-v1:${track}:${seed}`,sim=new Simulation({track,seed:key}),random=seededRandom(key);
  const policy=new AutoTrainPolicy(),health=new TrainingHealth(),coach=new LearningCoach(),champions=new Map();
  let phase='fresh',prior=null,contextId=null;const rows=[],changes=[];
  for(let g=0;g<generations;g++){
    const p=P[phase],context={profile:'balanced',track,maxSpeed:15,traction:.5,seconds:p.seconds},id=contextKey(context);
    if(id!==contextId){
      // DriverLearning.prepare: a new context resets the coach and the clock and restores that context's champion.
      if(coach.incumbent)champions.set(contextId,coach.incumbent);
      coach.setContext(context);coach.incumbent=champions.get(id)||null;health.reset();contextId=id;
    }
    const plan=coach.plan(p.mutate,false,1);
    const batch=buildPopulation({N:p.N,seeds:prior?[{vector:prior,id:null}]:[],incumbent:coach.incumbent,plan,random,conservative:p.conservativeInit});
    sim.begin(batch.flat);const r=sim.run(p.seconds);coach.record(r,r.vector);prior=r.vector;
    const snapshot=health.observe({best:coach.incumbent.fitness,genBest:r.fitness,gates:sim.road.checkPointList.length,mutation:plan.mutation,champion:coach.incumbent.vector});
    const next=policy.observe({fitness:r.fitness,laps:r.laps},snapshot,true);
    rows.push({generation:g,phase,fitness:r.fitness,laps:r.laps,champion:coach.incumbent.fitness,health:snapshot?.state??null,sinceProgress:snapshot?.sinceProgress??null});
    if(next){changes.push({generation:g,from:phase,to:next,reason:policy.reason});phase=next;}
    if(g%10===9)console.error(`${track} seed ${seed}: generation ${g+1}, ${phase}`);
  }
  return {track,seed,gates:sim.road.checkPointList.length,changes,rows};
}

if(!isMainThread){parentPort.postMessage(await trace(workerData));}
else{
  const output=process.argv[2]||'test-results/auto-train.json',generations=Number(process.argv[3]||60);
  const started=Date.now();
  const traces=await Promise.all(TRACES.map(([track,seed])=>new Promise((resolve,reject)=>{
    const worker=new Worker(new URL(import.meta.url),{workerData:{track,seed,generations}});
    worker.once('message',resolve);worker.once('error',reject);
    worker.once('exit',code=>{if(code)reject(Error(`${track} seed ${seed} exited with ${code}`));});
  })));
  const summary=traces.map(t=>{
    const first=to=>t.changes.find(c=>c.to===to)?.generation??null;
    const count=phase=>t.rows.filter(r=>r.phase===phase).length;
    const bounces=t.changes.filter(c=>c.from==='polish'),returns=t.changes.filter(c=>c.from==='grind'&&c.to==='polish').slice(1);
    // Descriptive only: after each bounce, did the Polish champion gain in the next Polish stint?
    const afterBounce=bounces.map(b=>{
      const back=t.changes.find(c=>c.generation>b.generation&&c.to==='polish'),end=t.changes.find(c=>back&&c.generation>back.generation&&c.from==='polish');
      const stint=back?t.rows.filter(r=>r.generation>back.generation&&(!end||r.generation<=end.generation)):[];
      const before=t.rows[b.generation].champion,after=stint.length?Math.max(...stint.map(r=>r.champion)):null;
      return {bounceAt:b.generation,returnedAt:back?.generation??null,polishChampionBefore:before,polishChampionAfter:after,gained:after!==null&&after>before};
    });
    return {track:t.track,seed:t.seed,gates:t.gates,firstGrind:first('grind'),firstPolish:first('polish'),bounces:bounces.length,
      returnsToPolish:returns.length,generations:{fresh:count('fresh'),grind:count('grind'),polish:count('polish')},afterBounce,changes:t.changes};
  });
  for(const s of summary)console.log(`${s.track} seed ${s.seed}: Grind at ${s.firstGrind}, Polish at ${s.firstPolish}, ${s.bounces} bounce(s), ${s.returnsToPolish} return(s); generations ${JSON.stringify(s.generations)}; after bounces ${JSON.stringify(s.afterBounce.map(a=>[a.polishChampionBefore,a.polishChampionAfter]))}`);
  const report={version:2,generations,plateau:PLATEAU_GENERATIONS,bounce:BOUNCE_GENERATIONS,startGateCredit:START_GATE_CREDIT,presets:await presets(),
    seconds:Math.round((Date.now()-started)/1000),summary,traces};
  await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(`Saved ${output} in ${report.seconds}s`);
}
