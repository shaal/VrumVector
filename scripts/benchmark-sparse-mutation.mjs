// Sparse additive mutation (#63) against the lerp-toward-noise mutation, with
// paired runTrialArm runs: both arms start fresh (no memories) from the same
// seeded physics and population streams, on Rectangle and Triangle.
//
//   node scripts/benchmark-sparse-mutation.mjs --family=A --runs=6
//
// Each finished run is saved at once and skipped on a rerun, so the work can
// be split across commands. Families are disjoint seed sets (the "sessions").
//
// Measured per arm: generation of the first lap (null: none within K), best
// progress after K generations (checkpoints + laps * gates), and the fraction
// of mutated children that strictly beat the elite copy of their parent
// driven in the same generation (elite and random cars are left out; a tie
// counts as not beating it).
//
// Decision rule, fixed before any run: sparse ships ON only if, on BOTH
// tracks with all families pooled (n >= 12), it wins more paired trials than
// it loses (compareOutcomes: best after K, then area) AND the median paired
// difference in best after K is > 0. Otherwise it stays behind a flag, off.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Simulation} from '../tests/helpers/simulation.mjs';
import {runTrialArm,compareOutcomes} from '../AI-Car-Racer/learning/trial.js';
import {SPARSE_MUTATION} from '../AI-Car-Racer/learning/policy.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const options=Object.fromEntries(process.argv.slice(2).map(arg=>{const [k,...v]=arg.replace(/^--/,'').split('=');return [k,v.join('=')];}));
const config={tracks:(options.tracks||'Rectangle,Triangle').split(','),family:options.family||'A',runs:Number(options.runs)||6,
  generations:Number(options.generations)||25,population:Number(options.population)||100,mutation:.22,seconds:Number(options.seconds)||20,profile:'balanced',
  sparse:{...SPARSE_MUTATION}};
const output=options.output||'test-results/sparse-mutation-benchmark.json';
let saved={version:1,runs:[]};
try{saved=JSON.parse(await readFile(output,'utf8'));}catch(_){}
// Runs saved with other settings are never pooled with these.
const same=r=>r.generations===config.generations&&r.population===config.population&&r.seconds===config.seconds;
if(saved.runs.some(r=>!same(r)))throw Error(output+' holds runs with other settings; use another --output');
const done=new Set(saved.runs.map(r=>r.key));

function arm(track,key,sparse){
  const sim=new Simulation({track,seed:key+':physics'}),gates=sim.road.checkPointList.length;
  let generation=0,firstLap=null,beat=0,children=0;
  const simulate=(flat,batch)=>{
    sim.begin(flat);const result=sim.run(config.seconds);
    const fit=sim.cars.map(c=>c.checkPointsCount+c.laps*gates);
    if(batch.kinds[0]==='elite')batch.kinds.forEach((kind,i)=>{if(kind==='mutation'){children++;if(fit[i]>fit[0])beat++;}});
    if(firstLap===null&&result.laps>0)firstLap=generation;
    generation++;return result;
  };
  const context={profile:config.profile,track,maxSpeed:15,traction:.5,seconds:config.seconds};
  const r=runTrialArm({simulate,context,random:seededRandom(key+':population'),generations:config.generations,
    population:config.population,mutation:config.mutation,sparse});
  return {best:r.best,area:r.area,firstLap,beat,children,history:r.history};
}

for(const track of config.tracks)for(let run=0;run<config.runs;run++){
  const key=`sparse-mutation-v1:${config.family}:${track}:${run}`;
  if(done.has(key))continue;
  const started=Date.now();
  const lerp=arm(track,key,null),sparse=arm(track,key,config.sparse);
  saved.runs.push({key,family:config.family,track,run,generations:config.generations,population:config.population,seconds:config.seconds,lerp,sparse,winner:compareOutcomes(sparse,lerp)});
  await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(saved,null,1)+'\n');
  console.log(`${key}: lerp best ${lerp.best} lap@${lerp.firstLap} beat ${lerp.beat}/${lerp.children} · sparse best ${sparse.best} lap@${sparse.firstLap} beat ${sparse.beat}/${sparse.children} · ${((Date.now()-started)/1000).toFixed(0)} s`);
}

// Summary over every saved run.
const median=a=>{const s=[...a].sort((x,y)=>x-y);return s.length?(s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2):NaN;};
// Two-sided sign test on decided pairs.
const sign=(w,l)=>{const n=w+l;if(!n)return 1;const k=Math.min(w,l);let c=0,b=1;for(let i=0;i<=n;i++){if(i<=k)c+=b;b=b*(n-i)/(i+1);}return Math.min(1,2*c/2**n);};
const summary={};let on=true;
for(const track of [...new Set(saved.runs.map(r=>r.track))]){
  const rows=saved.runs.filter(r=>r.track===track);
  const w=rows.filter(r=>r.winner>0).length,l=rows.filter(r=>r.winner<0).length,d=median(rows.map(r=>r.sparse.best-r.lerp.best));
  const frac=arm=>{const b=rows.reduce((s,r)=>s+r[arm].beat,0),c=rows.reduce((s,r)=>s+r[arm].children,0);return c?b/c:NaN;};
  const lap=arm=>({lapped:rows.filter(r=>r[arm].firstLap!==null).length,median:median(rows.filter(r=>r[arm].firstLap!==null).map(r=>r[arm].firstLap))});
  summary[track]={n:rows.length,families:[...new Set(rows.map(r=>r.family))],sparseWins:w,lerpWins:l,ties:rows.length-w-l,signP:sign(w,l),
    medianBestDiff:d,bestLerp:median(rows.map(r=>r.lerp.best)),bestSparse:median(rows.map(r=>r.sparse.best)),
    beatParentLerp:frac('lerp'),beatParentSparse:frac('sparse'),firstLapLerp:lap('lerp'),firstLapSparse:lap('sparse')};
  if(!(w>l&&d>0&&rows.length>=12))on=false;
  console.log(track,JSON.stringify(summary[track]));
}
saved.summary=summary;saved.decision=on&&Object.keys(summary).length>=2?'on':'off';saved.config=config;
await writeFile(output,JSON.stringify(saved,null,1)+'\n');
console.log('decision (needs both tracks, n>=12 each):',saved.decision);
