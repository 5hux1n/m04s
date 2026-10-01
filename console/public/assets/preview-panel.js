'use strict';
// A second view of the existing preview. It never edits or submits print content.
const PreviewPanel=(()=>{
  const $=id=>document.getElementById(id);
  let opened=false,page='editor',position=null,returnFocus=null,drag=null,initialized=false;

  function viewport() {
    const view=window.visualViewport;
    return {left:view?.offsetLeft||0,top:view?.offsetTop||0,width:view?.width||document.documentElement.clientWidth,height:view?.height||window.innerHeight};
  }
  function place(x,y) {
    const panel=$('floatingPreview'),view=viewport(),rect=panel.getBoundingClientRect();
    const right=Math.max(view.left+12,view.left+view.width-rect.width-12);
    const bottom=Math.max(view.top+12,view.top+view.height-rect.height-12);
    position={x:Math.max(view.left+12,Math.min(right,x)),y:Math.max(view.top+12,Math.min(bottom,y))};
    panel.style.setProperty('--float-x',position.x+'px');panel.style.setProperty('--float-y',position.y+'px');
  }
  function fit() {
    if(!opened||$('floatingPreview').hidden)return;
    const panel=$('floatingPreview'),view=viewport();
    panel.style.setProperty('--float-available-height',Math.max(48,view.height-24)+'px');
    const rect=panel.getBoundingClientRect();
    place(position?.x??view.left+view.width-rect.width-24,position?.y??view.top+72);
  }
  function syncState() {
    $('floatingPreviewDimensions').textContent=$('paperDimensions').textContent;
    $('floatingPreviewState').textContent=$('previewState').textContent;
  }
  function sync() {
    syncState();
    if(!opened||$('floatingPreview').hidden)return;
    const source=$('previewCanvas'),target=$('floatingPreviewCanvas');
    target.width=source.width;target.height=source.height;
    target.getContext('2d').drawImage(source,0,0);
  }
  function visibility() {
    $('floatingPreview').hidden=!opened||page!=='editor';
    $('previewLauncher').hidden=page!=='editor'||opened;
    $('floatingPreviewButton').textContent=opened?'收回':'浮窗';
    $('floatingPreviewButton').setAttribute('aria-expanded',String(opened));
    $('previewLauncher').setAttribute('aria-expanded',String(opened));
    if(opened&&page==='editor'){sync();fit();}
  }
  function open(trigger) {
    returnFocus=trigger;opened=true;visibility();
    $('floatingPreviewHandle').focus({preventScroll:true});
  }
  function close() {
    opened=false;drag=null;$('floatingPreview').classList.remove('dragging');visibility();
    $('floatingPreviewCanvas').width=1;$('floatingPreviewCanvas').height=1;
    returnFocus?.focus({preventScroll:true});
  }
  function setPage(value) {page=value;visibility();}
  function init() {
    if(initialized)return;initialized=true;
    const panel=$('floatingPreview'),handle=$('floatingPreviewHandle');
    $('floatingPreviewButton').onclick=e=>opened?close():open(e.currentTarget);
    $('previewLauncher').onclick=e=>open(e.currentTarget);
    $('closeFloatingPreview').onclick=close;
    $('minimizeFloatingPreview').onclick=e=>{
      const minimized=panel.classList.toggle('minimized');
      e.currentTarget.textContent=minimized?'＋':'−';
      e.currentTarget.setAttribute('aria-label',minimized?'展开浮动预览':'收起浮动预览');
      e.currentTarget.setAttribute('aria-expanded',String(!minimized));fit();
    };
    handle.onpointerdown=e=>{
      if(e.button!==0||e.target.closest('button'))return;
      const rect=panel.getBoundingClientRect();drag={id:e.pointerId,x:e.clientX-rect.left,y:e.clientY-rect.top};
      handle.setPointerCapture(e.pointerId);panel.classList.add('dragging');e.preventDefault();
      handle.focus({preventScroll:true});
    };
    handle.onpointermove=e=>{if(drag?.id===e.pointerId)place(e.clientX-drag.x,e.clientY-drag.y);};
    const endDrag=()=>{drag=null;panel.classList.remove('dragging');};
    handle.onpointerup=handle.onpointercancel=handle.onlostpointercapture=endDrag;
    handle.onkeydown=e=>{
      if(e.target!==handle)return;
      if(e.key==='Escape'){e.preventDefault();close();return;}
      const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];
      if(delta){e.preventDefault();const rect=panel.getBoundingClientRect(),step=e.shiftKey?30:10;place(rect.left+delta[0]*step,rect.top+delta[1]*step);}
    };
    window.addEventListener('resize',fit);
    window.visualViewport?.addEventListener('resize',fit);
    window.visualViewport?.addEventListener('scroll',fit);
    if(window.ResizeObserver)new ResizeObserver(fit).observe(panel);
    visibility();
  }
  return {init,sync,syncState,setPage};
})();
