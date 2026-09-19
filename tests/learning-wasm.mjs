// Exercise the actual browser-target WASM in Node, including continuation.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import init, {WasmEphemeralAgent} from '../vendor/ruvector/sona/ruvector_sona.js';
await init({module_or_path:readFileSync(new URL('../vendor/ruvector/sona/ruvector_sona_bg.wasm',import.meta.url))});
const config={hidden_dim:8,embedding_dim:8,micro_lora_rank:2,base_lora_rank:4,
  micro_lora_lr:.002,base_lora_lr:.0001,ewc_lambda:1000,pattern_clusters:3,
  trajectory_capacity:100,background_interval_ms:60000,quality_threshold:.15,enable_simd:false};
const create=()=>WasmEphemeralAgent.withConfig('test',JSON.stringify(config));
const a=create(),b=create(),vector=new Float32Array([.8,.2,.4,.1,.3,.7,.5,.6]);
for(let i=0;i<24;i++)a.processTask(vector,.8);
a.forceLearn(); a.processTask(vector,.9);
const saved=a.exportCheckpoint();b.importCheckpoint(saved);
const snapA=JSON.parse(saved),snapB=JSON.parse(b.exportCheckpoint());
for(const key of ['bank','ewc','micro','grad_up','grad_down','base','pending','metrics','next_id'])assert.deepEqual(snapB[key],snapA[key],key);
assert.ok(Object.keys(snapA.bank.patterns).length>0);
assert.deepEqual(JSON.parse(b.findPatterns(vector,3)),JSON.parse(a.findPatterns(vector,3)));
for(let i=0;i<105;i++){a.processTask(vector,.7);b.processTask(vector,.7);}
assert.deepEqual(JSON.parse(a.exportCheckpoint()).micro,JSON.parse(b.exportCheckpoint()).micro);
for(const change of [s=>s.schema=99,s=>s.ewc.current_fisher=[],s=>s.grad_up[0]=null]){
 const bad=JSON.parse(saved);change(bad);const before=JSON.parse(b.exportCheckpoint());
 assert.throws(()=>b.importCheckpoint(JSON.stringify(bad)));
 assert.deepEqual(JSON.parse(b.exportCheckpoint()).micro,before.micro);
}
a.free();b.free();console.log('Real SONA WASM: exact state, pattern retrieval, optimizer continuation, and atomic rejection passed');
