import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import init,{WasmGraphRanker} from '../vendor/ruvector/ruvector_gnn_trainable_wasm/ruvector_gnn_trainable_wasm.js';
await init({module_or_path:readFileSync(new URL('../vendor/ruvector/ruvector_gnn_trainable_wasm/ruvector_gnn_trainable_wasm_bg.wasm',import.meta.url))});
const a=new WasmGraphRanker(2,8,7),b=new WasmGraphRanker(2,8,9);
const sameSeed=new WasmGraphRanker(2,8,7);
assert.equal(sameSeed.exportCheckpoint(),a.exportCheckpoint(),'Same seed must produce identical initialization');
assert.notEqual(b.exportCheckpoint(),a.exportCheckpoint(),'Different seeds must change initial weights');
sameSeed.free();
const predict=(m,x,n)=>m.predict(new Float64Array([x,0]),JSON.stringify([[n,0]]));
const before=JSON.parse(a.exportCheckpoint());
for(let i=0;i<4000;i++){
 const x=(i%23)/11-1,n=(i%17)/8-1;
 a.train(new Float64Array([x,0]),JSON.stringify([[n,0]]),Math.tanh(.6*x+.5*n),.05);
}
assert.notDeepEqual(JSON.parse(a.exportCheckpoint()).weights,before.weights);
assert.ok(predict(a,.4,.8)>predict(a,.4,-.8),'Learned parent messages must change rankings');
b.importCheckpoint(a.exportCheckpoint());assert.equal(predict(a,.3,.2),predict(b,.3,.2));
for(const m of [a,b])m.train(new Float64Array([.3,0]),'[[0.2,0]]',.8,.05);
assert.equal(a.exportCheckpoint(),b.exportCheckpoint(),'Momentum continuation');
const saved=b.exportCheckpoint();
for(const change of [s=>s.schema=2,s=>s.weights=[],s=>s.velocity[0]=null]){
 const bad=JSON.parse(saved);change(bad);assert.throws(()=>b.importCheckpoint(JSON.stringify(bad)));assert.equal(b.exportCheckpoint(),saved);
}
assert.throws(()=>b.predict(new Float64Array([NaN,0]),'[]'));
assert.throws(()=>b.train(new Float64Array([0,0]),'[]',Infinity,.05));
a.free();b.free();console.log('Trainable GNN WASM: weights, parent influence, exact optimizer continuation, and validation passed');
