class Car{
    constructor(x,y,width,height,controlType, maxSpeed=3, angle=0){
        this.origin={x:x,y:y};
        this.x=x;
        this.y=y;
        this.width=width;
        this.height=height;
        if(controlType == "KEYS" || controlType == "WASD"){
            this.invincible=invincible;
        }
        this.lapTimes='--';

        this.velocity={x:0,y:0};
        this.speed=0;
        this.acceleration=maxSpeed/50;
        this.breakAccel=maxSpeed/60;
        this.maxSpeed=maxSpeed;
        this.friction=0.02;
        this.angle=angle;
        this.damaged=false;
        // this.driftVelocity={x:0,y:0};
        this.slideSpeed=traction*this.maxSpeed;
        this.traction = traction;
        this.slide=false;

        this.checkPointsCount = 0;
        this.checkPointsPassed = [];
        this.laps=0;

        this.controlType = controlType;
        this.useBrain=controlType=="AI";

        this.delayCounter = 0;

        if(controlType!="DUMMY"){
            this.sensor=new Sensor(this);
            // Phase A1': +2 inputs for car-local direction to the next
            // checkpoint, scaled by the canvas diagonal so magnitude encodes
            // "fraction of the longest possible straight line." Preserves the
            // distance signal that A1's unit-vector variant erased.
            this.brain=new NeuralNetwork(
                [this.sensor.rayCount+3,16,4]
            );
        }
        this.controls=new Controls(controlType);
        this.polygon=this.#createPolygon();
    }

