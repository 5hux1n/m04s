export function pageNumbers(value,count){
  if(!value.trim()){if(count>20)throw Error('PDF 超过 20 页，请填写页码范围');return Array.from({length:count},(_,i)=>i+1);}
  const selected=new Set();for(const part of value.split(',')){const match=part.trim().match(/^(\d+)(?:-(\d+))?$/);if(!match)throw Error('页码格式无效');const start=Number(match[1]),end=Number(match[2]||match[1]);if(start<1||end<start||end>count)throw Error('页码超出范围');for(let n=start;n<=end;n++)selected.add(n);}
  if(selected.size>20)throw Error('每次最多导入 20 页');return [...selected].sort((a,b)=>a-b);
}
