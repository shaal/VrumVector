class Controls{
    constructor(type){
        if(type==='KEYS'||type==='WASD')this.abort=new AbortController();
        this.forward=false;
        this.left=false;
        this.right=false;
        this.reverse=false;

        switch(type){
            case "KEYS":
                this.#addKeyboardListeners();
                break;
            case "WASD":
                this.#addWASDListeners();
                break;
        }
    }
    dispose(){this.abort?.abort();}
    #addWASDListeners(){
        document.addEventListener("keydown",(event)=>{
            if (event.ctrlKey || event.metaKey || event.altKey || event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
            switch(event.key.toLowerCase()){
                case "a":
                    this.left=true;
                    break;
                case "d":
                    this.right=true;
                    break;
                case "w":
                    this.forward=true;
                    break;
                case "s":
                    this.reverse=true;
                    break;
            }
        },{signal:this.abort.signal});
        document.addEventListener("keyup",(event)=>{
            switch(event.key.toLowerCase()){
                case "a":
                    this.left=false;
                    break;
                case "d":
                    this.right=false;
                    break;
                case "w":
                    this.forward=false;
                    break;
                case "s":
                    this.reverse=false;
                    break;
            }
        },{signal:this.abort.signal});
    }
    #addKeyboardListeners(){
        document.addEventListener("keydown",(event)=>{
            if (event.ctrlKey || event.metaKey || event.altKey || event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
            switch(event.key){
                case "ArrowLeft":
                    this.left=true;
                    break;
                case "ArrowRight":
                    this.right=true;
                    break;
                case "ArrowUp":
                    this.forward=true;
                    break;
                case "ArrowDown":
                    this.reverse=true;
                    break;
            }
        },{signal:this.abort.signal});
        document.addEventListener("keyup",(event)=>{
            switch(event.key){
                case "ArrowLeft":
                    this.left=false;
                    break;
                case "ArrowRight":
                    this.right=false;
                    break;
                case "ArrowUp":
                    this.forward=false;
                    break;
                case "ArrowDown":
                    this.reverse=false;
                    break;
            }
        },{signal:this.abort.signal});
    }
}