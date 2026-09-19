class Controls {
    constructor(type) {
        this.forward = this.left = this.right = this.reverse = false;
        if (type !== 'KEYS' && type !== 'WASD') return;
        this.manual = {forward:false, left:false, right:false, reverse:false};
        this.ai = null;
        this.abort = new AbortController();
        const keys = type === 'WASD'
            ? {w:'forward', a:'left', d:'right', s:'reverse'}
            : {arrowup:'forward', arrowleft:'left', arrowright:'right', arrowdown:'reverse'};
        document.addEventListener('keydown', event => {
            if (event.ctrlKey || event.metaKey || event.altKey || event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
            const key = keys[event.key.toLowerCase()];
            if (!key) return;
            event.preventDefault();
            this.manual[key] = true;
            this.resolve();
        }, {signal:this.abort.signal});
        document.addEventListener('keyup', event => {
            const key = keys[event.key.toLowerCase()];
            if (!key) return;
            this.manual[key] = false;
            this.resolve();
        }, {signal:this.abort.signal});
        window.addEventListener('blur', () => this.clear(), {signal:this.abort.signal});
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) this.clear();
        }, {signal:this.abort.signal});
    }
    setAI(outputs) {
        this.ai = outputs ? {forward:!!outputs[0], left:!!outputs[1], right:!!outputs[2], reverse:!!outputs[3]} : null;
        this.resolve();
    }
    resolve() {
        if (!this.manual) return;
        // Override a whole axis: D must suppress an AI left turn, and S must
        // suppress AI acceleration. Releasing the keys returns that axis to AI.
        const steering = this.manual.left || this.manual.right ? this.manual : this.ai || this.manual;
        const throttle = this.manual.forward || this.manual.reverse ? this.manual : this.ai || this.manual;
        this.left = steering.left; this.right = steering.right;
        this.forward = throttle.forward; this.reverse = throttle.reverse;
    }
    clear() {
        if (this.manual) for (const key of Object.keys(this.manual)) this.manual[key] = false;
        this.ai = null;
        this.forward = this.left = this.right = this.reverse = false;
    }
    dispose() { this.clear(); this.abort?.abort(); }
}
