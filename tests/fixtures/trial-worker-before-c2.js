// Classic worker for transfer trials. Runs one trial arm as fast as the CPU
// allows, with full 60 Hz sensor updates (no stride), off the render path.
//
//   main -> worker { type:'trial', id, key, arm, track:{canvasW, canvasH, borders,
//                    checkPointList, startInfo}, context, profile, maxSpeed,
//                    traction, seconds, exploration, seeds:[Float32Array], options }
//   worker -> main { type:'result', id, arm, best, area, lastMean, history } | { type:'error', id, arm, message }
importScripts('../utils.js','../spatialGrid.js','../network.js','../controls.js','../sensor.js','../driver/profiles.js','../car.js');

self.frameCount=0;self.bestCar=null;self.road=null;self.traction=.5;self.invincible=false;self.SENSOR_STRIDE=1;
const FLAT_LENGTH=244;
const modules=Promise.all([import('./trial.js'),import('../graphics/state.js')]);

function buildRoad({canvasW,canvasH,borders,checkPointList}){
  const road={left:0,right:canvasW,top:0,bottom:canvasH,borders,checkPointList,
    borderGrid:new SpatialGrid(canvasW,canvasH,200),cpGrid:new SpatialGrid(canvasW,canvasH,200)};
  road.borderGrid.addSegments(borders);road.cpGrid.addSegments(checkPointList);
  return road;
}
function simulator({startInfo,maxSpeed,seconds,profile}){
  const gates=self.road.checkPointList.length;
  return flat=>{
    const cars=[];
    for(let i=0;i<flat.length/FLAT_LENGTH;i++){
      const car=new Car(startInfo.x,startInfo.y,30,50,'AI',maxSpeed,startInfo.heading||0);car.driverProfile=profile;
      let at=i*FLAT_LENGTH;
      for(const level of car.brain.levels){
        for(let j=0;j<level.biases.length;j++)level.biases[j]=flat[at++];
        for(let j=0;j<level.weights.length;j++)level.weights[j]=flat[at++];
      }
      cars.push(car);
    }
    for(let frame=1;frame<=seconds*60;frame++){
      self.frameCount=frame;
      for(const car of cars)car.update(self.road.borders,self.road.checkPointList);
    }
    let elite=cars[0],score=-Infinity;
    for(const car of cars){const rank=DriverProfiles.rank(car,gates);if(rank>score){elite=car;score=rank;}}
    const vector=new Float32Array(FLAT_LENGTH);let at=0;
    for(const level of elite.brain.levels){for(const v of level.biases)vector[at++]=v;for(const v of level.weights)vector[at++]=v;}
    const meanProgress=cars.reduce((sum,car)=>sum+car.checkPointsCount+car.laps*gates,0)/cars.length;
    return {vector,fitness:elite.checkPointsCount+elite.laps*gates,meanProgress,styleScore:DriverProfiles.styleScore(elite),
      popN:cars.length,popStillAlive:cars.filter(c=>!c.damaged).length,driving:DriverProfiles.summarize(elite)};
  };
}

self.onmessage=async({data:m})=>{
  if(m?.type!=='trial')return;
  try{
    const [{runTrialArm},{seededRandom}]=await modules;
    self.road=buildRoad(m.track);self.traction=m.traction;self.maxSpeed=m.maxSpeed;
    // Common random numbers: both arms of a trial share the population and
    // physics streams, so the only systematic difference is the seed pool.
    Math.random=seededRandom(m.key+':physics');
    const seeds=(m.seeds||[]).map((vector,i)=>({vector:new Float32Array(vector),id:'seed-'+i}));
    const result=runTrialArm({simulate:simulator({startInfo:m.track.startInfo,maxSpeed:m.maxSpeed,seconds:m.seconds,profile:m.profile}),
      context:m.context,seeds,random:seededRandom(m.key+':population'),exploration:m.exploration,...(m.options||{})});
    self.postMessage({type:'result',id:m.id,arm:m.arm,...result});
  }catch(error){self.postMessage({type:'error',id:m.id,arm:m.arm,message:String(error?.message||error)});}
};
