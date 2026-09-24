import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {TrainingHealth,HEALTH_MODULE_URL,HEALTH_WINDOW,loadHealth,healthReady} from '../AI-Car-Racer/learning/health.js';
import {Simulation} from './helpers/simulation.mjs';
import {LearningCoach,buildPopulation} from '../AI-Car-Racer/learning/policy.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

// Initialise the same versioned module instance that loadHealth imports.
(await import(HEALTH_MODULE_URL)).initSync({module:await readFile(new URL('../vendor/ruvector/emergent_time_wasm/emergent_time_wasm_bg.wasm',import.meta.url))});
assert.equal(await loadHealth(),true);assert.ok(healthReady());

const champion=value=>new Float32Array(244).fill(value);
function run(rows){const h=new TrainingHealth();const out=rows.map(r=>h.observe(r)?.state);h.reset();return out;}
// Flat trace (no gain) where one input changes every generation.
const flat=(change)=>Array.from({length:12},(_,i)=>({best:3,genBest:3,gates:8,mutation:.22,champion:champion(.2),...change(i)}));

test('nothing is reported until a second generation exists',()=>{
  const h=new TrainingHealth();
  assert.equal(h.observe({best:2,genBest:2,gates:8,mutation:.22,champion:champion(.1)}),null);
  assert.ok(h.observe({best:2,genBest:2,gates:8,mutation:.22,champion:champion(.1)}));
});
test('steady gains read Improving on few-gate and many-gate tracks',()=>{
  for(const gates of [4,9,30]){
    // A new champion moves its weights by about 0.4 RMS; adaptive exploration
    // changes the mutation rate as it refines and explores.
    const rows=Array.from({length:18},(_,i)=>({best:2+Math.floor(i/3),genBest:2+Math.floor(i/3),gates,
      mutation:[.22,.176,.22,.275][i%4],champion:champion(Math.floor(i/3)%2?.5:.1)}));
    const states=run(rows).slice(HEALTH_WINDOW);
    assert.ok(states.every(s=>s==='Healthy'),`${gates} gates: ${states.join(' ')}`);
  }
});
test('each change input on its own turns a plateau into Plateau while exploring',()=>{
  assert.equal(run(flat(()=>({}))).at(-1),'Stuck','no change at all');
  assert.equal(run(flat(i=>({champion:champion(i%2?.5:.1)}))).at(-1),'NeedsReplan','champion weights');
  assert.equal(run(flat(i=>({mutation:i%2?.3:.22}))).at(-1),'NeedsReplan','mutation rate');
  assert.equal(run(flat(i=>({genBest:i%2?2:3}))).at(-1),'NeedsReplan','generation best falling below the previous');
});
test('a tiny gain against heavy churn is not Improving',()=>{
  // One checkpoint in a window where the champion is replaced every generation.
  const rows=Array.from({length:12},(_,i)=>({best:i===10?4:3,genBest:i===10?4:3,gates:8,mutation:.22,champion:champion(i%2?2:-2)}));
  const state=run(rows).at(-1);
  assert.notEqual(state,'Healthy',`state ${state}`);
});
test('counts generations without gain, resets, and ignores unusable rows',()=>{
  const h=new TrainingHealth();
  h.observe({best:2,genBest:2,gates:8,mutation:.2,champion:champion(.1)});
  for(let i=0;i<5;i++)h.observe({best:2,genBest:2,gates:8,mutation:.2,champion:champion(.1)});
  assert.equal(h.snapshot().sinceProgress,5);
  h.observe({best:3,genBest:3,gates:8,mutation:.2,champion:champion(.2)});assert.equal(h.snapshot().sinceProgress,0);
  const before=h.snapshot();assert.deepEqual(h.observe({best:NaN,gates:8}),before);assert.deepEqual(h.observe({best:4,gates:0}),before);
  h.reset();assert.equal(h.snapshot(),null);
});
test('real training traces match improving and plateau windows',()=>{
  const sim=new Simulation({track:'Triangle',seed:'health-test'}),coach=new LearningCoach(),random=seededRandom('health-test'),h=new TrainingHealth();
  coach.setContext({profile:'balanced',track:'Triangle',maxSpeed:15,traction:.5,seconds:4});
  const improved=[],states=[];
  for(let g=0;g<24;g++){
    const plan=coach.plan(.22,true,1),batch=buildPopulation({N:16,incumbent:coach.incumbent,plan,random});
    sim.begin(batch.flat);const r=sim.run(4);coach.record(r,r.vector);improved.push(coach.lastImproved);
    states.push(h.observe({best:coach.incumbent.fitness,genBest:r.fitness,gates:sim.road.checkPointList.length,mutation:plan.mutation,champion:coach.incumbent.vector})?.state);
  }
  for(let i=HEALTH_WINDOW;i<states.length;i++){
    const gain=improved.slice(i-HEALTH_WINDOW+1,i+1).some(Boolean);
    assert.ok(gain?states[i]==='Healthy':['Stuck','NeedsReplan'].includes(states[i]),`generation ${i}: ${states[i]}`);
  }
});
