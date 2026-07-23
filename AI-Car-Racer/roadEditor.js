class roadEditor{
    constructor(startInfo){
        this.startInfo=startInfo;
        this.checkPointMode=false;
        this.editMode = true;
        // Fresh visitors land with the Rectangle preset exactly (same walls
        // AND same checkpoint layout as clicking "Load preset: Rectangle").
        // If TRACK_PRESETS is loaded by the time we boot, mirror it;
        // otherwise fall back to the hardcoded values that match the preset.
        // localStorage always wins over both.
        const rectPreset = (typeof window !== 'undefined' && window.TRACK_PRESETS && window.TRACK_PRESETS[0]) || null;
        if(localStorage.getItem("trackInner") && localStorage.getItem("trackOuter")){
            this.points=JSON.parse(localStorage.getItem("trackInner"));
            this.points2=JSON.parse(localStorage.getItem("trackOuter"));
        }
        else if (rectPreset){
            this.points  = rectPreset.points.map(p => ({x:p.x, y:p.y}));
            this.points2 = rectPreset.points2.map(p => ({x:p.x, y:p.y}));
        }
        else{
            this.points  = [{x:650,y:700},{x:2450,y:700},{x:2450,y:1100},{x:650,y:1100}];
            this.points2 = [{x:250,y:300},{x:3100,y:300},{x:3100,y:1500},{x:250,y:1500}];
        }
        if(localStorage.getItem("checkPointList")){
            this.checkPointListEditor=JSON.parse(localStorage.getItem("checkPointList"));
        }
        else if (rectPreset){
            this.checkPointListEditor = rectPreset.checkPointListEditor.map(seg => [
                { x: seg[0].x, y: seg[0].y },
                { x: seg[1].x, y: seg[1].y }
            ]);
        }
        else{
            // Fallback mirroring Rectangle preset's 5-gate layout: diagonal
            // lower/upper-right spawn pair, top-mid, left-mid, bottom-mid.
            this.checkPointListEditor = [
                [{x:3128,y:1316},{x:2418,y:1068}],
                [{x:3135,y:376 },{x:2414,y:725 }],
                [{x:1600,y:300 },{x:1600,y:700 }],
                [{x:250, y:900 },{x:650, y:900 }],
                [{x:1600,y:1060},{x:1600,y:1565}]
            ];
        }
        this.drag_point = -1;
        this.pointSize = startInfo.startWidth/1.5;
        this.canvas = document.getElementById("myCanvas");
        this.ctx=document.getElementById("myCanvas").getContext("2d");
        this.#addMouseListeners();
        this.lastClicked=this.drag_point;
    }
    checkPointModeChange(onOff){
        this.checkPointMode = onOff;
    }
    editModeChange(onOff){
        this.editMode = onOff;
    }

    getPointAt(x, y) {
        if(this.checkPointMode){
            for (var i = 0; i < this.checkPointListEditor.length; i++) {
                for(var j=0; j<2;j++){
                    if (
                        Math.abs(this.checkPointListEditor[i][j].x - x) < this.pointSize &&
                        Math.abs(this.checkPointListEditor[i][j].y - y) < this.pointSize
                      )
                        return [i,j];
                }
              }
        }
        else{
            for (var i = 0; i < this.points.length; i++) {
                if (
                  Math.abs(this.points[i].x - x) < this.pointSize &&
                  Math.abs(this.points[i].y - y) < this.pointSize
                )
                  return {index: i, list: 1};
              }
            for (var i = 0; i < this.points2.length; i++) {
                if (
                Math.abs(this.points2[i].x - x) < this.pointSize &&
                Math.abs(this.points2[i].y - y) < this.pointSize
                )
                return {index: i, list: 2};
            }
        }
  
        return -1; 
    }
    redraw() {
        // this.canvas = document.getElementById("myCanvas");
        // this.ctx=document.getElementById("myCanvas").getContext("2d");
        if (this.points.length > 0) {
            this.ctx.clearRect(0, 0, canvas.width, canvas.height);
            this.paintTo(this.ctx);
        } else {
            this.drawStartPos(this.startInfo, this.ctx);
        }
        // Track edits invalidate the presentation road cache (if present).
        try {
            if (window.DemoPresentation && window.DemoPresentation.invalidateRoad) {
                window.DemoPresentation.invalidateRoad();
            }
        } catch (_) {}
    }

    // Paint walls / checkpoints / start flag to any 2d context. Used by the
    // live redraw path and by DemoPresentation's offscreen road cache so
    // training frames can blit a static road instead of re-stroking geometry.
    paintTo(c) {
        if (!c) c = this.ctx;
        if (this.editMode) {
            // drawCircles uses this.ctx — temporarily rebind.
            const prev = this.ctx;
            this.ctx = c;
            try { this.drawCircles(); } finally { this.ctx = prev; }
        }
        this.drawLinesOn(c);
        this.drawStartPos(this.startInfo, c);
    }

    drawLines() {
        this.drawLinesOn(this.ctx);
    }

    drawLinesOn(c) {
        // Canvas is 3200x1800 but the layout downscales it ~3x in CSS pixels,
        // so sub-3px strokes vanish after downsample. Use 10–12 canvas px
        // during gameplay (editMode=false) so walls remain legible to the eye.
        const wallW = this.editMode ? 2 : 12;
        const closeW = this.editMode ? .75 : 12;
        const checkW = this.editMode ? 2 : 8;

        c.beginPath();
        c.moveTo(this.points[0].x, this.points[0].y);
        c.strokeStyle = "white";
        c.lineWidth = wallW;
        this.points.forEach((p) => {
            c.lineTo(p.x, p.y);
        })
        c.stroke();
        c.lineWidth = closeW;
        c.globalAlpha = this.editMode?.2:1;
        c.lineTo(this.points[0].x,this.points[0].y);
        c.stroke();
        c.globalAlpha = 1;

        c.beginPath();
        c.moveTo(this.points2[0].x, this.points2[0].y);
        c.strokeStyle = "white";
        c.lineWidth = wallW;
        this.points2.forEach((p) => {
            c.lineTo(p.x, p.y);
        })
        c.stroke();
        c.lineWidth = closeW;
        c.globalAlpha = this.editMode?.2:1;
        c.lineTo(this.points2[0].x,this.points2[0].y);
        c.stroke();
        c.globalAlpha = 1;

        // Checkpoints: named-"green" (#008000) reads only 3.2:1 on the
        // near-black scene (#15161a) and collapses toward muddy olive under
        // deuteranopia. #58E05D lime jumps to ~7:1, stays clearly green to
        // trichromats, and stays distinct from the yellow sensor rays by
        // luminance even under red-green CVD.
        c.strokeStyle = "#58E05D";
        c.lineWidth = checkW;
        this.checkPointListEditor.forEach((p)=>{
            c.beginPath();
            c.moveTo(p[0].x,p[0].y);
            c.lineTo(p[1].x,p[1].y);
            c.stroke();
        })

        // 1-based index labels: the order (cp[0]→cp[1]→…) determines lap
        // direction, spawn heading (main.js:16-46), and reward sequencing
        // (car.js:130) — numbering makes that invisible ordering visible so
        // authors can confirm the car's intended path through the gates.
        // Labels are tangent-offset so they sit just off the gate line rather
        // than clipping on top of it.
        const labelPx = this.editMode ? 40 : 60;
        c.font = `bold ${labelPx}px Tahoma, sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.lineWidth = 4;
        this.checkPointListEditor.forEach((p, i) => {
            const mx = (p[0].x + p[1].x) / 2;
            const my = (p[0].y + p[1].y) / 2;
            const dx = p[1].x - p[0].x;
            const dy = p[1].y - p[0].y;
            const len = Math.sqrt(dx*dx + dy*dy) || 1;
            // Perpendicular unit vector → push label off the gate centerline.
            const nx = -dy / len;
            const ny =  dx / len;
            const off = labelPx * 0.9;
            const lx = mx + nx * off;
            const ly = my + ny * off;
            const label = String(i + 1);
            c.strokeStyle = "#15161a";  // dark outline matches scene bg
            c.strokeText(label, lx, ly);
            c.fillStyle = "#58E05D";
            c.fillText(label, lx, ly);
        });
    }
    deleteLast(){
        if(this.checkPointMode && typeof this.lastClicked[1] != 'undefined' && this.checkPointListEditor.length>1){
            this.checkPointListEditor.splice(this.lastClicked[0],1);
        }
        else if(typeof this.lastClicked.index != 'undefined' && this.editMode){
            if(this.lastClicked.list == 1 && this.points.length>1){
                this.points.splice(this.lastClicked.index,1);   
                if(this.lastClicked.index == this.points.length){ //shift index to last point for delete multiple times
                    this.lastClicked.index--;
                }
            }
            else if (this.lastClicked.list==2 && this.points2.length>1){
                this.points2.splice(this.lastClicked.index,1);
                if(this.lastClicked.index == this.points2.length){
                    this.lastClicked.index--;
                }
            }
        }
    }

    // getPosition(event) {
    //     var rect = this.canvas.getBoundingClientRect();
    //     var x = event.clientX - rect.left;
    //     var y = event.clientY - rect.top;
    //     return {x, y};
    // }
    getPosition(evt) {
        var rect = this.canvas.getBoundingClientRect(), // abs. size of element
        scaleX = this.canvas.width / rect.width,    // relationship bitmap vs. element for x
        scaleY = this.canvas.height / rect.height;  // relationship bitmap vs. element for y
        var x = (evt.clientX - rect.left) * scaleX;
        var y = (evt.clientY - rect.top) * scaleY;
        return {x,y};
      }
      

    drawCircles() {
        if(!this.checkPointMode){
            // Inner-wall handles: crimson reads clearer than #FF0000 against
            // the scene bg and is CVD-separable from the amber AI cars once
            // edit mode drops back into training.
            this.ctx.strokeStyle = "#E6194B";
            this.ctx.lineWidth = 3;
            this.points.forEach((p) => {
                this.ctx.beginPath();
                this.ctx.arc(p.x, p.y, this.pointSize, 0, Math.PI * 2, true);
                this.ctx.stroke();
            })

            // Outer-wall handles: CSS-named "blue" (#0000FF) is only 2.5:1
            // against #15161a — a classic WCAG trap. Sky blue jumps to ~7:1
            // and is still clearly "blue" to trichromats.
            this.ctx.strokeStyle = "#4FC3F7";
            this.ctx.lineWidth = 4;
            this.points2.forEach((p) => {
                this.ctx.beginPath();
                this.ctx.arc(p.x, p.y, this.pointSize, 0, Math.PI * 2, true);
                this.ctx.stroke();
            })
        }


        if(this.checkPointMode){
            this.ctx.strokeStyle = "#58E05D";
            this.ctx.lineWidth = 3;
            this.checkPointListEditor.forEach((p) => {
                this.ctx.beginPath();
                this.ctx.arc(p[0].x, p[0].y, this.pointSize, 0, Math.PI * 2, true);
                this.ctx.stroke();
                this.ctx.beginPath();
                this.ctx.arc(p[1].x, p[1].y, this.pointSize, 0, Math.PI * 2, true);
                this.ctx.stroke();
            })
        }
  
    }
    
    #addMouseListeners(){
        window.oncontextmenu = function ()
        {
            return false;     // cancel default menu
        }
        canvas.onmousedown = function(e) {
            var pos = road.roadEditor.getPosition(e);
            let rightClick = e.button == 2; //gets right click
            let leftClick = e.button == 0;
            road.roadEditor.drag_point = road.roadEditor.getPointAt(pos.x, pos.y);
            if (leftClick && !road.roadEditor.checkPointMode && road.roadEditor.editMode){
                if (road.roadEditor.drag_point == -1) {
                    road.roadEditor.points.push(pos);
                    road.roadEditor.redraw();
                }
            }
            else if (rightClick && !road.roadEditor.checkPointMode && road.roadEditor.editMode){
                if (road.roadEditor.drag_point == -1) {
                    road.roadEditor.points2.push(pos);
                    road.roadEditor.redraw();
                }
            }
            else if(road.roadEditor.checkPointMode && road.roadEditor.editMode){
                if (road.roadEditor.drag_point == -1) {
                    road.roadEditor.checkPointListEditor.push([pos,{x:pos.x+100,y:pos.y}]);
                    road.roadEditor.redraw();
                } 
            }
          };
        canvas.onmousemove = function(e) {
        if (road.roadEditor.drag_point != -1) {
            var pos = road.roadEditor.getPosition(e);
            if (road.roadEditor.editMode && road.roadEditor.drag_point.list==1 && !road.roadEditor.checkPointMode){
                road.roadEditor.points[road.roadEditor.drag_point.index].x = pos.x;
                road.roadEditor.points[road.roadEditor.drag_point.index].y = pos.y;
            }
            else if (road.roadEditor.editMode && road.roadEditor.drag_point.list==2 &&!road.roadEditor.checkPointMode){
                road.roadEditor.points2[road.roadEditor.drag_point.index].x = pos.x;
                road.roadEditor.points2[road.roadEditor.drag_point.index].y = pos.y;
            }
            else if(road.roadEditor.checkPointMode && road.roadEditor.editMode){
                road.roadEditor.checkPointListEditor[road.roadEditor.drag_point[0]][road.roadEditor.drag_point[1]].x = pos.x;
                road.roadEditor.checkPointListEditor[road.roadEditor.drag_point[0]][road.roadEditor.drag_point[1]].y = pos.y;
            }
            road.roadEditor.redraw(); 
        }
        };
        canvas.onmouseup = function(e) {
            if(road.roadEditor.drag_point !=-1){
                road.roadEditor.lastClicked=road.roadEditor.drag_point;
            }
            else{
                var pos = road.roadEditor.getPosition(e);
                road.roadEditor.lastClicked= road.roadEditor.getPointAt(pos.x, pos.y);
            }
            road.roadEditor.drag_point = -1;
        }; 
    }
    drawStartPos(startInfo, ctx){
        ctx.lineWidth = 3;
        ctx.strokeStyle = "white";
        ctx.beginPath();
        ctx.moveTo(startInfo.x,startInfo.y);
        ctx.lineTo(startInfo.x+startInfo.startWidth,startInfo.y+startInfo.startWidth);
        ctx.lineTo(startInfo.x-startInfo.startWidth,startInfo.y+startInfo.startWidth);
        ctx.lineTo(startInfo.x,startInfo.y);
        ctx.closePath();
        ctx.fillStyle="red";
        ctx.fill();
        ctx.stroke();
        ctx.font = "bold 3em Tahoma";
        ctx.textAlign = 'center';
        ctx.fillStyle = "white";
        ctx.fillText("START",startInfo.x,startInfo.y+ startInfo.startWidth+3*parseFloat(getComputedStyle(document.getElementById("fullDisplay")).fontSize));
    }
}
