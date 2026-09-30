class Sensor{
    constructor(car){
        this.car=car;
        this.rayCount=7;
        this.rayLength=400;
        this.raySpread=Math.PI/1.5;

        this.rays=[];
        this.readings=[];
    }

    update(roadBorders){
        this.#castRays();
        this.readings=[];
        for(let i=0;i<this.rays.length;i++){
            this.readings.push(
                this.#getReading(this.rays[i],roadBorders)
            );
        }
    }

    #getReading(ray,roadBorders){
        // Track the nearest intersection inline rather than collecting all
        // touches + `Math.min(...offsets)`. The spread was allocating an array
        // per query — painful at cars×rays×stepsPerFrame.
        let best = null;
        let bestOffset = Infinity;
        // Broad-phase cull: if the grid is built, only test borders whose AABB
        // overlaps the ray's AABB. Falls back to full scan when the grid isn't
        // available yet (e.g. pre-track phases).
        const grid = (typeof road !== 'undefined' && road && road.borderGrid) ? road.borderGrid : null;
        if (grid){
            const ids = grid.queryRay(ray[0], ray[1]);
            for (let k = 0; k < ids.length; k++){
                const b = roadBorders[ids[k]];
                if (!b) continue;
                const touch = getIntersection(ray[0], ray[1], b[0], b[1]);
                if (touch && touch.offset < bestOffset){
                    best = touch; bestOffset = touch.offset;
                }
            }
        } else {
            for(let i=0;i<roadBorders.length;i++){
                const touch=getIntersection(ray[0],ray[1],roadBorders[i][0],roadBorders[i][1]);
                if (touch && touch.offset < bestOffset){
                    best = touch; bestOffset = touch.offset;
                }
            }
        }
        return best;
    }

    #castRays(){
        this.rays=[];
        for(let i=0;i<this.rayCount;i++){
            const rayAngle=lerp(
                this.raySpread/2,
                -this.raySpread/2,
                this.rayCount==1?0.5:i/(this.rayCount-1)
            )+this.car.angle;

            const start={x:this.car.x, y:this.car.y};
            const end={
                x:this.car.x-
                    Math.sin(rayAngle)*this.rayLength,
                y:this.car.y-
                    Math.cos(rayAngle)*this.rayLength
            };
            this.rays.push([start,end]);
        }
    }

    draw(ctx){
        for(let i=0;i<this.rayCount;i++){
            let end=this.rays[i][1];
            if(this.readings[i]){
                end=this.readings[i];
            }

            ctx.beginPath();
            ctx.lineWidth=2;
            ctx.strokeStyle="yellow";
            ctx.moveTo(
                this.rays[i][0].x,
                this.rays[i][0].y
            );
            ctx.lineTo(
                end.x,
                end.y
            );
            ctx.stroke();

            ctx.beginPath();
            ctx.lineWidth=2;
            ctx.strokeStyle="black";
            ctx.moveTo(
                this.rays[i][1].x,
                this.rays[i][1].y
            );
            ctx.lineTo(
                end.x,
                end.y
            );
            ctx.stroke();
        }
    }        
}