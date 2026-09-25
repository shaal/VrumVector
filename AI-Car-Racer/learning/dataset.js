// The cloning dataset (plan: docs/plan/human-demonstration.md, H2).
// demonstrationDataset() turns H1's stored demonstrations
// (learning/demonstration.js) into the rows that learning/clone.js trains on:
//   inputs      Float32Array(n*10)  the 10 inputs sensed at the end of step t
//   keys        Uint8Array(n*4)     forward, left, right, reverse held in step t
//   episode     Uint32Array(n)      a new id at every gap, for every
//                                   demonstration, and for every mirrored run
//   sameSplitAs Int32Array(n)       only with mirroring: for a mirrored row, the
//                                   row it copies; -1 for the others
// What it does to the recording:
//   - Rest steps (the car parked at its start pose, up to 0.5 s before it
//     moves) get the keys that first moved the car. Unlabelled, they teach
//     "press nothing at rest", and the clone never leaves the start line.
//   - Optionally drops the last steps before each crash (`crashTrim`).
//   - Optionally adds the mirror image of every run (`mirror`).
// The trainer makes the time-block split (splitBlocks in clone.js). The
// caller picks the demonstrations (normally those of one context, H4). Pure
// logic (no DOM), so it runs in the page, a worker, and Node tests.
import {CloneError,INPUT_COUNT,HIDDEN_COUNT,KEY_COUNT,FLAT_LENGTH} from './clone.js';
import {DEMO_VERSION} from './demonstration.js';

export const DATASET_DEFAULTS=Object.freeze({
  // Rest steps: 'label' gives them the keys that first moved the car, 'drop'
  // removes them, 'keep' keeps the keys actually held (for comparisons).
  rest:'label',
  // Steps dropped before each crash. docs/validation/human-demonstration.md
  // (H2) has the measurements behind the defaults.
  crashTrim:0,
  mirror:false,
});
const REST_MODES=['label','drop','keep'];

// The mirror image of a state, as the sensors see it on a mirrored track.
// The 7 rays sweep from +spread/2 to -spread/2 (sensor.js), so they reverse.
// Speed and the forward distance to the next checkpoint stay the same; its
// sideways distance changes sign. tests/dataset.test.mjs checks this with
// the real sensors on mirrored presets.
export const MIRROR_SOURCE=Object.freeze([6,5,4,3,2,1,0,7,8,9]);
export const MIRROR_SIGN=Object.freeze([1,1,1,1,1,1,1,1,1,-1]);
// (0 - v keeps a zero positive.)
export function mirrorInputs(x,out=new Float32Array(INPUT_COUNT)){
  if(out===x)x=Float32Array.from(x);
  for(let j=0;j<INPUT_COUNT;j++){const v=x[MIRROR_SOURCE[j]];out[j]=MIRROR_SIGN[j]<0?0-v:v;}
  return out;
}
// H1's key bits (forward 1, left 2, right 4, reverse 8) with left and right swapped.
export const mirrorKeyBits=bits=>(bits&9)|(bits&2?4:0)|(bits&4?2:0);
const KEY_SOURCE=[0,2,1,3];

// The mirror image of a network in the flat layout: it presses the keys the
// original presses in the mirrored state, with left and right swapped. The
// hidden sums add the same terms in another order, so a sum that sits
// exactly on its threshold can round the other way.
export function mirrorBrain(flat){
  if(flat?.length!==FLAT_LENGTH)throw new CloneError('invalid-data',`A brain has ${FLAT_LENGTH} values.`);
  for(let k=0;k<FLAT_LENGTH;k++)if(typeof flat[k]!=='number'||!Number.isFinite(flat[k]))throw new CloneError('invalid-data',`Brain value ${k} is not a finite number.`);
  const W1=HIDDEN_COUNT,B2=W1+INPUT_COUNT*HIDDEN_COUNT,W2=B2+KEY_COUNT,out=new Float32Array(FLAT_LENGTH);
  for(let i=0;i<HIDDEN_COUNT;i++)out[i]=flat[i];
  for(let j=0;j<INPUT_COUNT;j++)for(let i=0;i<HIDDEN_COUNT;i++){
    const v=flat[W1+MIRROR_SOURCE[j]*HIDDEN_COUNT+i];out[W1+j*HIDDEN_COUNT+i]=MIRROR_SIGN[j]<0?0-v:v;
  }
  for(let o=0;o<KEY_COUNT;o++){
    out[B2+o]=flat[B2+KEY_SOURCE[o]];
    for(let i=0;i<HIDDEN_COUNT;i++)out[W2+i*KEY_COUNT+o]=flat[W2+i*KEY_COUNT+KEY_SOURCE[o]];
  }
  return out;
}

