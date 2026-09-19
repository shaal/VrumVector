// Shared by the main-thread player and the simulation worker. Styles change
// AI decisions, never vehicle physics or the priority of a held driving key.
(function (root) {
  const profiles = Object.freeze({
    balanced: Object.freeze({id:'balanced',name:'Balanced',pace:1,corner:1,braking:0,patience:0,exploration:1,
      description:'The original learned policy. No speed or braking assistance.'}),
    calm: Object.freeze({id:'calm',name:'Calm',pace:.55,corner:.40,braking:1.15,patience:5,exploration:.75,
      description:'An easier pace, gentler direction changes, and earlier braking.'}),
    careful: Object.freeze({id:'careful',name:'Careful',pace:.42,corner:.30,braking:1.65,patience:3,exploration:.65,
      description:'Leaves more room near walls and slows down well before a corner.'}),
    wild: Object.freeze({id:'wild',name:'Wild',pace:.96,corner:.85,braking:.45,patience:1,exploration:1.2,
      description:'Keeps speed through corners, brakes late, and explores bolder policies.'}),
    reckless: Object.freeze({id:'reckless',name:'Reckless',pace:1,corner:1,braking:0,patience:0,exploration:1.5,
      description:'No braking assistance. Training favors speed in progress ties and takes bigger mutation risks.'}),
  });
  const get = id => Object.hasOwn(profiles,id)?profiles[id]:profiles.balanced;
  const unit = n => Math.max(0,Math.min(1,Number(n)||0));
  function createStats() {return {frames:0,speed:0,nearWalls:0,slides:0,turnChanges:0,lastTurn:0};}
  function apply(car, outputs) {
    const p=get(car.driverProfile);
    if(p.id==='balanced'||p.id==='reckless')return outputs;
    const out=car._styleOutputs||(car._styleOutputs=new Uint8Array(4));
    for(let i=0;i<4;i++)out[i]=outputs[i]?1:0;
    const turn=out[1]===out[2]?0:out[1]?1:-1;
    const state=car._styleSteering||(car._styleSteering={turn:0,age:99});
    state.age++;
    if(turn!==state.turn){
      // Only damp rapid opposite commands. Never hold a turn after the
      // network releases steering or when it asks for both directions.
      if(turn&&state.turn&&state.age<p.patience){out[1]=state.turn>0?1:0;out[2]=state.turn<0?1:0;}
      else {state.turn=turn;state.age=0;}
    }
    const turning=out[1]!==out[2];
    const speed=Math.max(0,car.speed||0);
    const target=car.maxSpeed*(turning?p.corner:p.pace);
    let clearance=Infinity;
    const readings=car.sensor?.readings||[],mid=Math.floor(readings.length/2);
    for(let i=Math.max(0,mid-1);i<=Math.min(readings.length-1,mid+1);i++){
      if(readings[i])clearance=Math.min(clearance,readings[i].offset*car.sensor.rayLength);
    }
    // Include the car's nose and a speed-dependent stopping distance. The
    // existing physics handles actual braking, drag, and traction.
    const stopping=car.height*.6+p.braking*speed*speed/(2*Math.max(.05,car.breakAccel+speed*.02));
    const brake=speed>target+.15||(p.braking>0&&speed>.5&&clearance<stopping);
    if(brake){out[0]=0;out[3]=1;}
    return out;
  }
  function record(car) {
    const s=car.drivingStats||(car.drivingStats=createStats());
    s.frames++;s.speed+=unit(Math.abs(car.speed)/(car.maxSpeed||1));
    if(car.slide)s.slides++;
    const readings=car.sensor?.readings||[];
    if(readings.some(r=>r&&r.offset<.15))s.nearWalls++;
    const c=car.controls,turn=c.left===c.right?0:c.left?1:-1;
    if(turn&&s.lastTurn&&turn!==s.lastTurn)s.turnChanges++;
    if(turn)s.lastTurn=turn;
  }
  function summarize(car) {
    const s=car.drivingStats||createStats(),n=Math.max(1,s.frames);
    return {averageSpeed:s.speed/n,nearWallRate:s.nearWalls/n,slideRate:s.slides/n,
      steeringChanges:s.turnChanges,smoothness:1-unit(s.turnChanges/(n/12)),aliveSeconds:s.frames/60,crashed:!!car.damaged};
  }
  function styleScore(car) {
    const p=get(car.driverProfile);if(p.id==='balanced')return 0;
    const s=summarize(car);
    if(p.id==='careful')return unit(.45*!s.crashed+.30*(1-s.nearWallRate)+.25*s.smoothness);
    if(p.id==='calm')return unit(.3*!s.crashed+.35*s.smoothness+.2*(1-s.slideRate)+.15*(1-Math.abs(s.averageSpeed-.5)));
    return unit((p.id==='reckless'?.85:.65)*s.averageSpeed+(p.id==='reckless'?.15:.35)*!s.crashed);
  }
  function rank(car,gates) {
    const progress=car.checkPointsCount+car.laps*gates;
    // Style never outweighs even one checkpoint, and standing still is not
    // rewarded for being safe. Balanced preserves the original ordering.
    return progress+(progress>0?.25*styleScore(car):0);
  }
  root.DriverProfiles=Object.freeze({profiles,get,apply,record,summarize,styleScore,rank,createStats});
})(globalThis);
