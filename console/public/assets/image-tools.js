'use strict';
// Deterministic local image processing. No image is sent to an external service.
(function(root) {
  const limit=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
  function blur(gray,w,h,radius) {
    const r=Math.max(1,Math.round(radius)),a=new Float32Array(gray.length),out=new Float32Array(gray.length);
    for(let y=0;y<h;y++) {
      let sum=0;for(let k=-r;k<=r;k++)sum+=gray[y*w+limit(k,0,w-1)];
      for(let x=0;x<w;x++){a[y*w+x]=sum/(2*r+1);sum+=gray[y*w+limit(x+r+1,0,w-1)]-gray[y*w+limit(x-r,0,w-1)];}
    }
    for(let x=0;x<w;x++) {
      let sum=0;for(let k=-r;k<=r;k++)sum+=a[limit(k,0,h-1)*w+x];
      for(let y=0;y<h;y++){out[y*w+x]=sum/(2*r+1);sum+=a[limit(y+r+1,0,h-1)*w+x]-a[limit(y-r,0,h-1)*w+x];}
    }
    return out;
  }
  function transform(gray,w,h,options={}) {
    const adjusted=new Float32Array(gray.length);
    const brightness=limit(Number(options.brightness)||0,-100,100)*2.55;
    const contrast=limit(Number(options.contrast)||0,-100,100)*2.55;
    const factor=259*(contrast+255)/(255*(259-contrast));
    for(let i=0;i<gray.length;i++)adjusted[i]=limit(factor*(gray[i]-128)+128+brightness,0,255);
    const effect=options.effect||'original';let out=adjusted;
    if(effect==='line') {
      const smooth=blur(adjusted,w,h,1);out=new Float32Array(gray.length).fill(255);
      const at=(x,y)=>smooth[limit(y,0,h-1)*w+limit(x,0,w-1)];
      const strength=limit(Number(options.strength)||50,1,100)/25;
      for(let y=0;y<h;y++)for(let x=0;x<w;x++){
        const gx=-at(x-1,y-1)+at(x+1,y-1)-2*at(x-1,y)+2*at(x+1,y)-at(x-1,y+1)+at(x+1,y+1);
        const gy=-at(x-1,y-1)-2*at(x,y-1)-at(x+1,y-1)+at(x-1,y+1)+2*at(x,y+1)+at(x+1,y+1);
        out[y*w+x]=255-limit(Math.hypot(gx,gy)*strength/4,0,255);
      }
    } else if(effect==='sketch') {
      const soft=blur(adjusted,w,h,Math.max(2,Math.round(w/100)));out=new Float32Array(gray.length);
      const strength=limit(Number(options.strength)||50,1,100)/100;
      for(let i=0;i<out.length;i++){
        const dodge=Math.min(255,adjusted[i]*255/Math.max(1,soft[i]));
        out[i]=limit(dodge*(1-strength*.35)+adjusted[i]*strength*.35,0,255);
      }
    } else if(effect==='text') {
      const background=blur(adjusted,w,h,Math.max(5,Math.round(w/35)));out=new Float32Array(gray.length);
      const offset=4+limit(Number(options.strength)||50,1,100)*.22;
      for(let i=0;i<out.length;i++)out[i]=adjusted[i]<Math.max(70,Math.min(210,background[i]-offset))?0:255;
    }
    if(options.invert)for(let i=0;i<out.length;i++)out[i]=255-out[i];
    return out;
  }
  function monochrome(gray,w,h,mode='threshold',threshold=180) {
    const working=new Float32Array(gray),out=new Uint8ClampedArray(gray.length);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=y*w+x,value=working[i]<(mode==='dither'?128:threshold)?0:255;out[i]=value;
      if(mode==='dither'){
        const error=working[i]-value;
        if(x+1<w)working[i+1]+=error*7/16;
        if(y+1<h){if(x>0)working[i+w-1]+=error*3/16;working[i+w]+=error*5/16;if(x+1<w)working[i+w+1]+=error/16;}
      }
    }
    return out;
  }
  function canvas(source,options={}) {
    const ctx=source.getContext('2d',{willReadFrequently:true}),frame=ctx.getImageData(0,0,source.width,source.height);
    const gray=new Float32Array(source.width*source.height);
    for(let i=0;i<gray.length;i++)gray[i]=.299*frame.data[i*4]+.587*frame.data[i*4+1]+.114*frame.data[i*4+2];
    let values=transform(gray,source.width,source.height,options);
    if(['photo','sketch'].includes(options.effect))values=monochrome(values,source.width,source.height,'dither');
    if(options.effect==='line')values=monochrome(values,source.width,source.height,'threshold',180);
    for(let i=0;i<values.length;i++){frame.data[i*4]=frame.data[i*4+1]=frame.data[i*4+2]=values[i];frame.data[i*4+3]=255;}
    ctx.putImageData(frame,0,0);return source;
  }
  const api={blur,transform,monochrome,canvas};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ImageTools=api;
})(typeof globalThis!=='undefined'?globalThis:this);