const invalid=message=>new CloneError('invalid-data',message);
const arrayLike=v=>v!=null&&typeof v!=='string'&&Number.isInteger(v.length)&&v.length>=0;
function checkOptions(o){
  if(!REST_MODES.includes(o.rest))throw new CloneError('invalid-options',`rest must be one of ${REST_MODES.join(', ')}.`);
  if(!(Number.isInteger(o.crashTrim)&&o.crashTrim>=0))throw new CloneError('invalid-options','crashTrim must be a whole number of steps, 0 or more.');
  if(typeof o.mirror!=='boolean')throw new CloneError('invalid-options','mirror must be true or false.');
}

// Checks one stored demonstration and picks its rows. Returns the kept row
// indices, their key bits (rest rows relabelled), and counts for the report.
function selectRows(demo,d,o){
  if(!demo||typeof demo!=='object')throw invalid(`Demonstration ${d} is not an object.`);
  const version=demo.version??1;
  if(!(Number.isInteger(version)&&version>=1&&version<=DEMO_VERSION))throw invalid(`Demonstration ${d} has an unknown version (${version}).`);
  const {inputs,keys,sampleSteps,rest=null,crashSteps=null}=demo;
  if(!arrayLike(inputs)||!arrayLike(keys)||!arrayLike(sampleSteps))throw invalid(`Demonstration ${d} needs inputs, keys, and sampleSteps.`);
  const n=keys.length;
  if(inputs.length!==n*INPUT_COUNT||sampleSteps.length!==n)throw invalid(`Demonstration ${d}: expected ${n*INPUT_COUNT} inputs and ${n} sampleSteps for ${n} keys.`);
  if(rest!=null&&(!arrayLike(rest)||rest.length!==n))throw invalid(`Demonstration ${d}: rest must have one value per sample.`);
  if(crashSteps!=null&&!arrayLike(crashSteps))throw invalid(`Demonstration ${d}: crashSteps must be a list of step numbers.`);
  for(let i=0;i<inputs.length;i++){
    const v=inputs[i];
    if(typeof v!=='number'||!Number.isFinite(Math.fround(v)))throw invalid(`Demonstration ${d}: input ${i} is not a finite 32-bit number.`);
  }
  const atRest=new Uint8Array(n);
  for(let i=0;i<n;i++){
    const s=sampleSteps[i],k=keys[i];
    if(!Number.isSafeInteger(s)||s<0||(i&&s<=sampleSteps[i-1]))throw invalid(`Demonstration ${d}: sampleSteps must be whole numbers that increase (sample ${i}).`);
    if(!Number.isInteger(k)||k<0||k>15)throw invalid(`Demonstration ${d}: key ${i} is not a key bitmask (0 to 15).`);
    if(rest){
      const r=rest[i];
      if(r===1||r===true)atRest[i]=1;else if(r!==0&&r!==false)throw invalid(`Demonstration ${d}: rest ${i} is not 0 or 1.`);
    }
  }
  const crashes=[];
  if(crashSteps)for(let c=0;c<crashSteps.length;c++){
    const s=crashSteps[c];
    if(!Number.isSafeInteger(s)||s<0)throw invalid(`Demonstration ${d}: crash step ${c} is not a step number.`);
    crashes.push(s);
  }
  crashes.sort((a,b)=>a-b);
  const kept=new Uint8Array(n).fill(1),bits=Uint8Array.from(keys);
  let restRows=0,restDropped=0,crashDropped=0;
  // The last `crashTrim` steps before each crash (the crash step itself is
  // never recorded).
  if(o.crashTrim>0&&crashes.length){
    let c=0;
    for(let i=0;i<n;i++){
      const s=sampleSteps[i];
      while(c<crashes.length&&crashes[c]<=s)c++;
      if(c<crashes.length&&crashes[c]-o.crashTrim<=s){kept[i]=0;crashDropped++;}
    }
  }
  // A block of rest rows must end right before the step that moved the car,
  // and that step must be kept. The recorder always stores them that way;
  // anything else (or a move dropped before a crash) drops the block.
  for(let i=0;i<n;){
    if(!atRest[i]){i++;continue;}
    let end=i+1;while(end<n&&atRest[end]&&sampleSteps[end]===sampleSteps[end-1]+1)end++;
    const moved=end<n&&!atRest[end]&&sampleSteps[end]===sampleSteps[end-1]+1&&kept[end];
    for(let r=i;r<end;r++){
      if(!kept[r])continue;
      if(!moved||o.rest==='drop'){kept[r]=0;restDropped++;}
      else{restRows++;if(o.rest==='label')bits[r]=keys[end];}
    }
    i=end;
  }
  const rows=[];for(let i=0;i<n;i++)if(kept[i])rows.push(i);
  return {rows,bits,restRows,restDropped,crashDropped,crashes:crashes.length,samples:n};
}

