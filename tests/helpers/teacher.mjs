// Scripted teachers for behavioural-cloning tests. evolveTeacher() runs a short
// genetic run in the real simulator; drive() lets one network drive one car and
// can log, per physics step, the keys held during the step and the 10 inputs
// the car computed at its end: the dataset rows of AI-Car-Racer/learning/clone.js.
import {Simulation} from './simulation.mjs';
import {LearningCoach,buildPopulation} from '../../AI-Car-Racer/learning/policy.js';
import {seededRandom} from '../../AI-Car-Racer/graphics/state.js';

// With `delay`, every car's keys act that many steps late while it evolves, so
// the champion is a driver adapted to its own reaction time, as a person is.
export function evolveTeacher({track,seed,generations=40,population=24,seconds=20,delay=0}){
  const sim=new Simulation({track,seed}),coach=new LearningCoach(),random=seededRandom(seed);
  coach.setContext({profile:'balanced',track,maxSpeed:sim.maxSpeed,traction:.5,seconds});
  for(let g=0;g<generations;g++){
    const plan=coach.plan(.22,true,1),batch=buildPopulation({N:population,incumbent:coach.incumbent,plan,random});
    let result;
    if(delay)result=runDelayed(sim,batch.flat,seconds,delay);
    else{sim.begin(batch.flat);result=sim.run(seconds);}
    coach.record(result,result.vector);
  }
  return {sim,vector:new Float32Array(coach.incumbent.vector),fitness:coach.incumbent.fitness};
}

// One generation with delayed keys. Cars never touch each other in the
// simulator, so each one drives on its own. The first car with the most
// progress wins, as in Simulation.run with the balanced profile.
function runDelayed(sim,flat,seconds,delay){
  let best=null,alive=0;
  for(let i=0;i<flat.length/244;i++){
    const vector=flat.subarray(i*244,(i+1)*244),run=drive(sim,vector,{seconds,delay});
    if(run.crashedAt===null)alive++;
    if(!best||run.progress>best.run.progress)best={run,vector};
  }
  return {vector:new Float32Array(best.vector),fitness:best.run.progress,laps:best.run.laps,styleScore:0,
    popN:flat.length/244,popStillAlive:alive,driving:{averageSpeed:0}};
}

// One car, one network. The network's keys act `delay` steps later than
// normal (delay 0 = the game's own timing: keys chosen at the end of step t
// act during step t + 1). Stops at the step the car crashes. Like the game's
// recorder, `record` skips the idle start: steps before the car first moves.
export function drive(sim,flat,{seconds=30,start=sim.spawn,delay=0,record=false}={}){
  if(sim.profile!=='balanced')throw new Error('drive() applies raw network keys; use the balanced profile');
  const {scope,road}=sim,gates=road.checkPointList.length;
  const car=new scope.CarClass(start.x,start.y,30,50,'AI',sim.maxSpeed,start.angle);
  car.driverProfile=sim.profile;
  let at=0;
  for(const level of car.brain.levels){
    for(let j=0;j<level.biases.length;j++)level.biases[j]=flat[at++];
    for(let j=0;j<level.weights.length;j++)level.weights[j]=flat[at++];
  }
  // The harness applies the keys itself so they can be delayed.
  car.useBrain=false;
  const queue=[],inputs=[],keys=[],none=[0,0,0,0];
  let crashedAt=null,steps=0,moved=false;
  for(let f=1;f<=seconds*60;f++){
    scope.frameCount=f;
    const held=queue.length>delay?queue.shift():none;
    [car.controls.forward,car.controls.left,car.controls.right,car.controls.reverse]=held;
    car.update(road.borders,road.checkPointList);steps=f;
    moved||=car.x!==start.x||car.y!==start.y;
    if(record&&moved){keys.push(...held);inputs.push(...car.brain.levels[0].inputs);}
    queue.push(Array.from(car.brain.levels[1].outputs,v=>v?1:0));
    if(car.damaged){crashedAt=f;break;}
  }
  return {progress:car.checkPointsCount+car.laps*gates,laps:car.laps,crashedAt,steps,rows:inputs.length/10,
    final:{x:car.x,y:car.y,angle:car.angle,speed:car.speed},inputs,keys};
}

// Runs from jittered starts (run 0 starts exactly at the spawn unless
// `jitterFirst`), concatenated into one dataset with one episode id per run.
// Stops after `episodes` runs or once `rows` steps are recorded.
export function record(sim,flat,{episodes=8,rows=Infinity,seconds=30,delay=0,seed='record',position=12,angle=.12,jitterFirst=false}={}){
  const random=seededRandom(seed),runs=[];let n=0;
  for(let e=0;e<episodes&&n<rows;e++){
    const s=sim.spawn,jitter=e||jitterFirst?1:0;
    const start={x:s.x+jitter*(random()*2-1)*position,y:s.y+jitter*(random()*2-1)*position,angle:s.angle+jitter*(random()*2-1)*angle};
    const run=drive(sim,flat,{seconds,start,delay,record:true});
    runs.push(run);n+=run.rows;
  }
  const dataset={inputs:new Float32Array(n*10),keys:new Uint8Array(n*4),episode:new Uint32Array(n)};
  let row=0;
  runs.forEach((r,e)=>{dataset.inputs.set(r.inputs,row*10);dataset.keys.set(r.keys,row*4);dataset.episode.fill(e,row,row+r.rows);row+=r.rows;});
  return {dataset,runs:runs.map(({inputs,keys,...rest})=>rest)};
}
