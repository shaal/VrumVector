// Issue #72: does re-injecting the reflex car when progress stalls cut the
// generations from the stagnation flag to the next improvement? Paired
// runTrialArm runs. Both arms start like a live cold start (the #62 reflex
// seed in generation 0) and share every seeded stream (population and
// physics). The re-injected reflex draws its random weights first, so the two
// arms are identical up to the first flag; after it they diverge.
//
// Fixed before the runs (#72 measurement rule):
// - Flag: the first generation whose plan has stagnant === 5 (REINJECT_STAGNANT).
// - Primary metric: generations from that flag generation to the first
//   generation at or after it whose result improves the coach's incumbent
//   (progress, then style + 1e-5, as LearningCoach.record). No improvement
//   before the cap counts as (generations - flag), censored.
// - Summary: mean and median recovery per arm (censored = cap), and
//   re-inject sooner / later / tie. Gain = 1 - mean(reinject) / mean(base).
// - Primary condition: the live cold start (the #62 seed ON, the default).
//   --seed=0 (no reflex in generation 0) is secondary.
// - Kill criterion: drop it if the primary gain is under 5% on both Rect and
//   Tri. It ships ON only if it clears 5% on at least one of them and does
//   not get worse on the other.
// - Secondary, not paired after the first flag: every flag episode in each
//   arm, and the final champion progress.
// Each finished pair is one JSON line, so a run can be split and resumed.
//
//   node scripts/benchmark-reflex-reinject.mjs --tracks=Rectangle,Triangle,Oval --family=s1 --runs=6
//     [--generations=60] [--seconds=20] [--population=24] [--every=5] [--seed=0] [--output=test-results/reflex-reinject.jsonl]
import {appendFile,mkdir,readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Simulation} from '../tests/helpers/simulation.mjs';
import {runTrialArm} from '../AI-Car-Racer/learning/trial.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const options=Object.fromEntries(process.argv.slice(2).map(arg=>{const [k,...v]=arg.replace(/^--/,'').split('=');return [k,v.join('=')];}));
const tracks=(options.tracks||'Rectangle,Triangle').split(',');
const family=options.family||'s1',runs=Number(options.runs)||6,start=Number(options.start)||0;
const generations=Number(options.generations)||60,seconds=Number(options.seconds)||20,population=Number(options.population)||24;
const every=Number(options.every)||5;
// --seed=0: no reflex in generation 0 either (a population that never saw it).
const seedReflex=options.seed!=='0';
const output=options.output||'test-results/reflex-reinject.jsonl';

function arm({track,key,reinject}){
  const sim=new Simulation({track,seed:key+':physics'});
  let generation=0,best=null;const rows=[];
  const simulate=(flat,batch)=>{
    sim.begin(flat);const result=sim.run(seconds);
    const progress=Math.max(0,result.fitness),style=Math.min(1,Math.max(0,result.styleScore||0));
    const improved=!best||progress>best.fitness||(progress===best.fitness&&style>best.style+1e-5);
    if(improved)best={fitness:progress,style};
    rows.push({g:generation,fitness:progress,improved,reflex:batch.counts.reflex,laps:result.laps});
    generation++;return result;
  };
  const context={profile:'balanced',track,maxSpeed:15,traction:.5,seconds};
  runTrialArm({simulate,context,seeds:[],random:seededRandom(key+':population'),generations,population,
    reflex:seedReflex,reinjectReflex:reinject?every:null});
  // stagnant before generation g = generations since the last improvement.
  const flags=[];let stagnant=0;
  for(const row of rows){if(stagnant===5)flags.push(row.g);stagnant=row.improved?0:stagnant+1;}
  const recovery=f=>{const hit=rows.find(r=>r.g>=f&&r.improved);return hit?{gens:hit.g-f,censored:false}:{gens:generations-f,censored:true};};
  return {best:best?.fitness??0,flags,episodes:flags.map(f=>({flag:f,...recovery(f)})),
    reflexCars:rows.reduce((n,r)=>n+r.reflex,0),history:rows.map(r=>r.fitness)};
}

const done=new Set(),doneKey=(key,g,s,e)=>`${key}|${g}|${s}|${e}`;
try{for(const line of (await readFile(output,'utf8')).split('\n'))if(line.trim()){const r=JSON.parse(line);done.add(doneKey(r.key,r.generations,r.seconds,r.every));}}catch{}
await mkdir(dirname(output),{recursive:true});
for(const track of tracks)for(let r=start;r<start+runs;r++){
  const key=`reflex-reinject-v1:${family}:${track}:${r}`+(population===24?'':`:N${population}`)+(seedReflex?'':':noseed');
  if(done.has(doneKey(key,generations,seconds,every)))continue;
  const t0=Date.now();
  const baseline=arm({track,key,reinject:false}),reinject=arm({track,key,reinject:true});
  const row={key,track,family,run:r,generations,seconds,population,every,seedReflex,baseline,reinject,ms:Date.now()-t0};
  await appendFile(output,JSON.stringify(row)+'\n');
  const first=a=>a.episodes[0]?a.episodes[0].gens+(a.episodes[0].censored?'+':''):'-';
  console.log(`${track} ${family}#${r}: flag ${baseline.flags[0]??'-'} · base ${first(baseline)} · reinject ${first(reinject)} · ${(row.ms/1000).toFixed(1)} s`);
}
