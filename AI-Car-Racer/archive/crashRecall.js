import {similarityFromDistance} from './similarity.js';

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
    timestamp:meta.timestamp||0,
  };
}
