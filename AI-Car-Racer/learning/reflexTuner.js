// Issue #70: tune the reflex driver (reflex.js) for one track. A small search
// over the 11 numbers of REFLEX_TUNING, scored by short headless drives of the
// reflex car alone, instead of a search over all 244 weights.
//
// Pure: the caller supplies drive(flat, variant) -> {fitness, lastGateFrame}
// for one car, so the same search runs in Node benchmarks and in the browser.
// The search scores every candidate on variant 0. The finalists are then also
// driven on variants 1..variants-1 and ranked by their mean score. The car is
// deterministic, so the variants are the source of noise-robustness: the
// callers use them for the live sensor strides (sim-worker.js computeStride),
// where AI cars that are not the leader skip some sensor reads. A tuning that
// laps only at stride 1 can lose every gate at stride 2.
// The default tuning is always candidate 0 and always a finalist, and a
// finalist must score at least the default's score on variant 0. So the tuned
// reflex is never worse than the fixed one on variant 0 (stride 1: the leader
// reads its sensors every frame) or on the mean over the variants.
import {REFLEX_TUNING,reflexBrain} from './reflex.js';

// Weight limit of the shared cloud brain (cloud/wire.js LIMITS.maxWeight).
export const REFLEX_MAX_WEIGHT=16;

// Search range per number. Every product that becomes a weight stays within
// REFLEX_MAX_WEIGHT at the bounds (steerGain*side <= 8, frontGain*frontSide <= 6).
export const TUNING_BOUNDS=Object.freeze({
  side0:[0,2],side1:[0,2],side2:[0,2],
  steerGain:[.25,4],steerDeadband:[0,.5],
  frontGain:[0,6],frontSide:[0,1],
  throttleOff:[-.5,1],speedThrottle:[0,1.5],
  brakeOn:[0,1.5],speedBrake:[0,1.5],
  gateGain:[0,16],gateSteer:[0,2],
});
const KEYS=Object.keys(TUNING_BOUNDS);

// Sensor stride per variant: 1, then the live strides at simSpeed 3-5 and 6-20.
export const TUNE_STRIDES=Object.freeze([1,2,4]);
export const TUNER_DEFAULTS=Object.freeze({drives:52,warmup:20,rounds:5,elite:4,spread:.3,shrink:.6,finalists:4,variants:3});

const clamp=(v,[lo,hi])=>Math.min(hi,Math.max(lo,v));
export function toVector(tuning){
  const t={...REFLEX_TUNING,...tuning};
  return KEYS.map(k=>k.startsWith('side')?t.side[Number(k[4])]:t[k]);
}
export function fromVector(v){
  const t={side:[0,0,0]};
  KEYS.forEach((k,i)=>{const x=clamp(v[i],TUNING_BOUNDS[k]);if(k.startsWith('side'))t.side[Number(k[4])]=x;else t[k]=x;});
  t.side=Object.freeze(t.side);
  return Object.freeze(t);
}
// A tuning is usable when every number is finite and inside its bounds and the
// brain it builds fits the cloud brain's weight limit.
export function validTuning(t){
  if(!t||typeof t!=='object'||!Array.isArray(t.side)||t.side.length!==3)return false;
  const v=toVector(t);
  if(!v.every((x,i)=>Number.isFinite(x)&&x>=TUNING_BOUNDS[KEYS[i]][0]&&x<=TUNING_BOUNDS[KEYS[i]][1]))return false;
  return reflexBrain(t).every(w=>Number.isFinite(w)&&Math.abs(w)<=REFLEX_MAX_WEIGHT);
}

// Gates first, then the same gates sooner (as the live time tie-break, #60).
export function driveScore(result){
  const fitness=Number(result?.fitness)||0,frame=Math.max(0,Number(result?.lastGateFrame)||0);
  return fitness+(fitness>0?1e-3/(1+frame):0);
}

// Gaussian draw from a uniform stream (Box-Muller).
const gauss=random=>Math.sqrt(-2*Math.log(1-random()))*Math.cos(2*Math.PI*random());

// Search: candidate 0 is the default; a wide uniform warm-up over the bounds;
// then rounds that sample around the best few, with a spread that shrinks each
// round. `drives` caps the search drives; the finalists add up to
// (finalists + 1) * (variants - 1) more. The search stops early when
// `budgetMs` runs out (now() is injectable for tests); the finalist phase
// always runs, so the default is always re-scored.
export function tuneReflex({drive,random=Math.random,budgetMs=Infinity,now=()=>Date.now(),...options}){
  const {drives,warmup,rounds,elite,spread,shrink,finalists,variants}={...TUNER_DEFAULTS,...options};
  const start=now(),scored=[];let count=0;
  const run=(tuning,variant)=>{count++;return driveScore(drive(reflexBrain(tuning),variant));};
  const evaluate=vector=>{
    const tuning=fromVector(vector);
    scored.push({tuning,vector:toVector(tuning),score:run(tuning,0),index:scored.length});
  };
  const left=()=>scored.length<drives&&now()-start<budgetMs;
  evaluate(toVector(REFLEX_TUNING));
  for(let i=1;i<warmup&&left();i++)evaluate(KEYS.map(k=>{const [lo,hi]=TUNING_BOUNDS[k];return lo+random()*(hi-lo);}));
  const perRound=Math.max(1,Math.ceil((drives-scored.length)/rounds));
  const ranked=()=>[...scored].sort((a,b)=>b.score-a.score||a.index-b.index);
  for(let round=0;left();round++){
    const top=ranked().slice(0,elite);
    const mean=KEYS.map((_,i)=>top.reduce((s,c)=>s+c.vector[i],0)/top.length);
    const sigma=spread*Math.pow(shrink,Math.min(round,rounds));
    for(let j=0;j<perRound&&left();j++){
      // Half the draws centre on the best, half on the mean of the best few.
      const centre=j%2?top[0].vector:mean;
      evaluate(KEYS.map((k,i)=>{const [lo,hi]=TUNING_BOUNDS[k];return centre[i]+gauss(random)*sigma*(hi-lo);}));
    }
  }
  const searched=count;
  // Finalists: the default plus the best few that are not worse than it on
  // variant 0, each driven on every variant.
  const pool=[scored[0],...ranked().filter(c=>c.index!==0&&c.score>=scored[0].score).slice(0,finalists)];
  for(const c of pool){
    let sum=c.score;for(let v=1;v<variants;v++)sum+=run(c.tuning,v);
    c.robust=sum/Math.max(1,variants);
  }
  // Ties go to the earlier candidate, so the default wins a tie.
  const best=pool.reduce((a,b)=>b.robust>a.robust?b:a);
  return {tuning:best.tuning,score:best.robust,defaultScore:scored[0].robust,searchScore:best.score,
    drives:count,searched,ms:now()-start};
}

