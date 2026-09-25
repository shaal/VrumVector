import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {seededRandom} from '../../AI-Car-Racer/graphics/state.js';

const files=['utils.js','spatialGrid.js','network.js','controls.js','sensor.js','driver/profiles.js','car.js','collisions.js'];
const sources=await Promise.all(files.map(file=>readFile(new URL('../../AI-Car-Racer/'+file,import.meta.url),'utf8')));
const presetSource=await readFile(new URL('../../AI-Car-Racer/trackPresets.js',import.meta.url),'utf8');
const presetScope=vm.createContext({window:{}});
vm.runInContext(presetSource.slice(0,presetSource.indexOf('\n];')+3),presetScope);
export const presets=presetScope.window.TRACK_PRESETS;
export class Simulation {
  // carScript replaces car.js, e.g. with a saved copy for before/after checks.
  // collisions ({heatSize}, or true) turns on collision mode, as in the
  // workers: a start row per heat and CarCollisions.step() every step.
  constructor({track='Rectangle',seed='simulation',maxSpeed=15,traction=.5,profile='balanced',carScript=null,collisions=null}={}){
    const math=Object.create(Math);math.random=seededRandom(seed);
    this.scope=vm.createContext({Math:math,frameCount:0,bestCar:null,traction,invincible:false,SENSOR_STRIDE:1});
    sources.forEach((source,i)=>vm.runInContext(carScript!=null&&files[i]==='car.js'?carScript:source,this.scope,{filename:files[i]}));
    vm.runInContext('globalThis.CarClass=Car;globalThis.GridClass=SpatialGrid;',this.scope);
    const preset=presets.find(p=>p.name===track);if(!preset)throw Error('Unknown track '+track);
    const borders=[];
    for(const loop of [preset.points,preset.points2])for(let i=0;i<loop.length;i++)borders.push([loop[i],loop[(i+1)%loop.length]]);
    const gates=preset.checkPointListEditor;
    const road={left:0,right:3200,top:0,bottom:1800,borders,checkPointList:gates,
      borderGrid:new this.scope.GridClass(3200,1800,200),cpGrid:new this.scope.GridClass(3200,1800,200)};
    road.borderGrid.addSegments(borders);road.cpGrid.addSegments(gates);this.scope.road=road;this.road=road;
    const center=g=>({x:(g[0].x+g[1].x)/2,y:(g[0].y+g[1].y)/2});
    const a=center(gates[0]),b=center(gates[1]),dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy),offset=Math.min(20,length*.05);
    this.spawn={x:a.x-dx/length*offset,y:a.y-dy/length*offset,angle:Math.atan2(-dx,-dy)};
    this.maxSpeed=maxSpeed;this.profile=profile;this.collisions=this.scope.CarCollisions.config(collisions);this.collision=null;
  }
  begin(flat){
    this.scope.frameCount=0;this.cars=[];
    const n=flat.length/244,C=this.scope.CarCollisions;
    this.collision=this.collisions?C.generation(n,this.collisions,{x:this.spawn.x,y:this.spawn.y,heading:this.spawn.angle},this.road):null;
    for(let i=0;i<n;i++){
      const s=this.collision?C.spawnPose(this.collision.row,i,this.collision.state):this.spawn;
      const c=new this.scope.CarClass(s.x,s.y,30,50,'AI',this.maxSpeed,s.angle);c.driverProfile=this.profile;
      let at=i*244;for(const level of c.brain.levels){for(let j=0;j<level.biases.length;j++)level.biases[j]=flat[at++];for(let j=0;j<level.weights.length;j++)level.weights[j]=flat[at++];}
      this.cars.push(c);
    }
  }
  run(seconds=10){
    const collision=this.collision,C=this.scope.CarCollisions;
    for(let f=1;f<=seconds*60;f++){
      this.scope.frameCount=f;
      if(collision)C.step(this.cars,collision.state,this.road.borders,this.road.checkPointList);
      else for(const car of this.cars)car.update(this.road.borders,this.road.checkPointList);
    }
    const profiles=this.scope.DriverProfiles,gates=this.road.checkPointList.length;
    for(const car of this.cars)if(![car.x,car.y,car.angle,car.speed].every(Number.isFinite))throw Error('Non-finite car state in simulation');
    let elite=this.cars[0],score=-Infinity;
    for(const car of this.cars){const rank=profiles.rank(car,gates);if(rank>score){elite=car;score=rank;}}
    const vector=new Float32Array(244);let at=0;
    for(const level of elite.brain.levels){for(const n of level.biases)vector[at++]=n;for(const n of level.weights)vector[at++]=n;}
    return {vector,fitness:elite.checkPointsCount+elite.laps*gates,laps:elite.laps,styleScore:profiles.styleScore(elite),
      popN:this.cars.length,popStillAlive:this.cars.filter(c=>!c.damaged).length,driving:profiles.summarize(elite),
      ...(collision?{contactDeaths:this.cars.filter(c=>c.contactCrash).length}:{})};
  }
}
