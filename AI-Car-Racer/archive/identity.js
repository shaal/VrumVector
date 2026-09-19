import {hashBrain} from './hash.js';

// The vendored VectorDB's automatic counter is not advanced by hydrating
// explicit legacy IDs. Allocate against the mirror to avoid overwriting them.
export function allocateVectorId(prefix,vector,mirror){
  const base=`${prefix}_${hashBrain(vector)}${hashBrain(vector,0x9e3779b9)}`;
  let id=base,suffix=0;
  while(mirror.has(id))id=`${base}_${++suffix}`;
  return id;
}
// Hash-only equality is insufficient for archive identity. Exact comparison
// also recognizes vectors restored under older sequential or fixture IDs.
export function findIdenticalVector(mirror,vector){
  for(const [id,entry] of mirror){
    const candidate=entry.vector;
    if(candidate?.length===vector.length&&candidate.every((v,i)=>v===vector[i]))return id;
  }
  return null;
}
