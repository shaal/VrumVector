// Elite re-score (issue #61, "Reflex lessons 2"). OFF by default.
//
// A generation scores each car from one start pose, and at high sim speed
// most cars skip sensor reads (SENSOR_STRIDE). So the car that wins can be a
// car that fits that one start, or that won with stale sensors. When this is
// on, endGen takes the top cars by DriverProfiles.rank and drives each again
// alone, with fresh sensors every frame (senseEveryFrame), from the canonical
// pose and from a few small jittered poses. The car with the best mean (or
// best minimum) rank over those runs becomes the elite.
//
// pool picks the candidates. 'tied' (the default): only top cars whose rank
// is exactly the plain winner's: the same progress, style score and (with the
// #60 time tie-break on) last-gate frame. The learning coach
// (learning/policy.js LearningCoach.record) compares exactly those fields, so
// it keeps or drops the crowned car exactly as it would the plain winner.
// With the balanced profile and the tie-break off, that is every car with
// the winner's progress. A winner with no progress is not re-scored: rank
// leaves style out at progress 0, but the coach still compares it. 'top': the top cars whatever their rank, as issue
// #61 wrote it. The coach keeps a new champion only when it is strictly
// better, so a 'top' crown with less progress is dropped, and the record the
// plain winner set is missed.
//
// This only evaluates under jitter. It does not train under jitter: the
// population still starts from the canonical pose. Keep the radius small, as
// full-population jitter cost the Triangle preset about 40% survival
// (main.js, window.__poseJitter).
//
// Classic script: sim-worker.js loads it with importScripts, and Node tests
// and the benchmark run it in a vm. It needs the globals Car,
// CarCollisions, DriverProfiles and a writable frameCount (car.js reads it
// for lap times).
(function(root){
    const DEFAULTS=Object.freeze({enabled:false,top:8,poses:3,radiusPx:12,angleDeg:6,maxAttempts:8,mode:'mean',pool:'tied'});
    const num=(v,d)=>v!=null&&v!==''&&Number.isFinite(+v)?+v:d;

    // null when off; otherwise a clean copy with every field in range.
    function config(o){
        if(!o||o.enabled!==true)return null;
        return {enabled:true,
            top:Math.max(1,Math.min(32,Math.round(num(o.top,DEFAULTS.top)))),
            poses:Math.max(0,Math.min(8,Math.round(num(o.poses,DEFAULTS.poses)))),
            radiusPx:Math.max(0,Math.min(60,num(o.radiusPx,DEFAULTS.radiusPx))),
            angleDeg:Math.max(0,Math.min(30,num(o.angleDeg,DEFAULTS.angleDeg))),
            maxAttempts:Math.max(1,Math.min(32,Math.round(num(o.maxAttempts,DEFAULTS.maxAttempts)))),
            mode:o.mode==='min'?'min':'mean',pool:o.pool==='top'?'top':'tied'};
    }

    // The canonical pose, then up to cfg.poses jittered poses (uniform in a
    // disk, heading within +-angleDeg). A jittered pose must be clear of the
    // walls (CarCollisions.poseClear, the same check as the spawn jitter); a
    // pose that misses maxAttempts times is left out, never replaced by a
    // copy of the canonical pose.
    function poses(road,startInfo,cfg,random){
        const a0=startInfo.heading||0,out=[{x:startInfo.x,y:startInfo.y,angle:a0}];
        let rejected=0;
        if(cfg.radiusPx>0||cfg.angleDeg>0){
            const da=cfg.angleDeg*Math.PI/180;
            for(let p=0;p<cfg.poses;p++){
                for(let att=0;att<cfg.maxAttempts;att++){
                    const r=Math.sqrt(random())*cfg.radiusPx,phi=random()*2*Math.PI;
                    const x=startInfo.x+r*Math.cos(phi),y=startInfo.y+r*Math.sin(phi),angle=a0+(random()*2-1)*da;
                    if(root.CarCollisions.poseClear(road,x,y,angle,30,50)){out.push({x,y,angle});break;}
                    rejected++;
                }
            }
        }
        return {poses:out,rejected};
    }

    // Indices of the k best cars by rank. A tie keeps the lower index, the
    // same car the plain elite scan (first strictly better) would pick.
    function topIndices(cars,gates,k){
        const scored=cars.map((c,i)=>({i,s:root.DriverProfiles.rank(c,gates),p:c.checkPointsCount+c.laps*gates}));
        scored.sort((a,b)=>b.s-a.s||a.i-b.i);
        return scored.slice(0,k);
    }

    function copyBrain(from,to){
        for(let l=0;l<from.levels.length;l++){
            to.levels[l].biases.set?to.levels[l].biases.set(from.levels[l].biases):from.levels[l].biases.forEach((v,j)=>{to.levels[l].biases[j]=v;});
            to.levels[l].weights.set?to.levels[l].weights.set(from.levels[l].weights):from.levels[l].weights.forEach((v,j)=>{to.levels[l].weights[j]=v;});
        }
    }

    // Re-scores the top cars and returns the one to crown, with what it saw.
    // Restores frameCount, which the caller reads after this.
    //   {index, changed, ranked:[{index, rank, mean, min, runs}], poses, rejected, carFrames, ms}
    // Returns null when there is nothing to re-score.
    function crown({cars,road,startInfo,maxSpeed,seconds,config:cfg,random=Math.random}){
        const gates=road&&road.checkPointList?road.checkPointList.length:0;
        if(!cfg||!cars||!cars.length||!gates||!startInfo)return null;
        const t0=(root.performance||Date).now();
        let top=topIndices(cars,gates,cfg.top);
        if(cfg.pool!=='top')top=top[0].p>0?top.filter(t=>t.p===top[0].p&&t.s===top[0].s):top.slice(0,1);
        // One candidate: nothing to compare, so no drives and no pose draws.
        if(top.length<2)return {index:top[0].i,changed:false,ranked:[{index:top[0].i,rank:top[0].s,mean:top[0].s,min:top[0].s,runs:[]}],
            poses:0,rejected:0,carFrames:0,ms:(root.performance||Date).now()-t0};
        const {poses:set,rejected}=poses(road,startInfo,cfg,random);
        const runners=[];
        for(const t of top){
            const src=cars[t.i];
            for(const p of set){
                const c=new Car(p.x,p.y,30,50,'AI',maxSpeed,p.angle);
                c.driverProfile=src.driverProfile;c.senseEveryFrame=true;copyBrain(src.brain,c.brain);
                runners.push({c,top:t});
            }
        }
        const savedFrame=root.frameCount,frames=Math.round(seconds*60);
        let carFrames=0;
        try{
            for(let f=1;f<=frames;f++){
                root.frameCount=f;let alive=0;
                for(const r of runners){if(r.c.damaged)continue;r.c.update(road.borders,road.checkPointList);carFrames++;if(!r.c.damaged)alive++;}
                if(!alive)break;
            }
        }finally{root.frameCount=savedFrame;}
        const ranked=top.map(t=>{
            const s=runners.filter(r=>r.top===t).map(r=>root.DriverProfiles.rank(r.c,gates));
            return {index:t.i,rank:t.s,mean:s.reduce((a,b)=>a+b,0)/s.length,min:Math.min(...s),runs:s};
        });
        // Best mode score; a tie keeps the higher plain rank (earlier in ranked).
        let best=ranked[0];
        for(const r of ranked)if(r[cfg.mode]>best[cfg.mode]+1e-9)best=r;
        return {index:best.index,changed:best.index!==ranked[0].index,ranked,poses:set.length,rejected,carFrames,
            ms:(root.performance||Date).now()-t0};
    }

    root.EliteRescore=Object.freeze({DEFAULTS,config,poses,topIndices,crown});
})(typeof self!=='undefined'?self:globalThis);
