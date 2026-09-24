// Human demonstrations (plan: docs/plan/human-demonstration.md, H1).
// While recording is on, each physics step of the WASD car adds one sample:
// the 10 inputs the car's network saw at the end of the step (Car.lastInputs)
// and the four keys that moved the car in that step. The log stays unpaired:
// a trainer pairs the inputs of step t with the keys of step t + k, and uses
// `lagPairs` so that no pair spans a gap. Pure logic (no DOM), so the Node
// simulator can drive it; the IndexedDB store is at the end of this file.
export const DEMO_VERSION=1;
export const INPUT_COUNT=10;
export const STEP_HZ=60;
export const MAX_DEMONSTRATIONS=10;
export const MAX_SECONDS=300;
export const MAX_SAMPLES=MAX_SECONDS*STEP_HZ;
// Less than a second of driving is not worth a slot of the ten.
export const MIN_SAMPLES=STEP_HZ;
// A gap of more than 250 ms between two steps is a freeze: the screen stood
// still, but keys could change. (main.js also drops the time beyond 0.25 s
// per frame.) Shorter freezes are replayed as a burst of steps and kept.
export const MAX_FRAME_GAP_MS=250;
export const KEY_ORDER=['forward','left','right','reverse'];
export const keyBits=c=>(c.forward?1:0)|(c.left?2:0)|(c.right?4:0)|(c.reverse?8:0);
// One recording has one context: the walls and gates (the track key), the
// top speed, the traction, and the driving style that trials will use. The
// round length may change (Auto Train changes it); it is kept as it started.
export const sameConditions=(a,b)=>!!a&&!!b&&a.track===b.track&&a.maxSpeed===b.maxSpeed&&a.traction===b.traction&&a.profile===b.profile;
const sameValues=(a,b)=>!!a&&!!b&&a.length===b.length&&a.every((value,i)=>value===b[i]);

