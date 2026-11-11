// Paired benchmark for the elite re-score (issue #61, AI-Car-Racer/eliteRescore.js).
//
// For each track and seed, three arms run the same runTrialArm loop with the
// same population and pose streams: control (plain elite pick), mean and min
// (re-score the top 8, crown by mean or by minimum rank). After the last
// generation each arm's champion drives alone, with full sensors, from 16
// held-out jittered start poses. Survival there is the issue's metric: the
// kill criterion is < 5 points of survival gain on either track.
//
// One JSON row per (namespace, track, seed, arm) goes to --output (JSONL);
// a rerun skips rows that are already there, so a long run can resume.
//   node scripts/benchmark-elite-rescore.mjs --ns=s1 --seeds=3 [--stride=1] [--tracks=Rectangle,Triangle]
//   node scripts/benchmark-elite-rescore.mjs --report
import vm from 'node:vm';
import {readFile,appendFile,mkdir} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {Simulation} from '../tests/helpers/simulation.mjs';
import {runTrialArm} from '../AI-Car-Racer/learning/trial.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const opt=Object.fromEntries(process.argv.slice(2).map(a=>{const [k,...v]=a.replace(/^--/,'').split('=');return [k,v.length?v.join('='):'1'];}));
const output=opt.output||'test-results/elite-rescore.jsonl';
const cfg={tracks:(opt.tracks||'Rectangle,Triangle').split(','),arms:(opt.arms||'control,mean,min,tmean,tmin').split(','),
  seeds:Number(opt.seeds)||3,ns:opt.ns||'s1',stride:Number(opt.stride)||1,generations:Number(opt.generations)||12,
  population:Number(opt.population)||100,seconds:Number(opt.seconds)||15,evalPoses:16,radiusPx:12,angleDeg:6};
const rescoreSource=await readFile(new URL('../AI-Car-Racer/eliteRescore.js',import.meta.url),'utf8');

// --report reads every file in --inputs (comma-separated); rows carry ns, so merging is safe.
function rows(files=[output]){return files.flatMap(f=>existsSync(f)?readFileSync(f,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)):[]);}
function signTest(w,l){const n=w+l;if(!n)return 1;const k=Math.min(w,l);let p=0,c=1;for(let i=0;i<=n;i++){if(i<=k)p+=c;c=c*(n-i)/(i+1);}return Math.min(1,2*p/2**n);}

function loadBrain(car,flat){let at=0;for(const level of car.brain.levels){for(let j=0;j<level.biases.length;j++)level.biases[j]=flat[at++];for(let j=0;j<level.weights.length;j++)level.weights[j]=flat[at++];}}
function vectorOf(car){const v=new Float32Array(244);let at=0;for(const level of car.brain.levels){for(const n of level.biases)v[at++]=n;for(const n of level.weights)v[at++]=n;}return v;}

function runArm({track,seed,arm}){
  const key=`elite-rescore-v1:${cfg.ns}:${track}:${seed}`;
  const sim=new Simulation({track,seed:key+':physics'});
  vm.runInContext(rescoreSource,sim.scope,{filename:'eliteRescore.js'});
  sim.scope.SENSOR_STRIDE=cfg.stride;
  const ER=sim.scope.EliteRescore,gates=sim.road.checkPointList.length,profiles=sim.scope.DriverProfiles;
  const startInfo={x:sim.spawn.x,y:sim.spawn.y,heading:sim.spawn.angle};
  // mean/min: pool 'top' (issue #61 as written); tmean/tmin: pool 'tied' (the shipped default).
  const config=arm==='control'?null:ER.config({enabled:true,mode:arm.endsWith('min')?'min':'mean',pool:arm.startsWith('t')?'tied':'top',radiusPx:cfg.radiusPx,angleDeg:cfg.angleDeg});
  const poseRandom=seededRandom(key+':rescore');
  let runningBest=-Infinity,gen=0;const log=[];let popCarFrames=0,rescoreCarFrames=0,popMs=0,rescoreMs=0;
  const simulate=flat=>{
    const t0=performance.now();sim.begin(flat);let result=sim.run(cfg.seconds);popMs+=performance.now()-t0;
    popCarFrames+=sim.cars.length*cfg.seconds*60;   // nominal; crashed cars cost almost nothing
    const entry={gen:gen++,changed:false,adopted:false};
    // Poses come from their own stream, so the population and physics streams stay paired.
    const r=config?ER.crown({cars:sim.cars,road:sim.road,startInfo,maxSpeed:sim.maxSpeed,seconds:cfg.seconds,config,random:poseRandom}):null;
    if(r){
      rescoreCarFrames+=r.carFrames;rescoreMs+=r.ms;entry.changed=r.changed;
      if(r.changed){
        const c=sim.cars[r.index],fitness=c.checkPointsCount+c.laps*gates;
        result={...result,vector:vectorOf(c),fitness,laps:c.laps,styleScore:profiles.styleScore(c),driving:profiles.summarize(c)};
        entry.adopted=fitness>runningBest;
      }
    }
    runningBest=Math.max(runningBest,result.fitness);log.push(entry);
    return {...result,meanProgress:sim.cars.reduce((s,c)=>s+c.checkPointsCount+c.laps*gates,0)/sim.cars.length};
  };
  const context={profile:'balanced',track,maxSpeed:15,traction:.5,seconds:cfg.seconds};
  const out=runTrialArm({simulate,context,seeds:[],random:seededRandom(key+':population'),generations:cfg.generations,population:cfg.population,returnChampion:true});
  // Held-out check: the champion alone from 16 jittered poses (third stream).
  const {poses}=ER.poses(sim.road,startInfo,{poses:cfg.evalPoses,radiusPx:cfg.radiusPx,angleDeg:cfg.angleDeg,maxAttempts:16},seededRandom(key+':eval'));
  const evalPoses=poses.slice(1);let alive=0,progress=0;
  for(const p of evalPoses){
    const c=new sim.scope.CarClass(p.x,p.y,30,50,'AI',sim.maxSpeed,p.angle);c.driverProfile='balanced';c.senseEveryFrame=true;loadBrain(c,out.champion);
    for(let f=1;f<=cfg.seconds*60&&!c.damaged;f++){sim.scope.frameCount=f;c.update(sim.road.borders,sim.road.checkPointList);}
    if(!c.damaged)alive++;progress+=c.checkPointsCount+c.laps*gates;
  }
  return {ns:cfg.ns,track,seed,arm,stride:cfg.stride,generations:cfg.generations,population:cfg.population,seconds:cfg.seconds,
    best:out.best,area:out.area,evalN:evalPoses.length,evalSurvival:alive/Math.max(1,evalPoses.length),evalProgress:progress/Math.max(1,evalPoses.length),
    changedGens:log.filter(e=>e.changed).length,adoptedGens:log.filter(e=>e.adopted).length,
    popCarFrames,rescoreCarFrames,popMs:Math.round(popMs),rescoreMs:Math.round(rescoreMs)};
}

