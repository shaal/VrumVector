function lerp(A,B,t){
    return A+(B-A)*t;
}

function getIntersection(A,B,C,D){ 
    const tTop=(D.x-C.x)*(A.y-C.y)-(D.y-C.y)*(A.x-C.x);
    const uTop=(C.y-A.y)*(A.x-B.x)-(C.x-A.x)*(A.y-B.y);
    const bottom=(D.y-C.y)*(B.x-A.x)-(D.x-C.x)*(B.y-A.y);
    
    if(bottom!=0){
        const t=tTop/bottom;
        const u=uTop/bottom;
        if(t>=0 && t<=1 && u>=0 && u<=1){
            return {
                x:lerp(A.x,B.x,t),
                y:lerp(A.y,B.y,t),
                offset:t
            }
        }
    }

    return null;
}

function polysIntersect(poly1, poly2){
    for(let i=0; i<poly1.length;i++){
        for(let j=0; j<poly2.length;j++){
            const touch =getIntersection(
                poly1[i],
                poly1[(i+1)%poly1.length],
                poly2[j],
                poly2[(j+1)%poly2.length]
                );
            if(touch){
                return true;
            }
        }
    }
    return false;
}

function phaseToLayout(phase){
    let rightPanel = document.getElementById("verticalButtons");
    let bottomText = document.getElementById("bottomText");
    switch(phase){
        case 1:
            // rightPanel.innerHTML = "<button onclick='saveTrack()'>Save Track</button><button onclick='deleteTrack()'>Delete Track</button><button onclick='deleteLastPoint()'>Delete Point</button><button onclick='nextPhase()'>Next</button>";
            rightPanel.innerHTML = `
                <button class='backNext back' disabled aria-disabled='true' title='You are on the first step'>Prev</button>
                <button class='backNext next' onclick='nextPhase()'>Next</button>
                <button class='controlButton' onclick='saveTrack()'>Save Track</button>
                <button class='controlButton' onclick='deleteTrack()'>Delete Track</button>
                <button class='controlButton' onclick='deleteLastPoint()'>Delete Point</button>
            `;
            bottomText.innerHTML = `
                <h1><span class="red">Left click</span> to add <span class="red">red</span> points</h1>
                <h1><span class="blue">Right click</span> to add <span class="blue">blue</span> points</h1>
            `;
            break;
        case 2:
            rightPanel.innerHTML = `
            <button class='backNext back' onclick='backPhase()'>Prev</button>
            <button class='backNext next' onclick='nextPhase()'>Next</button>
            <button class='controlButton' onclick='saveTrack()'>Save Track</button>
            <button class='controlButton' onclick='deleteLastPoint()'>Delete</button>
            `;
            bottomText.innerHTML = `
                <h1>Click to add checkpoints</h1>
            `;
            break;
        case 3:
            deleteInputCanvas();
            rightPanel.innerHTML = `   
            <button class='backNext back' onclick='backPhase()'>Prev</button>
            <button class='backNext next' onclick='nextPhase()'>Next</button>
            <button class='controlButton' onclick='savePhysics()'>Save Physics</button>
            <button class='controlButton' id='hide' onclick='makeInvincible();'>Invincible On</button>
            <br>
            <div id="inputsContainer">
                <input min="5" max="15" id="maxSpeedInput" step=".5" onkeydown="return false;" type="range" onchange='setMaxSpeed(this.value)' oninput="document.getElementById('maxSpeedOutput').value = 'Max Speed: ' + this.value" >
                <output id="maxSpeedOutput" name="Max Speed"></output>
                <input min="0" max="1" id="tractionInput" step=".01" onkeydown="return false;" type="range" onchange='setTraction(this.value)' oninput="document.getElementById('tractionOutput').value = 'Traction: ' + this.value" >
                <output id="tractionOutput" name="Traction"></output>
            </div>
            `;
            bottomText.innerHTML = `
                <h1>Tune your physics</h1>
                <h1>WASD or arrow keys to drive</h1>
            `;
            const idArray1 = ["maxSpeed", "traction"];
            for (let i = 0; i<idArray1.length; i++){
                document.getElementById(idArray1[i]+"Input").value = window[idArray1[i]];
                document.getElementById(idArray1[i]+"Output").value = document.getElementById(idArray1[i]+"Output").name + ": " +  window[idArray1[i]];
                document.getElementById(idArray1[i]+"Input").setAttribute("value", window[idArray1[i]]);
            }
            break;
        case 4:
            // ELI15 badges (P0.B): each "?" badge sits next to the UI element
            // whose concept it explains. Clicking opens the matching chapter.
            //   - Variance slider       → genetic-algorithm
            //   - Round Length slider   → fitness-function (scoring window)
            //   - timer (#timer)        → fitness-function + sensors (rays
            //                             appear on the canvas during phase 4)
            //   - inputCanvas (NN out)  → neural-network (see uiPanels/indexed
            //                             via the inputCanvas badge wrapper below)
            rightPanel.innerHTML = `
            <button class='controlButton' id='pause' onclick='pauseGame()'>Pause</button>
            <button class='controlButton secondary' id='customizeTrackBtn' onclick='customizeTrack()' title='Draw your own track shape, reset checkpoints, retune physics'>✏️ Customize Track</button>
            <button class='controlButton' id='demoModeBtn' onclick='window.DemoPresentation&&window.DemoPresentation.startDemoMode()' title='Cinematic demo: follow champion, story beats, readable swarm (M)'>🎬 Demo mode</button>

            <!-- Live-data region: inputCanvas + graphCanvas get appended here by
                 showInputCanvas/showGraphCanvas so they stay at the top of the
                 panel (visible without scrolling) while the secondary sliders
                 sit below. -->
            <div id="liveData" class="live-data"></div>
            <div id="timer"></div>
            <div id="timer-eli15" class="timer-eli15">
                <span data-eli15="fitness-function" role="button" tabindex="0" aria-label="Learn: fitness function"></span>
                <span data-eli15="sensors" role="button" tabindex="0" aria-label="Learn: ray-cast sensors"></span>
                <span data-eli15="neural-network" role="button" tabindex="0" aria-label="Learn: neural network"></span>
            </div>

            <div id="trainingPresets" style="display:flex; gap:.35em; margin:.35em 0; flex-wrap:wrap;">
                <button class='controlButton' style='flex:1;min-width:0;' onclick="applyTrainingPreset('fresh')" title="Cold start: N=500, 2×, 15s, variance 0.25, cons-init 0.70">🌱 Fresh</button>
                <button class='controlButton' style='flex:1;min-width:0;' onclick="applyTrainingPreset('grind')" title="Farm gens + archive: N=600, 20×, 15s, variance 0.18">🏎️ Grind</button>
                <button class='controlButton' style='flex:1;min-width:0;' onclick="applyTrainingPreset('polish')" title="Refine lap times: N=800, 2×, 25s, variance 0.05">✨ Polish</button>
            </div>
            <details id="trainingTuning" class="more-actions">
                <summary>Training tuning (sliders)</summary>
                <div id="inputsContainer">
                    <input min="0" max="2000" id="batchSizeInput" step="50" onkeydown="return false;" type="range" onchange='setN(this.value)' oninput="document.getElementById('batchSizeOutput').value = 'Batch Size: ' + this.value" >
                    <output  id="batchSizeOutput" name="Batch Size"></output>
                    <input min="5" max="100" id="secondsInput" step="5" onkeydown="return false;" type="range" onchange='setSeconds(this.value)' oninput="document.getElementById('secondsOutput').value = 'Round Length: ' + this.value" >
                    <output id="secondsOutput" name="Round Length"></output>
                    <input min=".001" max=".3" id="mutateValueInput" onkeydown="return false;" step=".001" type="range" onchange='setMutateValue(this.value)' oninput="document.getElementById('mutateValueOutput').value = 'Variance: ' + this.value" >
                    <output id="mutateValueOutput" name="Variance"></output>
                    <span data-eli15="genetic-algorithm" role="button" tabindex="0" aria-label="Learn: genetic algorithm + variance"></span>
                    <input min="0" max="1" id="conservativeInitInput" step=".05" onkeydown="return false;" type="range" onchange='setConservativeInit(this.value)' oninput="document.getElementById('conservativeInitOutput').value = 'Conservative Init: ' + this.value" >
                    <output id="conservativeInitOutput" name="Conservative Init"></output>
                    <label id="simSpeedLabel" style="display:flex; align-items:center; gap:.4em; margin-top:.35em; font-size:.82em;">
                        <span>Sim Speed:</span>
                        <select id="simSpeedInput" onchange="setSimSpeed(this.value)" style="flex:1;">
                            <option value="0.5">0.5&times; (slow)</option>
                            <option value="1">1&times; (real)</option>
                            <option value="2" selected>2&times;</option>
                            <option value="5">5&times;</option>
                            <option value="20">20&times;</option>
                            <option value="100">100&times; (max)</option>
                        </select>
                    </label>
                </div>
            </details>
            <details id='brainShareSection' class='more-actions'>
                <summary>Import / Export Brain</summary>
                <div class='more-actions-body'>
                    <div id="brainShare" class='brain-share'>
                        <button class='controlButton' onclick='exportBrainJson()' title='Download current best brain as a ~1 KB JSON file'>⬇️ Export Brain</button>
                        <button class='controlButton' onclick='importBrainJson()' title='Load a brain JSON file and use it as the seed'>⬆️ Import Brain</button>
                        ${window.__rvfEnabled ? `
                        <button class='controlButton' onclick='exportBrainPackRvf()' title='Export full brain pack as .rvf (experimental)'>⬇️ .rvf</button>
                        <button class='controlButton' onclick='importBrainPackRvf()' title='Import a .rvf brain pack (experimental)'>⬆️ .rvf</button>
                        ` : ''}
                    </div>
                </div>
            </details>
            <details id='moreActions' class='more-actions'>
                <summary>More actions</summary>
                <div class='more-actions-body'>
                    <button class='controlButton' onclick='destroyBrain(); nextBatch();'>Reset Brain</button>
                    <button class='controlButton' onclick='resetFastLap();'>Reset Fast Lap</button>
                    <button class='controlButton' onclick='restartBatch();'>Restart Batch</button>
                    <button class='controlButton' onclick='save(); restartBatch();'>Save Best + Restart</button>
                    <button class='controlButton' onclick='restoreOldBrain();'>Restore Old Brain</button>
                </div>
            </details>
            <details id='brainSaves' class='brain-saves'>
                <summary>🧠 Brain saves <span class='brain-saves-hint'>(named slots)</span></summary>
                <div class='brain-saves-body'>
                    <div class='brain-saves-row'>
                        <select id='brainSavesSelect' class='brain-saves-select' aria-label='Saved brain slots'>
                            <option value='' disabled selected>(no saves yet)</option>
                        </select>
                    </div>
                    <div class='brain-saves-row'>
                        <button class='controlButton' onclick='brainSaveAs();' title='Save the current best brain under a name you choose'>💾 Save current as…</button>
                        <button class='controlButton' onclick='brainSaveLoad();' title='Replace the current best brain with the selected saved one and restart the batch'>📂 Load</button>
                        <button class='controlButton' onclick='brainSaveDelete();' title='Delete the selected saved brain'>🗑 Delete</button>
                    </div>
                    <div class='brain-saves-row'>
                        <button class='controlButton brain-saves-fresh' onclick='brainStartFresh();' title='Wipe ALL trained state (archive + saved best + fast lap) and reload — true gen-0 start. Named saves are preserved.'>🌱 Start with empty brain</button>
                    </div>
                    <div class='brain-saves-row'>
                        <button class='controlButton' onclick='clearAllFastLaps();' title='Wipe every per-track fast-lap record across all tracks. Named brain saves are NOT affected.'>🗑 Clear all fast laps</button>
                    </div>
                </div>
            </details>
            `;
            bottomText.innerHTML = `
                <h1>Train your model!</h1>
            `;
            // Soft story while waiting for an explicit Start click.
            try {
                if (window.__awaitingStart && window.DemoPresentation && window.DemoPresentation.setStory){
                    window.DemoPresentation.setStory(
                        window.__firstStart
                            ? 'Press ▶ Start Training — or 🎬 Demo mode for a guided cinematic run.'
                            : 'Sim is paused. Press ▶ Start Training when you are ready.',
                        8000
                    );
                }
            } catch (_) {}
            // Reflect live globals. Round-length slider is bound to `seconds`
            // but the setter writes `nextSeconds` — keep both in sync for the
            // initial paint (begin() also copies nextSeconds → seconds).
            if (typeof nextSeconds === 'number' && (typeof seconds !== 'number' || !Number.isFinite(seconds))) {
                seconds = nextSeconds;
            }
            const idArray = ["batchSize", "seconds", "mutateValue", "conservativeInit"];
            for (let i = 0; i<idArray.length; i++){
                const key = idArray[i];
                const val = (key === 'seconds')
                    ? (typeof nextSeconds === 'number' ? nextSeconds : window.seconds)
                    : window[key];
                const input = document.getElementById(key+"Input");
                const output = document.getElementById(key+"Output");
                if (!input || !output) continue;
                input.value = val;
                output.value = output.name + ": " + val;
                input.setAttribute("value", val);
            }
            // Sim-speed <select> — match current simSpeed (default 2×).
            const ssEl = document.getElementById('simSpeedInput');
            if (ssEl && typeof simSpeed !== 'undefined') ssEl.value = String(simSpeed);
            // Move "Import / Export Brain" and "More actions" panels to sit
            // below #rv-panel (Vector Memory) so they live at the bottom of
            // the right column instead of above it. Order placed:
            //   rv-panel → brainShareSection → moreActions
            try {
                const brainShareEl = document.getElementById('brainShareSection');
                const moreActionsEl = document.getElementById('moreActions');
                const brainSavesEl = document.getElementById('brainSaves');
                const rvPanelEl = document.getElementById('rv-panel');
                if (rvPanelEl && rvPanelEl.parentNode) {
                    if (brainShareEl) rvPanelEl.parentNode.insertBefore(brainShareEl, rvPanelEl.nextSibling);
                    if (moreActionsEl && brainShareEl) brainShareEl.parentNode.insertBefore(moreActionsEl, brainShareEl.nextSibling);
                    else if (moreActionsEl) rvPanelEl.parentNode.insertBefore(moreActionsEl, rvPanelEl.nextSibling);
                    // Brain saves sits directly under moreActions so the
                    // legacy single-slot Save Best+Restart button and the
                    // new named-slot row are visually adjacent.
                    if (brainSavesEl && moreActionsEl) moreActionsEl.parentNode.insertBefore(brainSavesEl, moreActionsEl.nextSibling);
                }
            } catch (_) {}
            // Populate the brain-saves dropdown from localStorage now that
            // the <select> exists in the DOM.
            try {
                if (typeof refreshBrainSavesDropdown === 'function') refreshBrainSavesDropdown();
            } catch (_) {}
            showInputCanvas();
            showGraphCanvas();
            graphProgress();
            begin();
            // Page-load gate: begin() keeps pause=true while __awaitingStart.
            // Label the primary button as an explicit Start CTA. After the
            // first click, pauseGame() graduates it to Pause/Play.
            if (window.__awaitingStart){
                pause = true;
                const pb = document.getElementById('pause');
                if (pb){
                    pb.textContent = '▶ Start Training';
                    pb.classList.add('start-cta');
                }
            }
            try { if (typeof syncStartOverlay === 'function') syncStartOverlay(); } catch (_) {}
            break;

    }
}