export class DemonstrationRecorder {
  // environment.state(): {multiplayer, adaptive, simSpeed, assist, hidden,
  //   focused}, read every step. `hidden` means the panel (and its Stop
  //   button) is not shown; `focused` means the page has the keyboard.
  // environment.now(): optional wall clock in ms, for frame gaps.
  // environment.signature(car): cheap values (the car, array identities,
  //   numbers) whose change means the context may have changed.
  // environment.snapshot(car): {context, track}, stored with the demonstration.
  constructor({environment,store=null,maxSamples=MAX_SAMPLES,minSamples=MIN_SAMPLES,onChange=null,onStart=null,onStop=null}){
    this.environment=environment;this.store=store;this.maxSamples=maxSamples;this.minSamples=minSamples;
    this.onChange=onChange;this.onStart=onStart;this.onStop=onStop;
    this.run=null;this.last=null;this.storedCount=null;
  }
  get recording(){return this.run!==null;}
  // Why recording cannot start now, or '' when it can. Adaptive gates move
  // the gates each generation, and each move would end the recording.
  blocked(){const state=this.environment.state();return state.multiplayer?'multiplayer':state.adaptive?'adaptive':'';}
  start(){
    if(this.run)return true;
    if(this.blocked())return false;
    const n=this.maxSamples;
    this.run={inputs:new Float32Array(n*INPUT_COUNT),keys:new Uint8Array(n),sampleSteps:new Uint32Array(n),crashSteps:[],
      samples:0,step:0,laps:0,checkpoints:0,crashes:0,reason:'idle',startedAt:Date.now(),
      car:null,x:0,y:0,moved:false,wasDamaged:false,lastLaps:0,lastCount:0,context:null,track:null,signature:null};
    this.last=null;
    this.onStart?.();this.changed();
    return true;
  }
  // Called once per physics step of the WASD car, right after car.update().
  // It runs inside the animation loop, so an error ends the recording, not the loop.
  step(car){
    try{this.record(car);}
    catch(error){console.warn('[demonstration] recording failed',error);if(this.run)this.stop('error');}
  }
  record(car){
    const run=this.run;if(!run||!car)return;
    const now=this.environment.now?.();
    if(Number.isFinite(now)){if(Number.isFinite(run.wall)&&now-run.wall>MAX_FRAME_GAP_MS)run.interrupted=true;run.wall=now;}
    if(run.interrupted){run.interrupted=false;run.step++;}
    const at=run.step++,state=this.environment.state();
    if(state.multiplayer){this.stop('multiplayer');return;}
    if(state.adaptive){this.stop('adaptive');return;}
    if(state.hidden){this.stop('away');return;}
    const signature=this.environment.signature(car);
    if(!sameValues(signature,run.signature)){
      const snapshot=this.environment.snapshot(car);
      // A change before the first sample loses nothing: adopt the new track.
      if(run.samples&&!sameConditions(snapshot.context,run.context)){this.stop('context');return;}
      if(!run.samples||!run.context){run.context=snapshot.context;run.track=snapshot.track;}
      run.signature=signature;
    }
    // No step moves a car further than its top speed. A longer jump (a crash
    // reset, a track load that moves the car) breaks the log like a new car.
    const jumped=Math.hypot(car.x-run.x,car.y-run.y)>car.maxSpeed+1;run.x=car.x;run.y=car.y;
    if(car!==run.car||jumped){
      // The first step of a new car is never recorded, so a lag pair can
      // never join the last state of one car to the keys of the next.
      run.car=car;run.moved=false;run.wasDamaged=!!car.damaged;run.lastLaps=car.laps;run.lastCount=car.checkPointsCount;
      this.pause('idle');return;
    }
    // Without focus the page gets no key events and releases every key, so
    // the car coasts without a choice by the person.
    let reason=state.simSpeed!==1?'speed':state.assist||car.aiDriving?'ai':car.invincible?'invincible':state.focused===false?'unfocused':'';
    const crashed=!reason&&car.damaged&&!run.wasDamaged;
    if(crashed){run.crashes++;run.crashSteps.push(at);}
    run.wasDamaged=!!car.damaged;
    if(!reason&&car.damaged)reason='damaged';
    // A car parked at its start pose (at the start, or after a crash reset)
    // has not moved yet. The idle start is not a demonstration.
    const home=car.x===car.origin.x&&car.y===car.origin.y&&car.speed===0;
    if(home)run.moved=false;else if(!car.damaged)run.moved=true;
    if(!reason&&(!run.moved||car.lastInputs?.length!==INPUT_COUNT))reason='idle';
    // Laps and checkpoints count on the steps the person drove: the recorded
    // ones and the step that crashed. A lap resets the checkpoint count to 1
    // (the start gate), and a crash reset sets it to 0. Leaving the start
    // (0 to 1) is not counted: the parked car already touches the start gate.
    const lapDelta=car.laps-run.lastLaps,countDelta=car.checkPointsCount-run.lastCount,leaving=run.lastCount===0;
    run.lastLaps=car.laps;run.lastCount=car.checkPointsCount;
    if(!reason||crashed){
      if(lapDelta>0){run.laps+=lapDelta;run.checkpoints+=lapDelta;}
      else if(countDelta>0&&!leaving)run.checkpoints+=countDelta;
    }
    if(reason){this.pause(reason);return;}
    const i=run.samples++;
    run.inputs.set(car.lastInputs,i*INPUT_COUNT);run.keys[i]=keyBits(car.controls);run.sampleSteps[i]=at;
    if(run.reason){run.reason='';this.changed();}
    if(run.samples>=this.maxSamples)this.stop('full');
  }
  pause(reason){if(this.run.reason!==reason){this.run.reason=reason;this.changed();}}
  // The simulation stopped stepping (Pause, a hidden tab), but the person
  // could still change keys. Skipping one step number keeps every lag pair
  // from spanning the wait.
  interrupt(){if(this.run)this.run.interrupted=true;}
  // For the panel while no physics steps run (for example, training paused).
  poll(){
    if(!this.run)return;const state=this.environment.state();
    if(state.multiplayer)this.stop('multiplayer');else if(state.adaptive)this.stop('adaptive');else if(state.hidden)this.stop('away');
  }
  progress(){
    const r=this.run;if(!r)return null;
    return {samples:r.samples,seconds:r.samples/STEP_HZ,laps:r.laps,checkpoints:r.checkpoints,crashes:r.crashes,reason:r.reason,steps:r.step};
  }
  // Ends the recording. Returns the demonstration, or null when it is too
  // short to keep. The store write finishes later; `last.saved` reports it.
  stop(reason='user',{closing=false}={}){
    const run=this.run;if(!run)return null;
    this.run=null;this.onStop?.();
    const n=run.samples,keep=n>=this.minSamples&&!!run.context;
    const demonstration=keep?{version:DEMO_VERSION,car:'WASD',createdAt:run.startedAt,endedAt:Date.now(),stopReason:reason,
      samples:n,seconds:n/STEP_HZ,elapsedSteps:run.step,laps:run.laps,checkpoints:run.checkpoints,crashes:run.crashes,
      crashSteps:Uint32Array.from(run.crashSteps),context:run.context,track:run.track,
      inputOrder:'7 rays (1 - offset), speed / maxSpeed, next checkpoint forward, next checkpoint right',keyOrder:KEY_ORDER,
      inputs:run.inputs.slice(0,n*INPUT_COUNT),keys:run.keys.slice(0,n),sampleSteps:run.sampleSteps.slice(0,n)}:null;
    const last=this.last={reason,samples:n,seconds:n/STEP_HZ,laps:run.laps,checkpoints:run.checkpoints,crashes:run.crashes,
      saved:keep?(this.store?'saving':false):false,tooShort:!keep,dropped:0};
    if(demonstration&&this.store){
      last.done=this.store.save(demonstration,{closing})
        .then(result=>{last.saved=true;last.dropped=result.dropped;last.count=result.count;if(Number.isFinite(result.count))this.storedCount=result.count;})
        .catch(error=>{console.warn('[demonstration] saving failed',error);last.saved='failed';})
        .finally(()=>this.changed());
    }
    this.changed();
    return demonstration;
  }
  changed(){try{this.onChange?.(this);}catch(error){console.warn('[demonstration] render failed',error);}}
}

