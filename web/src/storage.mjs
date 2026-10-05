export class LocalStore {
  constructor(name='m04s-studio-v1'){this.name=name;this.urls=new Map();}
  async open(){
    this.db=await new Promise((resolve,reject)=>{const r=indexedDB.open(this.name,1);r.onupgradeneeded=()=>r.result.createObjectStore('items');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    return this;
  }
  async get(key,fallback=null){return this.run('readonly',store=>store.get(key)).then(value=>value??fallback);}
  async set(key,value){await this.run('readwrite',store=>store.put(value,key));return value;}
  async delete(key){await this.run('readwrite',store=>store.delete(key));}
  run(mode,fn){return new Promise((resolve,reject)=>{const tx=this.db.transaction('items',mode),r=fn(tx.objectStore('items'));let value;r.onsuccess=()=>value=r.result;tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('本地存储失败'));});}
  async entries(){return new Promise((resolve,reject)=>{const tx=this.db.transaction('items','readonly'),r=tx.objectStore('items').openCursor(),result=[];r.onsuccess=()=>{const c=r.result;if(c){result.push([c.key,c.value]);c.continue();}else resolve(result);};r.onerror=()=>reject(r.error);});}
  async url(id){if(!this.urls.has(id)){const blob=await this.get('asset:'+id);if(!blob)throw Error('图片不存在，请重新上传');this.urls.set(id,URL.createObjectURL(blob));}return this.urls.get(id);}
}
