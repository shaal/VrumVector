// Transfer check: does starting a run from memories of *other* tracks or
// styles beat starting it fresh on this track? Runs paired trials off the
// render path and stops as soon as either direction has anytime-valid evidence
// (20x wealth, alpha = .05 each way). When fresh starts win, transfer seeds are
// paused for this learning context; only memories from the same context stay
// in use.
//
// What is compared is the whole starting procedure, as live training uses it:
// memories take the elite and most mutation slots. The question the pause
// decides is "does seeding from these memories give a better champion, or the
// same champion sooner, than a fresh start here?"
//
// Each trial restarts both arms from generation 0 with shared seeded streams
// and never writes to the archive or the champion, so trials are independent.
// If the two procedures are equally good, each decided trial is a fair coin,
// which is all the betting test needs. (Live A/B generations would not
// qualify: a lucky early champion keeps winning.)
//
// Stored per context: `verdict` (a latched pause or confirmation, which alone
// drives the guard) and `test` (an unfinished test that Continue check resumes).
// A test is identified by its memory set and trial settings; changing either
// starts a new test and keeps the earlier verdict until the new test decides.
import {PairedSequentialTest} from './sequential.js';
import {compareOutcomes} from './trial.js';
import {contextKey} from './policy.js';
import {hashBrain} from '../archive/hash.js';

const STORE='vv.transferGuard',MAX_ENTRIES=40;
export const CHECK_DEFAULTS={trialsPerRun:60,generations:6,population:24};
let storeEpoch=0; // bumped by clearTransferGuards so an aborted run cannot write back

const finite=v=>Number.isFinite(v);
const validCounts=v=>v&&['memoryWins','freshWins','ties','trials'].every(k=>Number.isInteger(v[k])&&v[k]>=0)&&
  v.evidence&&finite(v.evidence.memory)&&finite(v.evidence.fresh)&&finite(v.threshold)&&typeof v.identity==='string';
function validVerdict(v){return validCounts(v)&&(v.state==='paused'||v.state==='confirmed');}
function validTest(t){
  return validCounts(t)&&Number.isInteger(t.nextTrial)&&t.nextTrial===t.trials&&t.tests?.memory&&t.tests?.fresh&&
    Array.isArray(t.outcomes?.memory)&&Array.isArray(t.outcomes?.fresh)&&t.outcomes.memory.every(finite)&&t.outcomes.fresh.every(finite);
}
// Malformed or old-format parts are dropped on read, never trusted.
function sanitize(entry){
  if(!entry||typeof entry!=='object')return null;
  const clean={verdict:validVerdict(entry.verdict)?entry.verdict:null,test:validTest(entry.test)?entry.test:null,at:finite(entry.at)?entry.at:0};
  return clean.verdict||clean.test?clean:null;
}
function readGuards(){try{const value=JSON.parse(localStorage.getItem(STORE)||'{}');return value&&typeof value==='object'?value:{};}catch{return {};}}
function writeEntry(key,entry){
  const guards=readGuards();
  if(entry)guards[key]={...entry,at:Date.now()};else delete guards[key];
  const kept=Object.entries(guards).sort((a,b)=>(b[1]?.at||0)-(a[1]?.at||0)).slice(0,MAX_ENTRIES);
  try{localStorage.setItem(STORE,JSON.stringify(Object.fromEntries(kept)));}catch{}
}
export function transferGuard(context){return context?sanitize(readGuards()[contextKey(context)]):null;}
export function isTransferPaused(context){return transferGuard(context)?.verdict?.state==='paused';}
export function resumeTransfer(context){
  if(!context)return;const entry=transferGuard(context);
  writeEntry(contextKey(context),entry?.test?{verdict:null,test:entry.test}:null);
}
export function clearTransferGuards(){storeEpoch++;try{localStorage.removeItem(STORE);}catch{}}
export function testIdentity(seeds,settings){
  const memories=(seeds||[]).map(v=>hashBrain(v instanceof Float32Array?v:new Float32Array(v))).join('.');
  const {mutation,conservative,generations,population,seconds}=settings;
  return `${memories}|m${mutation}|c${conservative}|g${generations}|p${population}|s${seconds}`;
}

// Keep only memories recorded under this exact context when transfer is paused.
export function applyTransferGuard(context,seeds){
  if(!Array.isArray(seeds)||!isTransferPaused(context))return {seeds,held:0};
  const kept=seeds.filter(seed=>seed.exactContext===true);
  return {seeds:kept,held:seeds.length-kept.length};
}