// Per-track cache: the next cold start on the same track reuses the result.
const STORE='vv.reflexTuning',MAX_ENTRIES=20;
export function tuningKey(context){
  if(!context?.track)return null;
  // Version the key so a change to the search, the bounds, or the car's
  // physics or sensors (car.js, sensor.js) re-tunes: bump v1 then.
  return ['v1',context.track,context.profile,context.maxSpeed,context.traction,context.seconds,context.collisions||'off'].join('|');
}
function readStore(storage){try{const v=JSON.parse(storage?.getItem?.(STORE)||'{}');return v&&typeof v==='object'?v:{};}catch{return {};}}
export function cachedTuning(context,storage=globalThis.localStorage){
  const key=tuningKey(context);if(!key)return null;
  let entry=null;try{entry=readStore(storage)[key];}catch{}
  return entry&&validTuning(entry.tuning)?fromVector(toVector(entry.tuning)):null;
}
export function storeTuning(context,result,storage=globalThis.localStorage){
  const key=tuningKey(context);if(!key||!validTuning(result?.tuning))return false;
  try{
    const all=readStore(storage);
    all[key]={tuning:{...result.tuning,side:[...result.tuning.side]},score:result.score,defaultScore:result.defaultScore,at:Date.now()};
    const kept=Object.entries(all).sort((a,b)=>(b[1]?.at||0)-(a[1]?.at||0)).slice(0,MAX_ENTRIES);
    storage.setItem(STORE,JSON.stringify(Object.fromEntries(kept)));return true;
  }catch{return false;}
}

// Put the tuned reflex in place of the fixed one. Only a batch whose slot 0 is
// the reflex car (a cold start, buildPopulation reflex:true) changes; every
// other car stays as built, so paired arms still share them. Returns whether
// it changed the batch.
export function applyReflexTuning(batch,tuning){
  if(batch?.kinds?.[0]!=='reflex'||!validTuning(tuning))return false;
  batch.flat.set(reflexBrain(tuning),0);return true;
}
// A short, stable tag for a tuning, for test identities (transferCheck.js).
export function tuningTag(tuning){
  let h=0x811c9dc5;
  for(const ch of toVector(tuning).map(v=>v.toFixed(4)).join(',')){h^=ch.charCodeAt(0);h=Math.imul(h,0x01000193)>>>0;}
  return h.toString(16).padStart(8,'0');
}

// Drive one car on the page's own simulator (the main thread), for the live
// cold start. makeCar() returns a new car at the start line. The page's
// frameCount and SENSOR_STRIDE are globals that car.js reads; they are set
// for the drive and put back after it.
export function pageDrive({makeCar,road,seconds,scope=globalThis}){
  return (flat,variant)=>{
    if(flat?.length!==244)throw new Error('A reflex brain has 244 values.');
    const frame=scope.frameCount,stride=scope.SENSOR_STRIDE;
    try{
      scope.SENSOR_STRIDE=TUNE_STRIDES[variant]??1;
      const car=makeCar();let at=0;
      for(const level of car.brain.levels){for(let j=0;j<level.biases.length;j++)level.biases[j]=flat[at++];for(let j=0;j<level.weights.length;j++)level.weights[j]=flat[at++];}
      // A car that is not the leader skips sensor reads at stride > 1 (car.js).
      car.senseEveryFrame=false;
      for(let f=1;f<=seconds*60&&!car.damaged;f++){scope.frameCount=f;car.update(road.borders,road.checkPointList);}
      return {fitness:car.checkPointsCount+car.laps*road.checkPointList.length,lastGateFrame:car.lastGateFrame};
    }finally{scope.frameCount=frame;scope.SENSOR_STRIDE=stride;}
  };
}
// Main-thread time budget for the search on a cold start. It is checked
// between drives, and the 10 finalist drives run after it, so a tune takes
// somewhat longer: about 0.1-0.5 s in Chromium at 20-100 s generations, and up
// to about 1.5 s with the CPU throttled 6x.
export const REFLEX_TUNE_BUDGET_MS=1200;

// Flag. Turn it off for one browser with localStorage.reflexTune = '0'.
export const REFLEX_TUNE_DEFAULT=true;
export function reflexTuneEnabled(storage){
  try{const v=(storage===undefined?globalThis.localStorage:storage)?.getItem?.('reflexTune');if(v==='1')return true;if(v==='0')return false;}catch{}
  return REFLEX_TUNE_DEFAULT;
}
