// "Use my driving" (plan: docs/plan/human-demonstration.md, H4). A clone of
// the person's recorded driving (H2's dataset, H3's trainer) joins the next
// generation's seed pool as a seed of kind 'demonstration'. Pure logic (no
// DOM), so Node tests run the same code as the page:
//   - offerKey: the offer rule. A clone seeds only the context it was
//     recorded on.
//   - cloneDataset: the cloning dataset from the recordings of one context.
//   - leavesStart: does the clone pull away from the start line?
//   - demonstrationSeed: the seed that goes into the pool.
import {cleanContext} from './policy.js';
import {demonstrationDataset} from './dataset.js';
import {CloneError} from './clone.js';

export const SEED_KIND='demonstration';
const FLAT_LENGTH=244;
// The trainer's weight decay for a clone that seeds the genetic run. Without
// it a clone's weights are far larger than evolved ones (largest weight
// 33-52 against 1), and mutation changes its keys on only 3-5% of steps
// (evolved brains: 49-62%). With 0.001, over 7 teachers per track, the
// largest weight drops to about 4 and the hidden-layer RMS to about 1.7x
// evolved, and mutation changes the keys on 8-13% of steps.
// The cost: held-out agreement drops from 98% to 92-95%, and on Rectangle
// the clone drives about 3/4 as far as its teacher (Triangle: as far).
// Provisional: H5's paired check decides whether the seed helps.
// docs/validation/human-demonstration.md (H4) has the numbers.
export const USE_WEIGHT_DECAY=.001;

// The offer rule: the same walls and gates (the track key), top speed,
// traction, driving style, and collision mode (Solid cars). A recording made
// before the recorder saved the collision mode counts as 'off'
// (cleanContext does that). The round length does not count: it sets how
// long a generation lasts, not how the car drives (Auto Train changes it, and
// H1 keeps it as the recording started). Other contexts get a clone only
// through vector memory and the transfer check. Returns null when the
// context has no track key.
export function offerKey(context){
  if(!context||typeof context!=='object')return null;
  const c=cleanContext(context);
  return c.track?JSON.stringify([c.track,c.maxSpeed,c.traction,c.profile,c.collisions]):null;
}
export const sameOffer=(a,b)=>{const key=offerKey(a);return key!==null&&key===offerKey(b);};

// The cloning dataset (H2's defaults) from the stored recordings whose
// context is `context` under the offer rule. Each recording is checked on its
// own, so one bad record is skipped instead of refusing the rest. Returns
// {dataset (null when no recording fits), used, skipped: [{id, reason}]}.
export function cloneDataset(records,context){
  const key=offerKey(context),used=[],skipped=[];
  if(key===null)return {dataset:null,used,skipped};
  for(const record of Array.isArray(records)?records:[]){
    if(!record||typeof record!=='object'||offerKey(record.context)!==key)continue;
    try{demonstrationDataset(record);used.push(record);}
    catch(error){
      if(!(error instanceof CloneError))throw error;
      skipped.push({id:record.id??null,reason:error.message});
    }
  }
  return {dataset:used.length?demonstrationDataset(used):null,used,skipped};
}

// Loads a flat 244-value vector into a car's brain (the layout of
// brainCodec.js: per level, biases then weights).
export function loadBrain(car,flat){
  let at=0;
  for(const level of car.brain.levels){
    for(let j=0;j<level.biases.length;j++)level.biases[j]=flat[at++];
    for(let j=0;j<level.weights.length;j++)level.weights[j]=flat[at++];
  }
  return car;
}

// Does the clone pull away from the start line? makeCar() returns a new AI
// car parked at the start pose, with the driving style set. The clone drives
// it for `seconds` (3 s, 180 physics steps). It leaves the start line when it
// ends up more than `distance` px (20) from where it started, in any
// direction, as H2's benchmark counts it. The caller makes sure every step
// senses (no sensor stride). Returns {leaves, moved, crashed, steps}.
export function leavesStart({makeCar,road,vector,seconds=3,distance=20}){
  if(vector?.length!==FLAT_LENGTH)throw new CloneError('invalid-data',`A brain has ${FLAT_LENGTH} values.`);
  const car=loadBrain(makeCar(),vector),x=car.x,y=car.y;
  let steps=0;
  while(steps<seconds*60&&!car.damaged){car.update(road.borders,road.checkPointList);steps++;}
  const moved=Math.hypot(car.x-x,car.y-y);
  return {leaves:Number.isFinite(moved)&&moved>distance,moved,crashed:!!car.damaged,steps};
}

// The seed pool with your driving in it (demo is the seed, or null). It leads
// the pool, so with no champion in this context it takes the protected elite
// slot. A driver loaded explicitly (forceSaved) still comes first.
export function seedPool(pool,demo,{forceSaved=false}={}){
  const out=[...(pool||[])];
  if(demo){if(forceSaved)out.push(demo);else out.unshift(demo);}
  return out;
}

// The pool entry. It has no archive id, so the genetic run keeps no parent
// link for it; buildPopulation counts its cars as 'demonstration'.
export function demonstrationSeed(vector,meta={}){
  if(vector?.length!==FLAT_LENGTH||!Array.from(vector).every(Number.isFinite))
    throw new CloneError('invalid-data',`A brain has ${FLAT_LENGTH} finite values.`);
  return {vector:Float32Array.from(vector),id:null,kind:SEED_KIND,matchLabel:'Your driving',meta:{source:SEED_KIND,...meta}};
}