export async function runTransferCheck({context,track,profile,maxSpeed,traction,seconds,exploration=1,seeds,
  onProgress=()=>{},signal,spawn=()=>new Worker(new URL('./trial-worker.js',import.meta.url)),...options}){
  if(!context)throw new Error('A learning context is required');
  const {trialsPerRun,...trialOptions}={...CHECK_DEFAULTS,mutation:.22,conservative:.65,...options};
  const key=contextKey(context),identity=testIdentity(seeds,{...trialOptions,seconds});
  if(!seeds?.length)return {state:'no-memories',trials:0};
  const entry=transferGuard(context),epoch=storeEpoch;
  if(entry?.verdict?.identity===identity)return {...entry.verdict,decided:true};
  // Continue an unfinished test with the same identity; otherwise start over.
  const previous=entry?.test?.identity===identity?entry.test:null,restarted=!!(entry?.test||entry?.verdict)&&!previous;
  const memoryBetter=previous?PairedSequentialTest.fromJSON(previous.tests.memory):new PairedSequentialTest();
  const freshBetter=previous?PairedSequentialTest.fromJSON(previous.tests.fresh):new PairedSequentialTest();
  const outcomes=previous?{memory:[...previous.outcomes.memory],fresh:[...previous.outcomes.fresh]}:{memory:[],fresh:[]};
  let nextTrial=previous?previous.nextTrial:0,state='inconclusive';
  const summary=()=>({identity,trials:nextTrial,memoryWins:memoryBetter.championWins,freshWins:freshBetter.championWins,ties:memoryBetter.ties,
    evidence:{memory:memoryBetter.maxWealth,fresh:freshBetter.maxWealth},threshold:memoryBetter.threshold,restarted});
  const save=testState=>{
    if(epoch!==storeEpoch)return; // cleared while running (Start Fresh)
    const latest=transferGuard(context);
    const verdict=testState==='paused'||testState==='confirmed'?{...summary(),state:testState}:latest?.verdict||null;
    const test=verdict&&verdict.identity===identity?null:{...summary(),state:testState,nextTrial,tests:{memory:memoryBetter.toJSON(),fresh:freshBetter.toJSON()},outcomes};
    writeEntry(key,{verdict,test});
  };
  const workers=[spawn(),spawn()];
  const run=(worker,arm,armSeeds,trial)=>new Promise((resolve,reject)=>{
    const abort=()=>reject(new DOMException('Transfer check cancelled','AbortError'));
    signal?.addEventListener('abort',abort,{once:true});
    worker.onmessage=({data})=>{
      if(data?.id!==trial||data.arm!==arm)return;
      signal?.removeEventListener('abort',abort);
      data.type==='result'?resolve(data):reject(new Error(data.message||'trial failed'));};
    worker.onerror=event=>{signal?.removeEventListener('abort',abort);reject(new Error(event?.message||'trial worker failed'));};
    worker.postMessage({type:'trial',id:trial,key:`transfer-check-v3:${key}:${identity}:${trial}`,arm,track,context,profile,
      maxSpeed,traction,seconds,exploration,seeds:armSeeds,options:trialOptions});
  });
  try{
    for(let done=0;done<trialsPerRun;done++){
      if(signal?.aborted){state='cancelled';break;}
      const trial=nextTrial;
      const [memory,fresh]=await Promise.all([run(workers[0],'memory',seeds,trial),run(workers[1],'fresh',[],trial)]);
      const winner=compareOutcomes(memory,fresh);
      memoryBetter.update(winner<0,winner>0);freshBetter.update(winner>0,winner<0);
      outcomes.memory.push(memory.best);outcomes.fresh.push(fresh.best);nextTrial++;
      if(freshBetter.rejected)state='paused';else if(memoryBetter.rejected)state='confirmed';
      save(state==='inconclusive'?'running':state); // survive a closed tab
      onProgress(summary());
      if(state!=='inconclusive')break;
    }
  }catch(error){if(error?.name==='AbortError')state='cancelled';else throw error;}
  finally{for(const worker of workers)worker.terminate();}
  // A new test stopped before its first trial must not replace an unfinished one.
  if((state==='inconclusive'||state==='cancelled')&&(nextTrial>0||!entry?.test))save(state);
  const mean=list=>list.length?list.reduce((sum,v)=>sum+v,0)/list.length:null;
  // Descriptive only: the stopping rule makes a confidence interval here biased.
  return {state,...summary(),meanBest:{memory:mean(outcomes.memory),fresh:mean(outcomes.fresh)}};
}
