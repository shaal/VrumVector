// Measures which recalled crash maps pass the adaptive-gate similarity floor
// before and after the cosine-distance fix. Real physics and the vendored
// VectorDB; each generation queries the maps archived earlier on the same track.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import vm from 'node:vm';
import initVec,{VectorDB} from '../vendor/ruvector/ruvector_wasm/ruvector_wasm.js';
import {Simulation} from '../tests/helpers/simulation.mjs';
import {LearningCoach,buildPopulation} from '../AI-Car-Racer/learning/policy.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';
import {similarityFromDistance} from '../AI-Car-Racer/archive/similarity.js';

const options=Object.fromEntries(process.argv.slice(2).map(arg=>{const [k,...v]=arg.replace(/^--/,'').split('=');return [k,v.join('=')];}));
const config={tracks:(options.tracks||'Rectangle,Triangle').split(','),seeds:Math.max(1,Number(options.seeds)||6),
  generations:Math.max(2,Number(options.generations)||15),population:Math.max(3,Number(options.population)||32),
  seconds:Math.max(1,Number(options.seconds)||8),k:5};
const output=options.output||'test-results/crash-similarity.json';
await initVec({module_or_path:await readFile(new URL('../vendor/ruvector/ruvector_wasm/ruvector_wasm_bg.wasm',import.meta.url))});
const scope=vm.createContext({});
vm.runInContext(await readFile(new URL('../AI-Car-Racer/crashMapCodec.js',import.meta.url),'utf8'),scope);
const {encodeDeathMap,CRASH_DIM}=scope.CrashMapCodec;
const gates=await readFile(new URL('../AI-Car-Racer/adaptiveGates.js',import.meta.url),'utf8');
const CRASH_SIM_MIN=Number(gates.match(/const CRASH_SIM_MIN = ([\d.]+);/)[1]);
const legacy=score=>Math.max(0,Math.min(1,1-Number(score)/2));
const quantile=(values,q)=>{const s=values.slice().sort((a,b)=>a-b);return s.length?s[Math.min(s.length-1,Math.floor(q*s.length))]:null;};

const summary=[];
for(const track of config.tracks){
  const db=new VectorDB(CRASH_DIM,'cosine');let archived=0;const hits=[];
  for(let seed=0;seed<config.seeds;seed++){
    const key=`crash-similarity-v1:${track}:${seed}`,random=seededRandom(key);
    const sim=new Simulation({track,seed:key}),coach=new LearningCoach();
    coach.setContext({profile:'balanced',track,maxSpeed:15,traction:.5,seconds:config.seconds});
    for(let generation=0;generation<config.generations;generation++){
      const batch=buildPopulation({N:config.population,incumbent:coach.incumbent,plan:coach.plan(.22,false),random});
      sim.begin(batch.flat);const result=sim.run(config.seconds);coach.record(result,result.vector);
      const xy=new Float32Array(sim.cars.length*2).fill(NaN);
      sim.cars.forEach((car,i)=>{if(car.damaged){xy[i*2]=car.x;xy[i*2+1]=car.y;}});
      const vector=encodeDeathMap(xy,sim.cars.length,3200,1800);
      if(!vector)continue;
      if(archived)for(const hit of db.search(vector,Math.min(config.k,archived)))
        hits.push({cosine:similarityFromDistance(hit.score),legacy:legacy(hit.score)});
      db.insert(vector,`${seed}:${generation}`,null);archived++;
    }
  }
  const cosines=hits.map(h=>h.cosine);
  summary.push({track,maps:archived,recalled:hits.length,
    passBefore:hits.filter(h=>h.legacy>=CRASH_SIM_MIN).length,passAfter:hits.filter(h=>h.cosine>=CRASH_SIM_MIN).length,
    cosineP10:quantile(cosines,.1),cosineMedian:quantile(cosines,.5),cosineP90:quantile(cosines,.9),
    minLegacy:hits.length?Math.min(...hits.map(h=>h.legacy)):null});
  db.free?.();
}
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify({version:1,config,threshold:CRASH_SIM_MIN,summary},null,2)+'\n');
console.table(summary);console.log(`Saved ${output}`);
