import mammoth from 'mammoth/mammoth.browser.js';
const textBlock=text=>({id:crypto.randomUUID(),type:'text',text:text.slice(0,20000),size:11,align:'left',font:'sans',lineHeight:1.45,gap:3});
const imageBlock=id=>({id:crypto.randomUUID(),type:'image',asset:id,width:100,align:'center',rotation:0,crop:'original',gap:3});
export {pageNumbers} from './page-ranges.mjs';
import {pageNumbers} from './page-ranges.mjs';
export async function importDocument(file,range,saveAsset){
  const name=file.name.toLowerCase(),buffer=await file.arrayBuffer();let blocks=[],pages=[];
  if(name.endsWith('.pdf')){
    const pdfjs=await import('/vendor/pdf.mjs');pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.mjs';
    const task=pdfjs.getDocument({data:new Uint8Array(buffer),cMapUrl:'/vendor/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/standard_fonts/',wasmUrl:'/vendor/wasm/',isEvalSupported:false});
    const pdf=await task.promise;
    try{for(const number of pageNumbers(range||'',pdf.numPages)){
      const page=await pdf.getPage(number),original=page.getViewport({scale:1});
      // Up to 300 DPI; preserve label barcode resolution and bound large input pages.
      const scale=Math.min(300/72,3000/original.width,Math.sqrt(16000000/(original.width*original.height)));
      const viewport=page.getViewport({scale}),canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
      await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('PDF 页面转换失败');
      pages.push({number,blocks:[imageBlock(await saveAsset(blob))]});page.cleanup();
    }}finally{await task.destroy();}
    blocks=pages[0].blocks;
  }else if(name.endsWith('.docx')){
    const result=await mammoth.convertToHtml({arrayBuffer:buffer},{convertImage:mammoth.images.imgElement(async image=>({src:'asset:'+await saveAsset(new Blob([await image.readAsArrayBuffer()],{type:image.contentType}))}))});
    const parsed=new DOMParser().parseFromString(result.value,'text/html');
    for(const node of parsed.body.querySelectorAll('p,h1,h2,h3,li,tr,img')){
      if(node.tagName==='IMG'){if(node.getAttribute('src')?.startsWith('asset:'))blocks.push(imageBlock(node.getAttribute('src').slice(6)));}
      else if(!node.parentElement.closest('li,tr')&&node.textContent.trim())blocks.push(textBlock(node.textContent.trim()));
    }
  }else if(name.endsWith('.txt'))blocks=[textBlock(new TextDecoder().decode(buffer))];
  else throw Error('网页版支持 PDF、DOCX、TXT；旧版 DOC 请先另存为 PDF 或 DOCX');
  if(!blocks.length||blocks.length>100)throw Error('没有可导入的内容，或内容块超过 100 个');
  return {title:file.name,blocks,pages,note:'已在本机导入，文件没有上传到服务器。PDF 保留版式，DOCX 重新排版。'};
}
export async function importWeb(url){
  let target;try{target=new URL(url);}catch{throw Error('网页地址无效');}
  if(!['https:','http:'].includes(target.protocol)||target.username||target.password)throw Error('请填写公开网页 HTTP／HTTPS 地址');
  let response;try{response=await fetch(target,{credentials:'omit',signal:AbortSignal.timeout(15000)});}catch{throw Error('该网站不允许浏览器跨站读取。可将页面另存为 PDF 后上传，或复制正文到文字块。');}
  if(!response.ok)throw Error('网页读取失败');
  if(response.headers.get('content-length')>2000000)throw Error('网页过大');
  const reader=response.body.getReader();let total=0,parts=[];while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>2000000){await reader.cancel();throw Error('网页过大');}parts.push(value);}
  const parsed=new DOMParser().parseFromString(await new Blob(parts).text(),'text/html');parsed.querySelectorAll('script,style,nav,footer,header,form').forEach(node=>node.remove());
  const root=parsed.querySelector('article,main')||parsed.body,blocks=[];
  for(const node of root.querySelectorAll('h1,h2,h3,p,li'))if(!node.parentElement.closest('li')&&node.textContent.trim())blocks.push(textBlock(node.textContent.trim()));
  if(!blocks.length||blocks.length>100)throw Error('正文不可读取或过长，请另存为 PDF 导入');
  return {title:parsed.title||target.hostname,blocks,sourceUrl:target.href,note:'已导入公开正文；跨站图片请下载后上传。'};
}
