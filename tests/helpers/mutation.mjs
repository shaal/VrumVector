// How much the genetic algorithm's own mutation changes a network's keys
// (H4). The live mutation (learning/policy.js buildPopulation) sets each
// weight to w(1 - a) + a·u, with u random in [-1, 1]; at the default rate
// 0.22, odd slots use a = 0.11 ("light") and even slots a = 0.396 ("heavy").
// For one population of `population` cars seeded with the network, this
// returns the share of the given input rows on which a mutated car presses
// other keys than the network: all mutated cars, and the light and heavy ones
// on their own.
import {buildPopulation} from '../../AI-Car-Racer/learning/policy.js';
import {predict} from '../../AI-Car-Racer/learning/clone.js';
import {seededRandom} from '../../AI-Car-Racer/graphics/state.js';

export function mutationEffect(vector,inputs,{mutation=.22,population=24,seed='mutation-effect',every=1}={}){
  const x=new Float32Array(10),a=new Uint8Array(4),b=new Uint8Array(4),rows=[];
  for(let t=0;t<inputs.length/10;t+=every)rows.push(t);
  const keys=rows.map(t=>{x.set(inputs.subarray(t*10,t*10+10));predict(vector,x,a);return a[0]|a[1]<<1|a[2]<<2|a[3]<<3;});
  const batch=buildPopulation({N:population,seeds:[{vector}],plan:{mutation,novel:.1,round:1,stagnant:0},random:seededRandom(seed)});
  const light=[],heavy=[];
  for(let i=0;i<population;i++){
    if(batch.kinds[i]!=='mutation')continue;
    const mutated=batch.flat.subarray(i*244,(i+1)*244);let changed=0;
    rows.forEach((t,r)=>{x.set(inputs.subarray(t*10,t*10+10));predict(mutated,x,b);if((b[0]|b[1]<<1|b[2]<<2|b[3]<<3)!==keys[r])changed++;});
    (i%2?light:heavy).push(changed/rows.length);
  }
  const mean=list=>list.reduce((s,v)=>s+v,0)/list.length;
  return {all:mean([...light,...heavy]),light:mean(light),heavy:mean(heavy),cars:light.length+heavy.length,rows:rows.length};
}

// Weight size: root mean square of each layer (biases and weights) and the
// largest absolute value, in the flat layout of brainCodec.js.
export function weightSize(vector){
  const rms=(from,to)=>{let s=0;for(let k=from;k<to;k++)s+=vector[k]*vector[k];return Math.sqrt(s/(to-from));};
  let max=0;for(const v of vector)max=Math.max(max,Math.abs(v));
  return {hidden:rms(0,176),output:rms(176,244),max};
}