    update(roadBorders, checkPointList){
        // Damaged AI cars contribute nothing for the rest of the generation —
        // skip sensor raycasts + NN inference entirely. At end-of-gen this is
        // usually >80% of the population, so it dominates total sim cost.
        if(this.damaged && this.controlType == "AI"){
            return;
        }
        if(!this.damaged){
            this.#move();
            this.polygon=this.#createPolygon();
            if((!this.controlType == "KEYS" && !this.controlType == "WASD") || !this.invincible){
                this.damaged=this.#assessDamage(roadBorders);
            }
            let checkPoint=this.#assessCheckpoint(checkPointList);
            if (checkPoint!=-1 && (!this.checkPointsPassed.includes(checkPoint) || checkPoint == this.checkPointsPassed[0])){
                if(!this.checkPointsPassed.includes(checkPoint)){
                    this.checkPointsCount++;
                }
                if(this.checkPointsCount >= checkPointList.length && checkPoint == this.checkPointsPassed[0]){
                    this.checkPointsCount=1;
                    this.laps++;
                    if(this.laps == 1){
                        this.lapTimes = [parseFloat((frameCount/60).toFixed(2))];
                    }
                    else if (this.laps>1){
                        this.lapTimes.push(parseFloat((frameCount/60-this.lapTimes.reduce((a, b) => a + b, 0)).toFixed(2)));
                    }
                    this.checkPointsPassed = [this.checkPointsPassed[0]];
                }
                this.checkPointsPassed.push(checkPoint);
            }
        }
        else if(this.controlType == "KEYS" || this.controlType == "WASD"){
            this.delayCounter++;
            if(this.delayCounter==40){
                this.x = this.origin.x;
                this.y = this.origin.y;
                this.angle=0;
                this.speed=0;
                this.velocity.x=0
                this.velocity.y=0;
                this.delayCounter=0;
                this.damaged=false;
                this.delayCounter=0;
                this.slide=false;
                this.checkPointsCount = 0;
                this.checkPointsPassed = [];
            }
 
        }
        if(this.sensor){
            // Perception LOD. At high simSpeed, non-privileged AI cars skip
            // sensor + NN and keep last-frame controls — they're fodder
            // anyway. bestCar + player cars always run fresh so the training
            // signal stays clean and player input feels responsive. All cars
            // still run #move() every step so simSpeed scales monotonically
            // and motion stays visually smooth — gating the whole update()
            // here made 5× per-car motion slower than 2×.
            const isPrivileged = (this === bestCar) || (this.controlType !== 'AI');
            const skipPerception = !isPrivileged
                && typeof SENSOR_STRIDE !== 'undefined'
                && SENSOR_STRIDE > 1
                && (frameCount % SENSOR_STRIDE !== 0);
            if (!skipPerception){
                this.sensor.update(roadBorders);
                var offsets=this.sensor.readings.map(
                    s=>s==null?0:1-s.offset
                );
                offsets.push(this.speed/this.maxSpeed);
                // Phase A1' — track-orientation features with MAGNITUDE preserved.
                // Project world-frame offset (car→next-cp-midpoint) into the
                // car's local (forward, right) basis, then divide by the canvas
                // diagonal. The NN sees BOTH direction AND proximity: near an
                // apex the magnitude shrinks, so the "drive toward the CP"
                // shortcut is self-damping precisely when the straight line
                // would crash a wall. The A1 unit-vector variant erased that
                // distance cue; see docs/plan/ruvector-proof/arch-a1/PROOF.md.
                const cpList = checkPointList;
                let lf = 0, lr = 0;

                // When pureLocalSensors is active, we deliberately give the brain
                // ZERO information about where the next checkpoint is.
                // This is the "embodied local signals only" mode for comparison.
                // Guard works in both main thread (window) and Web Worker (self).
                const isPureLocal = (typeof window !== 'undefined' && window.pureLocalSensors) ||
                                    (typeof self !== 'undefined' && self.pureLocalSensors);
                if (!isPureLocal && cpList && cpList.length){
                    const passed = this.checkPointsPassed;
                    const nextIdx = passed.length === 0
                        ? 0
                        : (passed[passed.length - 1] + 1) % cpList.length;
                    const cp = cpList[nextIdx];
                    if (cp && cp.length >= 2){
                        const mx = (cp[0].x + cp[1].x) * 0.5;
                        const my = (cp[0].y + cp[1].y) * 0.5;
                        const dx = mx - this.x;
                        const dy = my - this.y;
                        const s = Math.sin(this.angle), c = Math.cos(this.angle);
                        const lfRaw = dx * s + dy * c;
                        const lrRaw = dx * c - dy * s;
                        // Canvas diagonal as track-invariant scale.
                        const W = (typeof road !== 'undefined' && road && road.right) ? (road.right - road.left) : 3200;
                        const H = (typeof road !== 'undefined' && road && road.bottom) ? (road.bottom - road.top) : 1800;
                        const D = Math.hypot(W, H);
                        lf = lfRaw / D;
                        lr = lrRaw / D;
                    }
                }
                offsets.push(lf);
                offsets.push(lr);
                const outputs=NeuralNetwork.feedForward(offsets,this.brain);
                if(this.useBrain){
                    this.controls.forward=outputs[0];
                    this.controls.left=outputs[1];
                    this.controls.right=outputs[2];
                    this.controls.reverse=outputs[3];
                }
            }
        }
    }
    #assessDamage(roadBoarders){
        // Broad-phase: only test borders whose AABB overlaps the car polygon's
        // AABB. Car polygon is tiny (~30×50px) so this typically reduces the
        // candidate set to 1-2 borders out of dozens.
        const grid = (typeof road !== 'undefined' && road && road.borderGrid) ? road.borderGrid : null;
        if (grid){
            const ids = grid.queryPolygon(this.polygon);
            for (let k = 0; k < ids.length; k++){
                const b = roadBoarders[ids[k]];
                if (b && polysIntersect(this.polygon, b)) return true;
            }
            return false;
        }
        for(let i=0; i<roadBoarders.length;i++){
            if(polysIntersect(this.polygon,roadBoarders[i])){
                return true;
            }
        }
        return false;
    }
    #assessCheckpoint(checkpoints){
        const grid = (typeof road !== 'undefined' && road && road.cpGrid) ? road.cpGrid : null;
        if (grid){
            const ids = grid.queryPolygon(this.polygon);
            for (let k = 0; k < ids.length; k++){
                const idx = ids[k];
                if (idx < checkpoints.length && polysIntersect(this.polygon, checkpoints[idx])){
                    return idx;
                }
            }
            return -1;
        }
        for(let i=0; i<checkpoints.length;i++){
            if(polysIntersect(this.polygon,checkpoints[i])){
                return i;
            }
        }
        return -1;
    }

    #createPolygon(){
        // Long isoceles triangle with the tip pointing in the car's forward
        // direction. Matches the motion convention in update():
        //   velocity.x += sin(angle);  velocity.y += cos(angle)
        // so the "forward" unit vector is (sin, cos). The perpendicular used
        // for the base width is (cos, -sin) — i.e. 90° clockwise from forward.
        //
        // Length uses the full car height (tip is h/2 ahead of centre, base
        // is h/2 behind), base width uses car width. polysIntersect iterates
        // polygon edges via `(i+1)%poly.length`, so a 3-vertex polygon works
        // everywhere the previous 4-vertex rectangle did.
        const halfLen = this.height / 2;
        const halfWid = this.width / 2;
        const fx = Math.sin(this.angle);   // forward x
        const fy = Math.cos(this.angle);   // forward y
        const rx = Math.cos(this.angle);   // right x (perp to forward)
        const ry = -Math.sin(this.angle);  // right y
        return [
            // tip — forward-most point
            { x: this.x + fx * halfLen,              y: this.y + fy * halfLen              },
            // back-right corner
            { x: this.x - fx * halfLen + rx * halfWid, y: this.y - fy * halfLen + ry * halfWid },
            // back-left corner
            { x: this.x - fx * halfLen - rx * halfWid, y: this.y - fy * halfLen - ry * halfWid },
        ];
    }
    
    #move(){
        //handle acceleration and breaking
        if(this.controls.forward){
            this.speed+=this.acceleration;
            this.velocity.x+=Math.sin(this.angle)*(this.acceleration);
            this.velocity.y+=Math.cos(this.angle)*(this.acceleration);
        }
        if(this.controls.reverse && (!this.slide || this.speed>.5)){
            this.speed-=this.breakAccel;
            this.velocity.x-=Math.sin(this.angle)*(this.breakAccel);
            this.velocity.y-=Math.cos(this.angle)*(this.breakAccel);
        }
        //turning
        if(this.speed!=0){
            const flip=this.speed>0?1:-1;
            if(this.controls.left){
                if(Math.abs(this.speed) > this.slideSpeed){
                    this.slide = true;
                }
                this.angle+=0.03*flip;
            }
            if(this.controls.right){
                if(Math.abs(this.speed) > this.slideSpeed){
                    this.slide = true;
                }
                this.angle-=0.03*flip;
            }
        }
        //topSpeed
        if(Math.hypot(this.velocity.x,this.velocity.y)>this.maxSpeed){
            const scalar = this.maxSpeed/Math.hypot(this.velocity.x,this.velocity.y);
            this.velocity.x*=scalar;
            this.velocity.y*=scalar;
            this.speed=this.maxSpeed;
        }
        else if (this.speed < -this.maxSpeed/2){
            const scalar=(this.maxSpeed/2)/Math.hypot(this.velocity.x,this.velocity.y);
            this.speed=-this.maxSpeed/2;
            this.velocity.x*=scalar;
            this.velocity.y*=scalar;
        }

        //what to do if sliding or not
        if(this.slide){
            this.velocity.x = lerp(this.velocity.x, this.speed*Math.sin(this.angle), (this.traction/2+.5)*this.maxSpeed/(Math.abs(this.speed)+.001)*.02);
            this.velocity.y = lerp(this.velocity.y, this.speed*Math.cos(this.angle), (this.traction/2+.5)*this.maxSpeed/(Math.abs(this.speed)+.001)*.02);
            const scalar=Math.abs(this.speed)/Math.hypot(this.velocity.x,this.velocity.y);
            this.velocity.x*=scalar;
            this.velocity.y*=scalar;
        }
        else{
            this.velocity.x=this.speed*Math.sin(this.angle);
            this.velocity.y=this.speed*Math.cos(this.angle);
        }
        //end  sliding when not steering, especially breaking
        if(!this.controls.left && !this.controls.right && this.speed < .9*this.slideSpeed){
            this.slide=false;
        }
        //end sliding for close enough angle
        if(this.slide && Math.abs(Math.abs(this.velocity.x)-this.speed*Math.sin(this.angle))<.02 && Math.abs(Math.abs(this.velocity.y)-this.speed*Math.sin(this.angle))<.02){
            this.slide=false;
        }
        
        //friction when sliding vs windAccel when not
        if(this.slide && Math.hypot(this.velocity.x,this.velocity.y)!=0){
            const scalar = Math.abs(this.speed)/Math.hypot(this.velocity.x,this.velocity.y);
            this.velocity.x*=scalar;
            this.velocity.y*=scalar;
        }
        else if (this.speed!=0){
            const windAccel = .001*(this.speed*Math.sin(this.angle)*this.velocity.x+this.speed*Math.cos(this.angle)*this.velocity.y);
            this.speed-=Math.sign(this.speed)*windAccel;
            this.velocity.x-=windAccel*Math.sin(this.angle);
            this.velocity.y-=windAccel*Math.cos(this.angle);

        }
        //too slow
        if(Math.abs(this.speed)>this.acceleration/2 && this.speed>0){
            this.velocity.x*=1-this.friction;
            this.velocity.y*=1-this.friction;
            this.speed*=1-this.friction;
        }
        else if (this.speed>0){
            this.velocity.x = 0;
            this.velocity.y = 0;
            this.speed=0;
        }


        this.x-=this.velocity.x;
        this.y-=this.velocity.y;
     
    }

    draw(ctx,color,drawSensor=false){
        let tempAlpha = ctx.globalAlpha;
        if(this.damaged){
            ctx.fillStyle="gray";
        }
        else if (this.controlType == "KEYS" || this.controlType=="WASD"){
            ctx.globalAlpha=1;
            ctx.fillStyle=color;
            // ctx.fillStyle="red";
        }
        // else if (this.controlType == "WASD"){
        //     ctx.globalAlpha=1;
        //     ctx.fillStyle="#d38b4b";
        // }
        else {
            ctx.fillStyle=color;
        }
        ctx.beginPath();
        ctx.moveTo(this.polygon[0].x,this.polygon[0].y);
        for(let i=1;i<this.polygon.length;i++){
            ctx.lineTo(this.polygon[i].x,this.polygon[i].y);
        }
        ctx.fill();
        ctx.globalAlpha=tempAlpha;
        if(this.sensor && drawSensor && this.controlType != "KEYS" && this.controlType != "WASD"){
            this.sensor.draw(ctx);
        }
    }
}