function report(){
  const all=rows((opt.inputs||output).split(',')),by=new Map();
  for(const r of all){const k=`${r.ns}|${r.track}|${r.seed}|${r.stride}`;if(!by.has(k))by.set(k,{});by.get(k)[r.arm]=r;}
  for(const stride of [...new Set(all.map(r=>r.stride))])for(const track of [...new Set(all.map(r=>r.track))])for(const arm of ['mean','min','tmean','tmin']){
    const pairs=[...by.values()].filter(p=>p.control&&p[arm]&&p.control.track===track&&p.control.stride===stride);
    if(!pairs.length)continue;
    const d=pairs.map(p=>100*(p[arm].evalSurvival-p.control.evalSurvival)),db=pairs.map(p=>p[arm].best-p.control.best);
    const mean=a=>a.reduce((s,v)=>s+v,0)/a.length,sd=a=>Math.sqrt(a.reduce((s,v)=>s+(v-mean(a))**2,0)/Math.max(1,a.length-1));
    const cost=pairs.reduce((s,p)=>s+p[arm].rescoreCarFrames,0)/pairs.reduce((s,p)=>s+p[arm].popCarFrames,0);
    const msCost=pairs.reduce((s,p)=>s+p[arm].rescoreMs,0)/pairs.reduce((s,p)=>s+p[arm].popMs,0);
    console.log(`stride ${stride} ${track} ${arm} vs control: n=${pairs.length} survival Δ mean ${mean(d).toFixed(1)} pts (sd ${sd(d).toFixed(1)}, se ${(sd(d)/Math.sqrt(d.length)).toFixed(1)}) raw [${d.map(v=>v.toFixed(0)).join(', ')}]`+
      ` · best Δ [${db.map(v=>v.toFixed(0)).join(', ')}] · crown changed ${pairs.map(p=>p[arm].changedGens).join('/')} adopted ${pairs.map(p=>p[arm].adoptedGens).join('/')} of ${pairs[0][arm].generations} gens`+
      ` · extra sim time ${(100*msCost).toFixed(1)}% (car-frames vs nominal N·frames ${(100*cost).toFixed(1)}%)`);
    const w=d.filter(v=>v>0).length,l=d.filter(v=>v<0).length,perGen=pairs.reduce((s,p)=>s+p[arm].rescoreMs,0)/pairs.reduce((s,p)=>s+p[arm].generations,0);
    console.log(`   wins/losses/ties ${w}/${l}/${d.length-w-l}, sign test p=${signTest(w,l).toFixed(2)} · re-score ${perGen.toFixed(0)} ms/gen · mean eval progress Δ ${mean(pairs.map(p=>p[arm].evalProgress-p.control.evalProgress)).toFixed(2)}`);
    console.log(`   control survival [${pairs.map(p=>(100*p.control.evalSurvival).toFixed(0)).join(', ')}] ${arm} [${pairs.map(p=>(100*p[arm].evalSurvival).toFixed(0)).join(', ')}]`);
  }
}

if(opt.report){report();process.exit(0);}
await mkdir(dirname(output),{recursive:true});
const done=new Set(rows().map(r=>`${r.ns}|${r.track}|${r.seed}|${r.arm}|${r.stride}`));
const deadline=Date.now()+(Number(opt.budget)||540)*1000;
for(let seed=0;seed<cfg.seeds;seed++)for(const track of cfg.tracks)for(const arm of cfg.arms){
  const k=`${cfg.ns}|${track}|${seed}|${arm}|${cfg.stride}`;if(done.has(k))continue;
  if(Date.now()>deadline){console.log('budget reached; rerun to continue');process.exit(0);}
  const t=Date.now(),row=runArm({track,seed,arm});await appendFile(output,JSON.stringify(row)+'\n');
  console.log(`${k}: survival ${(100*row.evalSurvival).toFixed(0)}% best ${row.best} changed ${row.changedGens} adopted ${row.adoptedGens} (${((Date.now()-t)/1000).toFixed(1)}s)`);
}
console.log('all rows done');