// Builds the trainer's dataset from one demonstration or a list of them.
// Returns {inputs, keys, episode, sameSplitAs (with mirroring), report}.
// Throws CloneError('invalid-data' | 'invalid-options').
export function demonstrationDataset(demonstrations,options={}){
  if(options!=null&&typeof options!=='object')throw new CloneError('invalid-options','Options must be an object.');
  const o={...DATASET_DEFAULTS};
  // Checked on the caller's object, so a misspelt name is caught even when
  // its value is undefined (and "__proto__" from JSON is just a name).
  for(const [key,value] of Object.entries(options||{})){
    if(!Object.hasOwn(DATASET_DEFAULTS,key))throw new CloneError('invalid-options',`Unknown option ${key}.`);
    if(value!==undefined)o[key]=value;
  }
  checkOptions(o);
  // Array.from turns holes into undefined, which is refused like any bad record.
  const list=Array.isArray(demonstrations)?Array.from(demonstrations):[demonstrations];
  const picked=list.map((demo,d)=>selectRows(demo,d,o));
  const originals=picked.reduce((sum,p)=>sum+p.rows.length,0),n=originals*(o.mirror?2:1);
  const inputs=new Float32Array(n*INPUT_COUNT),keys=new Uint8Array(n*KEY_COUNT),episode=new Uint32Array(n);
  let row=0,runs=0;
  picked.forEach((p,d)=>{
    const demo=list[d],steps=demo.sampleSteps;let previous=-1;
    for(const i of p.rows){
      if(previous<0||steps[i]!==steps[previous]+1)runs++;
      episode[row]=runs-1;previous=i;
      for(let j=0;j<INPUT_COUNT;j++)inputs[row*INPUT_COUNT+j]=demo.inputs[i*INPUT_COUNT+j];
      for(let k=0;k<KEY_COUNT;k++)keys[row*KEY_COUNT+k]=p.bits[i]>>k&1;
      row++;
    }
  });
  const dataset={inputs,keys,episode};
  if(o.mirror){
    // Each run's mirror image is a run of its own, linked row by row to the
    // run it copies, so a block and its mirror land on the same side of the split.
    const sameSplitAs=new Int32Array(n).fill(-1),x=new Float32Array(INPUT_COUNT),m=new Float32Array(INPUT_COUNT);
    for(let t=0;t<originals;t++){
      const u=originals+t;
      episode[u]=runs+episode[t];sameSplitAs[u]=t;
      for(let j=0;j<INPUT_COUNT;j++)x[j]=inputs[t*INPUT_COUNT+j];
      inputs.set(mirrorInputs(x,m),u*INPUT_COUNT);
      for(let k=0;k<KEY_COUNT;k++)keys[u*KEY_COUNT+k]=keys[t*KEY_COUNT+KEY_SOURCE[k]];
    }
    dataset.sameSplitAs=sameSplitAs;
  }
  const share=k=>{let on=0;for(let t=0;t<n;t++)on+=keys[t*KEY_COUNT+k];return n?on/n:null;};
  const total=key=>picked.reduce((sum,p)=>sum+p[key],0);
  // Rest and crash counts are of the original rows (before mirroring).
  dataset.report={demonstrations:list.length,samples:total('samples'),rows:n,originalRows:originals,mirroredRows:n-originals,
    runs:o.mirror?2*runs:runs,restRows:total('restRows'),restDropped:total('restDropped'),crashes:total('crashes'),crashDropped:total('crashDropped'),
    keyBalance:{forward:share(0),left:share(1),right:share(2),reverse:share(3)},options:{rest:o.rest,crashTrim:o.crashTrim,mirror:o.mirror}};
  return dataset;
}
