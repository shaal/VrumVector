// The co-driver copies the live leader's network, then evaluates it against
// the human car's own sensors. Keyboard state remains separate from AI output.
import {attachLearningControls} from '../learning/session.js';
class PlayerAssist {
  constructor() {
    this.enabled=false;this.requestId=0;this.nextRequest=0;this.run=-1;
    this.root=document.createElement('section');this.root.id='player-assist';this.root.hidden=true;
    this.root.setAttribute('aria-label','AI driving');
    this.root.innerHTML=`<button type="button" id="ai-drive-toggle" aria-pressed="false" aria-describedby="ai-drive-hint">AI driving: off</button><p id="ai-drive-hint">Your car · WASD to drive</p>`;
    document.getElementById('canvasDiv').append(this.root);
    this.button=this.root.querySelector('button');this.hint=this.root.querySelector('p');
    this.button.onclick=()=>this.setEnabled(!this.enabled);
    attachLearningControls(this.root);
  }
  release() {
    if(this.car){this.car.aiDriving=false;this.car.controls.setAI(null);}
  }
  setEnabled(on) {
    this.release();this.enabled=!!on;this.brain=null;this.requestId++;this.nextRequest=0;
    if(this.enabled)window.resumePlayerDriving?.();
    this.render();
  }
  frame(info) {
    this.info=info;
    this.root.hidden=info.phase!==4||document.getElementById('canvasDiv').classList.contains('ab-on');
    const car=info.players[1];
    if(car)car.driverProfile=window.DriverLearning?.profile||'balanced';
    if(car!==this.car||this.run!==info.runSerial){
      this.release();this.car=car;this.run=info.runSerial;this.brain=null;this.requestId++;this.nextRequest=0;
    }
    if(!this.enabled||this.root.hidden){this.release();return;}
    if(this.brain&&car){car.brain=this.brain;car.aiDriving=true;}
    const now=performance.now();
    if(info.snapshot&&now>=this.nextRequest){
      this.nextRequest=now+1000;
      window.requestPlayerBrain?.(++this.requestId);
    }
    this.render();
  }
  acceptBrain(message) {
    if(!this.enabled||this.root.hidden||message.requestId!==this.requestId||message.runSerial!==this.run)return;
    if(message.brain?.length!==244||!message.brain.every(Number.isFinite))return;
    // Inflation makes private scratch arrays; the worker's training network is
    // never mutated by the human car or its manual overrides.
    this.brain=window.inflateBrainInline(message.brain);
    if(this.brain&&this.car){this.car.brain=this.brain;this.car.aiDriving=true;}
    this.render();
  }
  render() {
    const label=this.enabled?'AI driving: on':'AI driving: off';
    const hint=!this.enabled?'Your car · WASD to drive':!this.brain?'Picking up the leading AI…':
      'AI drives your car · Hold A/D to steer, W/S to accelerate or brake. Release to resume AI.';
    if(this.button.textContent!==label)this.button.textContent=label;
    this.button.setAttribute('aria-pressed',String(this.enabled));
    if(this.hint.textContent!==hint)this.hint.textContent=hint;
  }
}
window.PlayerAssist=new PlayerAssist();
