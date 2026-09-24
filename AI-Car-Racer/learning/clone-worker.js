// Module worker for behavioural cloning (clone.js), so training never blocks
// the render thread. Start it with trainCloneInWorker() in clone.js.
//
//   main -> worker { type:'train', id, dataset:{inputs, keys, episode, sameSplitAs}, options }
//   worker -> main { type:'progress', id, phase, lag, epoch, loss }
//                | { type:'result', id, weights: Float32Array(244), report }
//                | { type:'error', id, code, message }   (code 'failed' for an unexpected error)
import {trainClone} from './clone.js';

self.onmessage=({data:m})=>{
  if(m?.type!=='train')return;
  try{
    const {weights,report}=trainClone(m.dataset,{...(m.options||{}),
      onProgress:p=>self.postMessage({type:'progress',id:m.id,...p})});
    self.postMessage({type:'result',id:m.id,weights,report},[weights.buffer]);
  }catch(error){
    self.postMessage({type:'error',id:m.id,code:error?.code||'failed',message:String(error?.message||error)});
  }
};
