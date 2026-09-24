import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GRAPH_DIM,graphExample,heldOut} from '../AI-Car-Racer/learning/graph-features.js';
import * as graph from '../AI-Car-Racer/gnnReranker.js';
// Initialise the same versioned module instance that loadGnn imports.
await (await import(graph.GNN_MODULE_URL)).default({module_or_path:readFileSync(new URL('../vendor/ruvector/ruvector_gnn_trainable_wasm/ruvector_gnn_trainable_wasm_bg.wasm',import.meta.url))});
await graph.loadGnn();
function context(hold){for(let i=0;;i++){const c={track:'fixture-'+i,profile:'careful',maxSpeed:15,traction:.5,seconds:6};if(heldOut(c)===hold)return c;}}
const training=context(false),evaluation=context(true);
const memory=new Map([['a',{meta:{fitness:3,generation:2,parentIds:[],learningContext:training}}],
 ['b',{meta:{fitness:28,generation:9,parentIds:['a'],learningContext:training}}]]);
const candidates=new Map([['a',.7],['b',.95]]),seeds=[{id:'a'},{id:'b'}];
test('selection-time features are immutable and graph weights learn real signed feedback',()=>{
 graph._debugReset();graph.rememberSelection(seeds,memory,candidates,training);
 const initial=graphExample('a',memory,candidates,training).node;
 memory.get('a').meta.fitness=99;
 graph.observeGraph('a',training,.6);
 assert.deepEqual(graph.serialize().replay[0].node,initial);
 memory.get('a').meta.fitness=3;
 const before=graph.serialize().model;
 for(let i=0;i<300;i++){
  graph.rememberSelection(seeds,memory,candidates,training);
  graph.observeGraph('a',training,-.7);graph.observeGraph('b',training,.7);
 }
 assert.notEqual(graph.serialize().model,before);
 const scores=graph.gnnScore(memory,candidates,training);assert.ok(scores.get('b')>scores.get('a')+.1);
 assert.equal(initial.length,GRAPH_DIM);assert.ok(graph.info().replay<=128);
});
test('held-out contexts never update model or replay and use pre-outcome predictions',()=>{
 const before=graph.serialize(),stats=graph.info();
 graph.rememberSelection(seeds,memory,candidates,evaluation,()=>.25);
 graph.observeGraph('a',evaluation,.8);graph.observeGraph('b',evaluation,-.8);
 assert.equal(graph.serialize().model,before.model);assert.deepEqual(graph.serialize().replay,before.replay);
 assert.equal(graph.info().heldOut,stats.heldOut+2);assert.ok(graph.info().modelMSE>=0);
});
test('cached selections learn each new outcome while keeping frozen parent features',()=>{
 const initial=graphExample('b',memory,candidates,training),count=graph.info().trained;
 graph.rememberSelection(seeds,memory,candidates,training);
 graph.observeGraph('b',training,.2);
 const fitness=memory.get('a').meta.fitness;
 try{
  memory.get('a').meta.fitness=999;
  for(let i=0;i<3;i++){
   graph.rememberCachedSelection(seeds);
   assert.equal(graph.observeGraph('b',training,-.4),true);
   const latest=graph.serialize().replay.at(-1);
   assert.deepEqual(latest.node,initial.node);assert.deepEqual(latest.neighbors,initial.neighbors);
  }
 }finally{memory.get('a').meta.fitness=fitness;}
 assert.equal(graph.info().trained,count+4);
});
test('complete graph checkpoint restores rankings and continued optimizer updates; corrupt saves are atomic',()=>{
 const saved=graph.serialize(),scores=[...graph.gnnScore(memory,candidates,training)];
 graph._debugReset();assert.equal(graph.deserialize(saved),true);assert.deepEqual([...graph.gnnScore(memory,candidates,training)],scores);
 graph.rememberSelection(seeds,memory,candidates,training);graph.observeGraph('a',training,.3);const continued=graph.serialize();
 graph.deserialize(saved);graph.rememberSelection(seeds,memory,candidates,training);graph.observeGraph('a',training,.3);
 assert.deepEqual(graph.serialize(),continued);
 const bad=structuredClone(saved);bad.replay[0].context=graphExample('a',memory,candidates,evaluation).context;
 assert.equal(graph.deserialize(bad),false);assert.deepEqual(graph.serialize(),continued);
 const nan=structuredClone(saved);nan.model='{}';assert.equal(graph.deserialize(nan),false);assert.deepEqual(graph.serialize(),continued);
});
