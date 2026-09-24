// A cheap cloning dataset without the car simulator, for edge-case, worker,
// and browser tests. A random [10, 16, 4] network reacts to a random walk
// through input space; the keys it chooses at row t are held at row t + 1,
// as in the game (see AI-Car-Racer/learning/clone.js). Runs in Node and in
// the browser.
import {predict} from '../../AI-Car-Racer/learning/clone.js';
import {seededRandom} from '../../AI-Car-Racer/graphics/state.js';

export function syntheticDataset({runs=4,steps=300,seed='synthetic',never=[],always=[]}={}){
  const random=seededRandom(seed),teacher=new Float32Array(244);
  for(let i=0;i<teacher.length;i++)teacher[i]=random()*2-1;
  const n=runs*steps,inputs=new Float32Array(n*10),keys=new Uint8Array(n*4),episode=new Uint32Array(n);
  const x=new Float32Array(10),out=new Uint8Array(4);
  for(let r=0;r<runs;r++){
    for(let j=0;j<10;j++)x[j]=random();
    const held=new Uint8Array(4);
    for(const o of always)held[o]=1;
    for(let s=0;s<steps;s++){
      const t=r*steps+s;
      episode[t]=r;keys.set(held,t*4);
      for(let j=0;j<10;j++)x[j]=Math.min(1,Math.max(0,x[j]+(random()-.5)*.1));
      inputs.set(x,t*10);
      predict(teacher,x,out);held.set(out);
      for(const o of never)held[o]=0;
      for(const o of always)held[o]=1;
    }
  }
  return {inputs,keys,episode,teacher};
}
