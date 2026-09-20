// Real car physics, fresh child mutations, entire contexts held out. This is
// an offline retrieval experiment, not evidence of faster multiplayer laps.
import {mkdir,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {Simulation} from '../tests/helpers/simulation.mjs';
import {LearningCoach,buildPopulation,offspringFeedback,contextKey} from '../AI-Car-Racer/learning/policy.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';
import {graphFeatures,heldOut,GRAPH_DIM} from '../AI-Car-Racer/learning/graph-features.js';
import init,{WasmGraphRanker} from '../vendor/ruvector/ruvector_gnn_trainable_wasm/ruvector_gnn_trainable_wasm.js';
await init({module_or_path:readFileSync(new URL('../vendor/ruvector/ruvector_gnn_trainable_wasm/ruvector_gnn_trainable_wasm_bg.wasm',import.meta.url))});
const output=process.argv[2]||'test-results/gnn-benchmark.json';
const config={tracks:['Rectangle','Triangle','Monza'],profiles:['balanced','calm','careful','wild','reckless'],
 roots:4,pretrainGenerations:3,population:12,children:6,rounds:5,seconds:4,mutation:.22,modelSeed:20260919,epochs:30};
const rows=[];
for(const track of config.tracks)for(const profile of config.profiles){
 const context={track,profile,maxSpeed:15,traction:.5,seconds:config.seconds};
 for(let root=0;root<config.roots;root++){
  const seed=`graph-eval-v1:${track}:${root}`,random=seededRandom(seed),sim=new Simulation({track,profile,seed}),coach=new LearningCoach();
  coach.setContext(context);let parentMeta=null;
  for(let generation=0;generation<config.pretrainGenerations;generation++){
   if(coach.incumbent)parentMeta={fitness:coach.incumbent.fitness,generation:generation-1,learningContext:context};
   const batch=buildPopulation({N:config.population,incumbent:coach.incumbent,plan:coach.plan(config.mutation,false),random});
   sim.begin(batch.flat);const result=sim.run(config.seconds);coach.record(result,result.vector);
  }
  const meta={fitness:coach.incumbent.fitness,generation:config.pretrainGenerations,learningContext:context};
  const node=graphFeatures(meta,1,context),neighbors=parentMeta?[graphFeatures(parentMeta,1,context)]:[];
  for(let round=0;round<config.rounds;round++){
   const flat=new Float32Array(244*config.children);
   for(let child=0;child<config.children;child++)for(let k=0;k<244;k++){
    const original=coach.incumbent.vector[k];flat[child*244+k]=original+(random()*2-1-original)*config.mutation;
   }
   sim.begin(flat);sim.run(config.seconds);
   const gates=sim.road.checkPointList.length;
   const meanFitness=sim.cars.reduce((sum,c)=>sum+c.checkPointsCount+c.laps*gates,0)/config.children;
   const target=offspringFeedback({meanFitness,count:config.children},meta.fitness);
   rows.push({context:contextKey(context),track,profile,root,round,node,neighbors,parentFitness:meta.fitness,meanFitness,target,heldOut:heldOut(context)});
  }
 }
 console.log(`${track} / ${profile}: ${heldOut(context)?'held out':'training'} outcomes collected`);
}
const training=rows.filter(r=>!r.heldOut),evaluation=rows.filter(r=>r.heldOut);
if(!training.length||!evaluation.length)throw Error('Both train and evaluation contexts are required');
const model=new WasmGraphRanker(GRAPH_DIM,8,config.modelSeed),shuffle=seededRandom('graph-eval-training-order-v1');
for(let epoch=0;epoch<config.epochs;epoch++){
 const batch=training.slice();for(let i=batch.length-1;i>0;i--){const j=Math.floor(shuffle()*(i+1));[batch[i],batch[j]]=[batch[j],batch[i]];}
 for(const r of batch)model.train(new Float64Array(r.node),JSON.stringify(r.neighbors),r.target,.05);
}
const ema=new Map(),predictions=[];
for(const r of evaluation){
 const key=r.context+':'+r.root,baseline=ema.get(key)||0;
 const prediction=model.predict(new Float64Array(r.node),JSON.stringify(r.neighbors));
 predictions.push({...r,prediction,ema:baseline});ema.set(key,.3*r.target+.7*baseline);
}
const summarize=sample=>({samples:sample.length,modelMSE:sample.reduce((s,r)=>s+(r.prediction-r.target)**2,0)/sample.length,
 emaMSE:sample.reduce((s,r)=>s+(r.ema-r.target)**2,0)/sample.length});
const summary=summarize(predictions),byContext=[...new Set(predictions.map(r=>r.context))].map(context=>({context,...summarize(predictions.filter(r=>r.context===context))}));
const retrieval=[];
for(const context of new Set(predictions.map(r=>r.context)))for(let round=0;round<config.rounds;round++){
 const group=predictions.filter(r=>r.context===context&&r.round===round);
 const base=r=>.5+.5*Math.tanh(r.parentFitness/100);
 const best=mode=>group.slice().sort((a,b)=>base(b)*(1+.3*b[mode])-base(a)*(1+.3*a[mode]))[0];
 const graph=best('prediction'),baseline=best('ema');retrieval.push({context,round,graphFitness:graph.meanFitness,emaFitness:baseline.meanFitness});
}
summary.graphSelectedFitness=retrieval.reduce((s,r)=>s+r.graphFitness,0)/retrieval.length;
summary.emaSelectedFitness=retrieval.reduce((s,r)=>s+r.emaFitness,0)/retrieval.length;
summary.graphWins=retrieval.filter(r=>r.graphFitness>r.emaFitness).length;
summary.emaWins=retrieval.filter(r=>r.emaFitness>r.graphFitness).length;
summary.ties=retrieval.filter(r=>r.emaFitness===r.graphFitness).length;
const report={version:1,config,method:'60 Hz real sensors, collisions, checkpoints, and inherited neural networks. Train and test separated by complete track/profile/physics context before optimization. Fixed model evaluated against causal per-parent EMA (alpha .3); no held-out labels train model. Both rank identical candidates using track/parent fitness and their feedback prediction. No rendering or vector-index timing measured.',
 trainingSamples:training.length,evaluationSamples:evaluation.length,summary,byContext,retrieval,rows:predictions};
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');model.free();
console.table(byContext);console.log(JSON.stringify(summary));console.log(`Saved ${output}`);
