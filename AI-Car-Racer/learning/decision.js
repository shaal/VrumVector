// Paired, seeded decisions for noisy learning experiments. Runs in the browser
// and in Node benchmarks; no DOM, WASM, or crypto dependency.
//
// pairedBootstrapDecision is ported from ruvnet/ruvector
// crates/ruvector-sota-bench/harness/src/statistics.ts (MIT, ADR-306), with
// these changes: a string-seeded PRNG instead of node:crypto; a minimum of six
// independent units (this project's n >= 6 rule; ADR-306 uses 5); a strictly
// positive minimum effect so that "no difference" can never pass; optional
// cluster resampling for pairs that share a seed; and a small-sample
// expansion of the interval (see bounds()).
import {seededRandom} from '../graphics/state.js';

export const MIN_PAIRS=6;

function quantile(sorted,probability){
  return sorted[Math.min(sorted.length-1,Math.max(0,Math.floor(probability*sorted.length)))]??0;
}
// Two-sided 95% Student-t quantiles for 1..30 degrees of freedom.
const T975=[12.706,4.303,3.182,2.776,2.571,2.447,2.365,2.306,2.262,2.228,2.201,2.179,2.160,2.145,2.131,
  2.120,2.110,2.101,2.093,2.086,2.080,2.074,2.069,2.064,2.060,2.056,2.052,2.048,2.045,2.042];
function t975(df){
  if(df<=30)return T975[df-1];
  const z=1.959964;return z+(z**3+z)/(4*df); // Cornish-Fisher; about 0.003 low at df 31, less above
}
// Standard normal CDF (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7).
function phi(x){
  const t=1/(1+.3275911*Math.abs(x)/Math.SQRT2);
  const erf=1-t*(.254829592+t*(-.284496736+t*(1.421413741+t*(-1.453152027+t*1.061405429))))*Math.exp(-x*x/2);
  return x>=0?(1+erf)/2:(1-erf)/2;
}
// The plain percentile interval is too narrow for small samples. Hesterberg's
// expanded percentile interval reads the bootstrap distribution at the
// adjusted level Phi(-sqrt(n/(n-1)) * t_{n-1}) instead of 2.5%. With many tied
// deltas those quantiles collapse onto the mean, so the interval is also
// widened linearly about the mean by the same factor; each side keeps the
// wider of the two. Measured on symmetric no-effect data at n = 6: about 2-3%
// false passes for normal deltas and 1.4-1.9% for tied whole-checkpoint
// deltas, against 5-8% for the plain interval. Left-skewed nulls stay near
// 10% at n <= 10 for every method, including a t-test.
function bounds(sorted,mean,n){
  const factor=Math.sqrt(n/(n-1))*t975(n-1),level=phi(-factor);
  const widen=factor/1.959964;
  const linearLow=mean-widen*(mean-quantile(sorted,.025)),linearHigh=mean+widen*(quantile(sorted,.975)-mean);
  return [Math.min(linearLow,quantile(sorted,level)),Math.max(linearHigh,quantile(sorted,1-level))];
}

// pass: the 95% interval of the mean paired improvement lies at or above
// minimumEffect. fail: the interval lies below minimumEffect, so a gain of that
// size is ruled out ("no meaningful improvement"; exact ties give [0, 0]).
// Otherwise inconclusive. Deltas are candidate - baseline. With `clusters` (one
// id per pair), whole clusters are resampled and the minimum and the
// t-quantile use the number of clusters.
export function pairedBootstrapDecision(baseline,candidate,{minimumEffect=1e-9,samples=10000,minPairs=MIN_PAIRS,clusters=null}={}){
  if(!(minimumEffect>0))throw new RangeError('minimumEffect must be positive');
  const pairs=Array.isArray(baseline)&&Array.isArray(candidate)?Math.min(baseline.length,candidate.length):0;
  // No interval: bounds are null (JSON-safe); the mean is still reported when defined.
  const empty={meanDelta:null,lower95:null,upper95:null,outcome:'inconclusive',pairs,units:0,samples:0};
  if(!Array.isArray(baseline)||!Array.isArray(candidate)||baseline.length!==candidate.length)return {...empty,reason:'unpaired'};
  if(clusters!=null&&(!Array.isArray(clusters)||clusters.length!==pairs))return {...empty,reason:'unpaired'};
  const deltas=candidate.map((value,index)=>value-baseline[index]);
  if(!deltas.every(Number.isFinite))return {...empty,reason:'non-finite'};
  const meanDelta=pairs?deltas.reduce((sum,value)=>sum+value,0)/pairs:null;
  // Resampling units: single pairs, or all pairs of one cluster together.
  const groups=new Map();
  deltas.forEach((delta,index)=>{const key=clusters?String(clusters[index]):index;
    const g=groups.get(key)||{sum:0,count:0};g.sum+=delta;g.count++;groups.set(key,g);});
  const units=[...groups.values()];
  if(units.length<Math.max(2,minPairs))return {...empty,meanDelta,units:units.length,reason:'too-few-pairs'};
  const random=seededRandom(JSON.stringify({baseline,candidate,clusters,samples}));
  const means=new Float64Array(samples);
  for(let sample=0;sample<samples;sample++){
    let total=0,count=0;
    for(let i=0;i<units.length;i++){const u=units[Math.floor(random()*units.length)];total+=u.sum;count+=u.count;}
    means[sample]=total/count;
  }
  means.sort();
  const [lower95,upper95]=bounds(means,meanDelta,units.length);
  const outcome=lower95>=minimumEffect?'pass':upper95<minimumEffect?'fail':'inconclusive';
  return {meanDelta,lower95,upper95,outcome,pairs,units:units.length,samples};
}

// A pooled pass is vetoed when any single domain (track) shows a regression on
// its own (its whole interval is below zero): an average win must not hide a
// loss on one track. Ties ("no improvement") do not veto.
export function vetoedDecision(pooled,domains){
  const vetoes=Object.entries(domains).filter(([,d])=>d.upper95<0).map(([name])=>name);
  if(pooled.outcome==='pass'&&vetoes.length)return {...pooled,outcome:'inconclusive',reason:'vetoed',vetoes};
  return {...pooled,vetoes};
}
