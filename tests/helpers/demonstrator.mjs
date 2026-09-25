// A scripted person for the dataset tests and benchmark (H2). A network (or a
// function of the 10 inputs that returns [forward, left, right, reverse]) drives
// the WASD car with key presses (Controls.manual, as the keyboard sets them),
// and H1's recorder (AI-Car-Racer/learning/demonstration.js) records every
// step, as in the game. Each run is a new car at a jittered start: it waits at
// rest, then the network drives until the round ends or the car crashes.
// mirroredSimulation() builds the mirror image of a preset.
import {Simulation} from './simulation.mjs';
import {DemonstrationRecorder} from '../../AI-Car-Racer/learning/demonstration.js';
import {predict} from '../../AI-Car-Racer/learning/clone.js';
import {seededRandom} from '../../AI-Car-Racer/graphics/state.js';

const NO_KEYS={forward:false,left:false,right:false,reverse:false};

// `wait`: steps at rest with no key before the network drives (a person
// looking at the track). `slips`: mistakes, {kind, every, min, max}: on average
// once every `every` steps, a mistake lasts min..max steps. kind 'swap': the
// steering goes the wrong way (left and right swapped; no steering becomes a
// random side). kind 'late': the keys held when it starts stay held (a late
// reaction).
export function demonstrate(sim,driver,{runs=40,rows=18000,seconds=15,wait=40,seed='demonstrate',position=12,angle=.12,jitterFirst=false,slips=null}={}){
  const {scope,road}=sim;
  // WASD controls listen for keys; the simulator has no page.
  if(!scope.document)Object.assign(scope,{document:new EventTarget(),window:new EventTarget(),AbortController});
  const recorder=new DemonstrationRecorder({maxSamples:rows+wait+seconds*60+1,
    environment:{state:()=>({multiplayer:false,adaptive:false,simSpeed:1,assist:false,hidden:false,focused:true}),
      signature:car=>[road.borders,road.checkPointList,car.maxSpeed,car.traction],
      snapshot:car=>({context:{profile:'balanced',track:'scripted',maxSpeed:car.maxSpeed,traction:car.traction},
        track:{checkPointList:road.checkPointList}})}});
  recorder.start();
  const random=seededRandom(seed),slipRandom=seededRandom(seed+':slips'),out=new Uint8Array(4),log=[];
  const choose=typeof driver==='function'?driver:x=>predict(driver,x,out);
  // wrong: the recorder's step numbers whose keys differ from the driver's
  // choice because of a mistake (the recorder numbers the step of frame f as f - 1).
  let frame=0,slip=0,slipSide=0,slipSteps=0,stale=NO_KEYS;const wrong=[];
  for(let e=0;e<runs&&recorder.progress().samples<rows;e++){
    const s=sim.spawn,jitter=e||jitterFirst?1:0;
    const start={x:s.x+jitter*(random()*2-1)*position,y:s.y+jitter*(random()*2-1)*position,angle:s.angle+jitter*(random()*2-1)*angle};
    const car=new scope.CarClass(start.x,start.y,30,50,'WASD',sim.maxSpeed,start.angle);
    let keys=NO_KEYS,crashedAt=null,f=0;slip=0;
    const before=recorder.progress().samples;
    for(f=1;f<=wait+seconds*60;f++){
      scope.frameCount=++frame;
      Object.assign(car.controls.manual,keys);car.controls.resolve();
      car.update(road.borders,road.checkPointList);
      recorder.step(car);
      if(car.damaged){crashedAt=f;break;}
      // The keys for the next step: the network's choice on what the car sensed.
      if(f>=wait){
        const chosen=choose(car.lastInputs);
        let next={forward:!!chosen[0],left:!!chosen[1],right:!!chosen[2],reverse:!!chosen[3]};
        if(slips){
          if(!slip&&slipRandom()<1/slips.every){slip=slips.min+Math.floor(slipRandom()*(slips.max-slips.min+1));slipSide=slipRandom()<.5?1:2;stale=keys;}
          if(slip){
            slip--;slipSteps++;
            const own=next;
            if(slips.kind==='late')next=stale;
            else next={...next,...(next.left||next.right?{left:next.right,right:next.left}:{left:slipSide===1,right:slipSide===2})};
            if(Object.keys(own).some(k=>own[k]!==next[k]))wrong.push(frame);
          }
        }
        keys=next;
      }
    }
    log.push({start,crashedAt,steps:Math.min(f,wait+seconds*60),rows:recorder.progress().samples-before,
      progress:car.checkPointsCount+car.laps*road.checkPointList.length});
    car.controls.dispose();
  }
  const demonstration=recorder.stop();
  return {demonstration,runs:log,slipSteps,wrongSteps:Uint32Array.from(wrong)};
}

// The preset with every wall and gate reflected left to right (x -> W - x on
// the 3200 x 1800 canvas), and the spawn reflected with it. A car at (x, y)
// with angle a has its mirror image at (W - x, y) with angle -a.
export function mirroredSimulation(options={}){
  const sim=new Simulation(options),road=sim.road,width=road.left+road.right;
  const reflect=p=>({x:width-p.x,y:p.y});
  road.borders=road.borders.map(segment=>segment.map(reflect));
  road.checkPointList=road.checkPointList.map(gate=>gate.map(reflect));
  road.borderGrid=new sim.scope.GridClass(road.right,road.bottom,200);road.cpGrid=new sim.scope.GridClass(road.right,road.bottom,200);
  road.borderGrid.addSegments(road.borders);road.cpGrid.addSegments(road.checkPointList);
  const s=sim.spawn;sim.spawn={x:width-s.x,y:s.y,angle:-s.angle};
  sim.mirror=pose=>({x:width-pose.x,y:pose.y,angle:-pose.angle});
  return sim;
}