// Indices i where (inputs of sample i, keys of sample i + k) are one step pair
// k physics steps apart, with no pause, crash, or car change between them.
export function lagPairs(demonstration,k=1){
  const steps=demonstration.sampleSteps,out=[];
  for(let i=0;i+k<steps.length;i++)if(steps[i+k]-steps[i]===k)out.push(i);
  return Uint32Array.from(out);
}

// IndexedDB, in this browser only. Keeps the newest MAX_DEMONSTRATIONS.
const DB_NAME='vv-demonstrations',DB_VERSION=1,STORE='demonstrations';
const done=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
export class DemonstrationStore {
  constructor(factory=globalThis.indexedDB,limit=MAX_DEMONSTRATIONS){this.factory=factory;this.limit=limit;this.db=null;this.connection=null;}
  open(){
    if(!this.factory)return Promise.reject(new Error('IndexedDB is unavailable'));
    return this.db||=new Promise((resolve,reject)=>{
      const request=this.factory.open(DB_NAME,DB_VERSION);
      request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'id',autoIncrement:true});};
      request.onsuccess=()=>{
        const db=request.result;this.connection=db;
        // A newer version elsewhere, or the browser clearing site data, ends this connection.
        db.onversionchange=()=>{db.close();this.forget(db);};db.onclose=()=>this.forget(db);
        resolve(db);
      };
      request.onerror=()=>reject(request.error);
    }).catch(error=>{this.db=null;throw error;});
  }
  // Runs work(db). An open connection runs it now, not after a promise tick
  // (the page may be closing). A connection that closed without an event
  // (for example, after site data was cleared) is replaced once.
  use(work){
    const connection=this.connection;let first;
    try{first=connection?work(connection):this.open().then(work);}catch(error){first=Promise.reject(error);}
    return Promise.resolve(first).catch(error=>{
      if(error?.name!=='InvalidStateError')throw error;
      const stale=connection??this.connection;this.forget(stale);stale?.close();
      return this.open().then(work);
    });
  }
  forget(db){if(!db||this.connection===db){this.connection=null;this.db=null;}}
  // One transaction adds the new demonstration and removes the oldest ones
  // over the limit, so the cap holds even with two tabs saving at once.
  // While the page closes there is no time to read: `closing` only adds and
  // commits at once, and the next prune() restores the cap.
  save(demonstration,{closing=false}={}){
    return this.use(db=>new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE),add=store.add(demonstration);let result=null;
      if(closing){add.onsuccess=()=>{result={id:add.result,dropped:0,count:null};};tx.commit?.();}
      else add.onsuccess=()=>{store.getAllKeys().onsuccess=event=>{result={...this.dropOldest(store,event.target.result),id:add.result};};};
      tx.oncomplete=()=>resolve(result);
      tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Saving was aborted'));
    }));
  }
  // Keys grow with each save, so the oldest come first.
  dropOldest(store,keys){
    const drop=keys.slice(0,Math.max(0,keys.length-this.limit));
    for(const key of drop)store.delete(key);
    return {dropped:drop.length,count:keys.length-drop.length};
  }
  // Restores the cap; resolves to {count, dropped}.
  prune(){
    return this.use(db=>new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE);let result=null;
      store.getAllKeys().onsuccess=event=>{result=this.dropOldest(store,event.target.result);};
      tx.oncomplete=()=>resolve(result);
      tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Pruning was aborted'));
    }));
  }
  list(){return this.use(db=>done(db.transaction(STORE).objectStore(STORE).getAll()));}
  count(){return this.use(db=>done(db.transaction(STORE).objectStore(STORE).count()));}
}
