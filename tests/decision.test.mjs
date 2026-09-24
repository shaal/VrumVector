import test from 'node:test';
import assert from 'node:assert/strict';
import {pairedBootstrapDecision,vetoedDecision,MIN_PAIRS} from '../AI-Car-Racer/learning/decision.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const base=[3,1,4,1,5,9,2,6];
test('clear improvements pass, regressions and exact ties fail',()=>{
  const better=pairedBootstrapDecision(base,base.map((v,i)=>v+1+(i%3)*.1));
  assert.equal(better.outcome,'pass');assert.ok(better.lower95>0&&better.lower95<=better.meanDelta);
  assert.equal(pairedBootstrapDecision(base,base.map(v=>v-1)).outcome,'fail');
  const tie=pairedBootstrapDecision(base,base.slice());
  assert.equal(tie.outcome,'fail','No difference is never an improvement');assert.equal(tie.meanDelta,0);
});
test('noise without a consistent direction is inconclusive',()=>{
  const d=pairedBootstrapDecision(base,base.map((v,i)=>v+(i%2?1:-1)));
  assert.equal(d.outcome,'inconclusive');assert.ok(d.lower95<0&&d.upper95>0);
});
test('the minimum effect is respected and must be positive',()=>{
  const small=base.map((v,i)=>v+.3+(i%2?.05:-.05));
  assert.equal(pairedBootstrapDecision(base,small).outcome,'pass');
  assert.equal(pairedBootstrapDecision(base,small,{minimumEffect:.5}).outcome,'fail','A 0.3 gain rules out a 0.5 minimum');
  assert.equal(pairedBootstrapDecision(base,small,{minimumEffect:.32}).outcome,'inconclusive');
  assert.throws(()=>pairedBootstrapDecision(base,small,{minimumEffect:0}),RangeError);
});
test('too few, unpaired, or non-finite samples are inconclusive',()=>{
  const five=pairedBootstrapDecision([1,2,3,4,5],[9,9,9,9,9]);
  assert.equal(MIN_PAIRS,6);assert.equal(five.outcome,'inconclusive');assert.equal(five.reason,'too-few-pairs');
  assert.equal(five.meanDelta,6,'The observed mean is still reported');assert.equal(five.lower95,null);
  assert.equal(JSON.parse(JSON.stringify(five)).upper95,null);
  assert.equal(pairedBootstrapDecision([1,2,3,4,5,6],[1,2,3,4,5]).reason,'unpaired');
  assert.equal(pairedBootstrapDecision([1,2,3,4,5,6],[1,2,NaN,4,5,6]).reason,'non-finite');
  assert.equal(pairedBootstrapDecision(null,[1]).reason,'unpaired');
  assert.throws(()=>pairedBootstrapDecision([1],[2],{minimumEffect:-1}),RangeError,'validated before any early return');
});
test('half ties and half +1 is not enough evidence at six pairs',()=>{
  // The plain and linearly widened percentile intervals both passed this.
  const d=pairedBootstrapDecision([0,0,0,0,0,0],[1,1,1,0,0,0]);
  assert.equal(d.outcome,'inconclusive');assert.ok(d.lower95<=0);
});
test('a gain of the minimum size ruled out is a fail, with or without one regression',()=>{
  const zeros=[0,0,0,0,0,0];
  assert.equal(pairedBootstrapDecision(zeros,zeros,{minimumEffect:.25}).outcome,'fail');
  assert.equal(pairedBootstrapDecision(zeros,[0,0,0,0,0,-1],{minimumEffect:.25}).outcome,'fail');
  assert.equal(pairedBootstrapDecision(zeros,[0,0,0,0,0,-1]).outcome,'inconclusive','With a tiny minimum effect one loss is not decisive');
});
test('the small-sample expansion uses the number of clusters, not pairs',()=>{
  // Six equal clusters of five pairs: the interval must be as wide as the one
  // for the six cluster means. Using 30 pairs for the t-quantile narrows it by ~25%.
  const means=[.9,-.2,.5,1.3,.1,.7],candidate=means.flatMap((m,c)=>[m-.2,m-.1,m,m+.1,m+.2]),baseline=candidate.map(()=>0);
  const clustered=pairedBootstrapDecision(baseline,candidate,{clusters:candidate.map((_,i)=>Math.floor(i/5))});
  const direct=pairedBootstrapDecision([0,0,0,0,0,0],means);
  const ratio=(clustered.upper95-clustered.lower95)/(direct.upper95-direct.lower95);
  assert.equal(clustered.units,6);assert.ok(ratio>.9&&ratio<1.1,`width ratio ${ratio.toFixed(3)}`);
});
test('clusters are resampled whole and counted as units',()=>{
  const baseline=Array(12).fill(0),candidate=[1,1,1,1,1,1,0,1,1,1,1,1];
  const pairs=pairedBootstrapDecision(baseline,candidate);
  assert.equal(pairs.units,12);assert.equal(pairs.outcome,'pass');
  const four=pairedBootstrapDecision(baseline,candidate,{clusters:[0,0,0,1,1,1,2,2,2,3,3,3]});
  assert.equal(four.units,4);assert.equal(four.reason,'too-few-pairs','Four seeds are four units, not twelve');
  const six=pairedBootstrapDecision(baseline,candidate,{clusters:[0,0,1,1,2,2,3,3,4,4,5,5]});
  assert.equal(six.units,6);assert.equal(six.pairs,12);assert.ok(six.upper95-six.lower95>=pairs.upper95-pairs.lower95);
  assert.equal(pairedBootstrapDecision(baseline,candidate,{clusters:[0,1]}).reason,'unpaired');
});
test('decisions are deterministic for the same inputs',()=>{
  const c=base.map((v,i)=>v+(i%3)-.5);
  assert.deepEqual(pairedBootstrapDecision(base,c),pairedBootstrapDecision(base,c));
});
test('false passes stay near the nominal 2.5% at six pairs, for normal and tied deltas',()=>{
  // Seeded Monte Carlo, so this cannot flake. The plain percentile interval
  // passed about 7.5% (normal) and 5.3% (tied) of these no-effect experiments.
  const random=seededRandom('decision-calibration-v2'),normal=()=>{let u=0;while(!u)u=random();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*random());};
  const tied=()=>{const u=random();return u<.25?-1:u<.75?0:1;};
  for(const [name,noise] of [['normal',normal],['tied',tied]]){
    let passes=0;const trials=500;
    for(let t=0;t<trials;t++){
      const b=[],c=[];for(let i=0;i<6;i++){const v=Math.floor(random()*4);b.push(v);c.push(v+noise());}
      if(pairedBootstrapDecision(b,c,{samples:600}).outcome==='pass')passes++;
    }
    assert.ok(passes/trials<.045,`${name} false-pass rate ${(passes/trials*100).toFixed(1)}%`);
  }
});
test('a track with a regression vetoes a pooled pass; ties do not',()=>{
  const pass={outcome:'pass',meanDelta:.4,upper95:.9},unsure={outcome:'inconclusive',upper95:.3};
  const regression={outcome:'fail',upper95:-.2},ties={outcome:'fail',upper95:0};
  const vetoed=vetoedDecision(pass,{Rectangle:unsure,Triangle:regression});
  assert.equal(vetoed.outcome,'inconclusive');assert.deepEqual(vetoed.vetoes,['Triangle']);assert.equal(vetoed.reason,'vetoed');
  assert.equal(vetoedDecision(pass,{Rectangle:unsure,Triangle:ties}).outcome,'pass','No improvement on one track is not a regression');
  assert.equal(vetoedDecision(regression,{Rectangle:regression}).outcome,'fail');
});
