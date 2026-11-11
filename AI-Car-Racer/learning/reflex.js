// A hand-written reflex driver in the [10,16,4] brain layout (brainCodec.js,
// network.js). It steers away from the nearer wall and lifts the throttle when
// the front ray is short. Issue #62: one copy can join a cold generation 0, so
// the search starts next to a car that already drives instead of from noise.
//
// Flat layout, FLAT_LENGTH = 244:
//   [  0.. 15] hidden biases      [ 16..175] hidden weights, w[j*16+i]
//   [176..179] output biases      [180..243] output weights, w[j*4+i]
// Hidden units output tanh(sum - bias); outputs fire when sum > bias.
// Inputs: rays 0..6 read 1 - offset (high = wall close, 0 = no hit). Ray 0
// points to the side that the `left` control turns toward. Input 7 is speed,
// 8 and 9 the car-frame direction to the next gate. Outputs: 0 forward,
// 1 left, 2 right, 3 reverse.
export const REFLEX_LAYOUT=Object.freeze({inputs:10,hidden:16,outputs:4,length:244});

// Tuning, in input units, frozen before the #62 benchmark ran (a small grid
// on Rect and Tri at 20 s, every |weight| <= 16 so the shared cloud brain
// accepts it: cloud/wire.js maxWeight). Do not re-tune it against the trial
// results. The reflex's own score is sensitive to these numbers: gateSteer .5
// instead of 1 takes Rect from 10 to 3 gates, and gateGain 18 makes it lap Tri.
// side weights the left-minus-right ray difference (outer ray first).
// #70: a cold start now tunes these numbers per track (reflexTuner.js); this
// fixed tuning is the search's first candidate and its fallback.
export const REFLEX_TUNING=Object.freeze({
  side:[.5,1,1.5],     // rays 0,1,2 (left) against rays 6,5,4 (right)
  steerGain:1,         // hidden 0 = tanh(steerGain * (left - right))
  steerDeadband:.08,   // turn only when |hidden 0| clears this
  frontGain:2,         // hidden 1 = tanh(frontGain * (ray 3 + frontSide * (ray 2 + ray 4)))
  frontSide:0,
  throttleOff:.2,      // forward fires while hidden 1 + speedThrottle * hidden 3 < throttleOff
  speedThrottle:.3,
  brakeOn:.9,          // reverse fires while hidden 1 + speedBrake * hidden 3 > brakeOn
  speedBrake:0,        // hidden 3 = tanh(speed / maxSpeed)
  gateGain:16,         // hidden 2 = tanh(gateGain * lr); 0 leaves it out
  gateSteer:1,         // weight of hidden 2 on the steering outputs
});

// The generation-0 reflex seed is ON: in paired cold-start runs it cut the
// generations to the first lap on Rect and Tri (docs/plan/reflex-seed/RESULTS.md).
// Turn it off for one browser with localStorage.reflexSeed = '0'.
export const REFLEX_SEED_DEFAULT=true;
export function reflexSeedEnabled(storage){
  // Reading window.localStorage itself can throw (blocked storage).
  try{const v=(storage===undefined?globalThis.localStorage:storage)?.getItem?.('reflexSeed');if(v==='1')return true;if(v==='0')return false;}catch{}
  return REFLEX_SEED_DEFAULT;
}

// Re-injecting the reflex when progress stalls (#72) is OFF: it did not clear
// the #72 kill criterion (docs/plan/reflex-seed/REINJECT.md). Turn it on for
// one browser with localStorage.reflexReinject = '1'.
export const REFLEX_REINJECT_DEFAULT=false;
export function reflexReinjectEnabled(storage){
  try{const v=(storage===undefined?globalThis.localStorage:storage)?.getItem?.('reflexReinject');if(v==='1')return true;if(v==='0')return false;}catch{}
  return REFLEX_REINJECT_DEFAULT;
}

export function reflexBrain(tuning={}){
  const t={...REFLEX_TUNING,...tuning};
  const H=16,O=4,flat=new Float32Array(244);
  const hw=(input,hidden,v)=>{flat[16+input*H+hidden]=v;};
  const ow=(hidden,output,v)=>{flat[180+hidden*O+output]=v;};
  // Hidden 0: steering signal. Positive = the left side is closer.
  for(let k=0;k<3;k++){hw(k,0,t.steerGain*t.side[k]);hw(6-k,0,-t.steerGain*t.side[k]);}
  // Hidden 1: how close the wall ahead is.
  hw(3,1,t.frontGain);
  if(t.frontSide){hw(2,1,t.frontGain*t.frontSide);hw(4,1,t.frontGain*t.frontSide);}
  // Hidden 3: speed, so a fast car lifts and brakes earlier.
  if(t.speedThrottle||t.speedBrake)hw(7,3,1);
  // Hidden 2: optional pull toward the next gate (lr > 0 = gate to the right).
  if(t.gateGain)hw(9,2,t.gateGain);
  // Left wall close -> turn right; right wall close -> turn left.
  ow(0,2,1);ow(0,1,-1);
  if(t.gateSteer){ow(2,2,t.gateSteer);ow(2,1,-t.gateSteer);}
  flat[176+1]=t.steerDeadband;flat[176+2]=t.steerDeadband;
  // Forward while the front is open; reverse (brake) only when it is very close.
  ow(1,0,-1);flat[176+0]=-t.throttleOff;
  ow(1,3,1);flat[176+3]=t.brakeOn;
  if(t.speedThrottle)ow(3,0,-t.speedThrottle);
  if(t.speedBrake)ow(3,3,t.speedBrake);
  return flat;
}
