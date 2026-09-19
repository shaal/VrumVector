// Supervised message passing over the lineage graph. The old untrained layer's
// normalized mean was effectively neutral; all projection and readout weights
// in this backend learn from actual descendant outcomes. Automatic mode stays
// on EMA until held-out racing evidence warrants a default change.
import {contextKey} from './learning/policy.js';
import {GRAPH_DIM,GRAPH_SCHEMA,graphExample,validExample,heldOut} from './learning/graph-features.js';
let _ready=null,_module=null,_model=null,_saved=null;
let _replay=[],_cursor=0,_pending=new Map();
const emptyStats=()=>({trained:0,heldOut:0,modelError:0,emaError:0});
let _stats=emptyStats();
const create=()=>new _module.WasmGraphRanker(GRAPH_DIM,8,20260919);
export function loadGnn(){
  if(_ready)return _ready;
  _ready=(async()=>{
    try{
      const mod=await import('../vendor/ruvector/ruvector_gnn_trainable_wasm/ruvector_gnn_trainable_wasm.js');
      await mod.default();_module=mod;_model=create();return {layer:_model,mod};
    }catch(error){console.warn('[gnn] trainable model unavailable; using EMA',error);return null;}
  })();return _ready;
}
export const isReady=()=>!!_model;
const predict=sample=>_model.predict(new Float64Array(sample.node),JSON.stringify(sample.neighbors));
export function gnnScore(memory,candidates,context){
  if(!_model||_stats.trained<8)return null;
  try{
    const scores=new Map();
    for(const id of candidates.keys()){
      const sample=graphExample(id,memory,candidates,context);if(!sample)continue;
      scores.set(id,1+.3*predict(sample));
    }
    return scores;
  }catch(error){console.warn('[gnn] scoring failed; using EMA',error);return null;}
}
// Freeze selection-time inputs. Never reconstruct them from the archive after
// a descendant outcome has changed its fitness or lineage metadata.
export function rememberSelection(seeds,memory,candidates,context,emaFor=()=>0){
  if(!_model||!context)return;
  for(const seed of seeds){
    const sample=graphExample(seed.id,memory,candidates,context);if(!sample)continue;
    const key=sample.context+'::'+seed.id;
    _pending.set(key,{...sample,prediction:predict(sample),ema:Math.max(-1,Math.min(1,emaFor(seed.id)||0))});
  }
  while(_pending.size>100)_pending.delete(_pending.keys().next().value);
}
export function observeGraph(id,context,target){
  const key=contextKey(context)+'::'+id,sample=_pending.get(key);_pending.delete(key);
  if(!_model||!sample||!Number.isFinite(target)||Math.abs(target)>1)return false;
  if(heldOut(sample.context)){
    _stats.heldOut++;_stats.modelError+=(sample.prediction-target)**2;_stats.emaError+=(sample.ema-target)**2;
    return true;
  }
  try{
    _model.train(new Float64Array(sample.node),JSON.stringify(sample.neighbors),target,.05);
    _replay.push({node:sample.node,neighbors:sample.neighbors,context:sample.context,target});
    if(_replay.length>128)_replay.shift();
    // Bounded rehearsal reduces recency bias across contexts. Held-out contexts
    // never enter this buffer, including after checkpoint import.
    for(let i=0;i<Math.min(3,_replay.length);i++){
      const r=_replay[_cursor++%_replay.length];
      _model.train(new Float64Array(r.node),JSON.stringify(r.neighbors),r.target,.05);
    }
    _cursor%=128;_stats.trained++;return true;
  }catch(error){console.warn('[gnn] training sample rejected',error);return false;}
}
export function info(){return {ready:!!_model,experimental:true,trained:_stats.trained,updates:_model?.steps()||0,
  heldOut:_stats.heldOut,modelMSE:_stats.heldOut?_stats.modelError/_stats.heldOut:null,
  emaMSE:_stats.heldOut?_stats.emaError/_stats.heldOut:null,replay:_replay.length};}
export function serialize(){
  if(!_model)return _saved;
  return {version:1,features:GRAPH_SCHEMA,model:_model.exportCheckpoint(),replay:_replay.map(s=>structuredClone(s)),cursor:_cursor,stats:{..._stats}};
}
export function deserialize(s){
  if(!s||s.version!==1||s.features!==GRAPH_SCHEMA||typeof s.model!=='string'||s.model.length>2_000_000
    ||!Array.isArray(s.replay)||s.replay.length>128||!Number.isInteger(s.cursor)||s.cursor<0||s.cursor>=128
    ||!s.replay.every(r=>validExample(r)&&!heldOut(r.context)&&Number.isFinite(r.target)&&Math.abs(r.target)<=1)
    ||!s.stats||!['trained','heldOut'].every(k=>Number.isSafeInteger(s.stats[k])&&s.stats[k]>=0)
    ||!['modelError','emaError'].every(k=>Number.isFinite(s.stats[k])&&s.stats[k]>=0&&s.stats[k]<=4*s.stats.heldOut))return false;
  let candidate;
  try{
    if(_model){candidate=create();candidate.importCheckpoint(s.model);_model.free();_model=candidate;candidate=null;}
    _saved=structuredClone(s);_replay=structuredClone(s.replay);_cursor=s.cursor;_stats={...s.stats};_pending.clear();return true;
  }catch(error){candidate?.free();console.warn('[gnn] checkpoint rejected; retaining current model',error);return false;}
}
export function _debugReset(){
  _model?.free();_model=_module?create():null;_saved=null;_replay=[];_cursor=0;_stats=emptyStats();_pending.clear();
}
