import { clamp, seededRandom } from './state.js';

// No AudioContext, network request, or sound until the user explicitly opts in.
// The preference deliberately starts off on every page load.
export class StudioAudio {
  constructor(){this.enabled=false;this.context=null;this.voices=new Set();this.revision=0;}
  init(){
    const AudioContext=globalThis.AudioContext||globalThis.webkitAudioContext;
    if(!AudioContext)throw new Error('Audio is unavailable in this browser.');
    const c=this.context=new AudioContext({latencyHint:'interactive'});
    this.master=c.createGain();this.master.gain.value=0;this.master.connect(c.destination);
    this.engine=c.createGain();this.engine.gain.value=0;
    this.filter=c.createBiquadFilter();this.filter.type='lowpass';this.filter.frequency.value=600;
    this.engine.connect(this.filter).connect(this.master);
    this.motor=c.createOscillator();this.motor.type='triangle';this.motor.frequency.value=48;
    this.harmonic=c.createOscillator();this.harmonic.type='sawtooth';this.harmonic.frequency.value=96;
    const blend=c.createGain();blend.gain.value=.12;
    this.motor.connect(this.engine);this.harmonic.connect(blend).connect(this.engine);
    this.motor.start();this.harmonic.start();
    const noise=c.createBuffer(1,Math.ceil(c.sampleRate*.22),c.sampleRate);
    const data=noise.getChannelData(0),random=seededRandom('circuit-studio-impact');
    for(let i=0;i<data.length;i++)data[i]=random()*2-1;
    this.noise=noise;
  }
  async setEnabled(on){
    const revision=++this.revision;
    this.enabled=false;
    if(!on){this.silence();await this.context?.suspend().catch(()=>{});return;}
    try{
      if(!this.context)this.init();
      await this.context.resume();
      if(revision!==this.revision)return;
      this.enabled=this.context.state==='running';
      this.error=this.enabled?'':'Audio could not start. Tap Sound to retry.';
      this.lastKey=null;
    }catch(error){this.error=error.message;this.silence();}
  }
  silence(){
    if(!this.context)return;
    const t=this.context.currentTime;
    this.master.gain.cancelScheduledValues(t);this.master.gain.setValueAtTime(0,t);
    for(const voice of this.voices){try{voice.stop();}catch{}}
    this.voices.clear();
  }
  update({pose,controls,maxSpeed=8,key,paused}){
    if(!this.enabled||!this.context)return;
    if(paused||!pose){this.silence();this.lastKey=null;return;}
    const t=this.context.currentTime,speed=clamp(Math.abs(pose.speed||0)/Math.max(1,maxSpeed),0,1);
    this.master.gain.setTargetAtTime(.22,t,.04);
    const throttle=!!(controls?.[0]||controls?.[3]);
    const pitch=48+speed*138+(throttle?8:0);
    this.motor.frequency.setTargetAtTime(pitch,t,.08);
    this.harmonic.frequency.setTargetAtTime(pitch*2.01,t,.08);
    this.filter.frequency.setTargetAtTime(380+speed*1200,t,.08);
    this.engine.gain.setTargetAtTime(pose.damaged?0:.07+speed*.13+(throttle?.035:0),t,.06);
    if(key===this.lastKey&&pose.damaged&&!this.lastDamaged)this.impact(t);
    this.lastKey=key;this.lastDamaged=!!pose.damaged;
  }
  impact(t){
    if(t-(this.lastImpact||-1)<.25)return;this.lastImpact=t;
    const c=this.context,source=c.createBufferSource(),filter=c.createBiquadFilter(),gain=c.createGain();
    source.buffer=this.noise;filter.type='lowpass';filter.frequency.value=850;
    gain.gain.setValueAtTime(.35,t);gain.gain.exponentialRampToValueAtTime(.001,t+.2);
    source.connect(filter).connect(gain).connect(this.master);
    this.voices.add(source);
    source.onended=()=>{this.voices.delete(source);source.disconnect();filter.disconnect();gain.disconnect();};
    source.start(t);source.stop(t+.22);
  }
  dispose(){this.enabled=false;this.revision++;this.silence();this.context?.close().catch(()=>{});}
}
