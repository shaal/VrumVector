import {similarityFromDistance} from './similarity.js';
import {collisionsLabel} from '../learning/policy.js';

// The collision mode a crash map was archived in (car-collisions C4). Maps
// from before C4 carry no tag: normal driving, unless their cause histogram
// counts car contacts, which only collision mode has ('unknown', so they
// match no mode).
export function crashMapMode(meta){
  if(meta&&meta.collisions!=null)return collisionsLabel(meta.collisions);
  return meta&&meta.causes&&Number(meta.causes.contact)>0?'unknown':'off';
}

// One crash-map search hit as adaptive gates read it. `similarity` is cosine,
// which is what CRASH_SIM_MIN in adaptiveGates.js is compared against.
// Prefers metadata from the bridge mirror; falls back to the hit's metadata.
export function crashLayoutFromHit(hit,entry){
  const meta=(entry&&entry.meta)||hit.metadata||{};
  return {
    id:hit.id,
    similarity:similarityFromDistance(hit.score),
    distance:hit.score==null||hit.score===''?NaN:Number(hit.score),
    survival:Number(meta.survival)||0,
    fitness:Number(meta.fitness)||0,
    generation:meta.generation|0,
    nGates:meta.nGates|0,
    nDeaths:meta.nDeaths|0,
    cps:Array.isArray(meta.cps)?meta.cps:null,
    causes:meta.causes||null,
    bottleneck:meta.bottleneck!=null?(meta.bottleneck|0):null,
    geometrySig:meta.geometrySig||null,
    collisions:crashMapMode(meta),
    timestamp:meta.timestamp||0,
  };
}
