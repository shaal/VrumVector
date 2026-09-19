import {cleanContext,contextKey,matchContext} from './policy.js';
export const GRAPH_DIM=14;
export const GRAPH_SCHEMA='lineage-context-v1';
const profiles=['balanced','calm','careful','wild','reckless'];
const bound=x=>Math.max(-1,Math.min(1,Number(x)||0));
export function hashText(text){let h=2166136261;for(const c of String(text))h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;}
// Entire track/style/vehicle contexts are reserved, never replayed for training.
export const heldOut=context=>hashText(typeof context==='string'?context:contextKey(context))%5===0;
export function graphFeatures(meta,similarity,context){
  const c=cleanContext(context||{}),m=meta||{};
  return [Math.tanh((Number(m.fitness)||0)/30),Math.tanh((Number(m.generation)||0)/100),bound(similarity),
    matchContext(m,c).exact?1:0,...profiles.map(p=>c.profile===p?1:0),bound(c.maxSpeed/20),bound(c.traction),
    Math.tanh(c.seconds/30),hashText(c.track)/2147483647.5-1,hashText(c.track+':shape')/2147483647.5-1];
}
export function graphExample(id,memory,candidates,context){
  const entry=memory.get(id);if(!entry)return null;
  const parents=Array.isArray(entry.meta?.parentIds)?entry.meta.parentIds:[];
  return {node:graphFeatures(entry.meta,candidates.get(id)||0,context),
    neighbors:parents.slice(0,16).filter(pid=>pid!==id&&memory.has(pid)).map(pid=>
      graphFeatures(memory.get(pid).meta,candidates.get(pid)||0,context)),context:contextKey(context||{})};
}
export function validExample(sample){
  const valid=v=>Array.isArray(v)&&v.length===GRAPH_DIM&&v.every(x=>Number.isFinite(x)&&Math.abs(x)<=1);
  return sample&&typeof sample.context==='string'&&sample.context.length<=2048&&valid(sample.node)
    &&Array.isArray(sample.neighbors)&&sample.neighbors.length<=16&&sample.neighbors.every(valid);
}
