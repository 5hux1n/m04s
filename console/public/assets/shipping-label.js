'use strict';
// Physical label geometry is independent of the BLE printer identity.
const ShippingLabel = (() => {
  const dotsMM = 300 / 25.4;
  function geometry(layout, paperDots, sourceWidth, sourceHeight) {
    const width = Number(layout.labelWidth), height = Number(layout.labelHeight);
    const inset = Number(layout.labelInset ?? 0);
    if (![width,height,inset].every(Number.isFinite) || width < 20 || width > 105 || height < 30 || height > 1000 || inset < 0 || inset > 10)
      throw new Error('面单宽度需为 20–105 mm，长度 30–1000 mm，内边距 0–10 mm');
    const labelDots = Math.round(width*dotsMM), heightDots = Math.round(height*dotsMM);
    if (labelDots > paperDots) throw new Error('面单宽度超过当前纸卷可打印范围，请选择 110 mm 纸卷');
    const availableWidth=labelDots-2*inset*dotsMM, availableHeight=heightDots-2*inset*dotsMM;
    if (availableWidth<=0 || availableHeight<=0 || !(sourceWidth>0 && sourceHeight>0)) throw new Error('面单尺寸或内边距无效');
    const scale=Math.min(availableWidth/sourceWidth,availableHeight/sourceHeight);
    const drawWidth=sourceWidth*scale,drawHeight=sourceHeight*scale;
    return {width:paperDots,height:heightDots,x:(paperDots-drawWidth)/2,y:(heightDots-drawHeight)/2,drawWidth,drawHeight};
  }
  return {geometry};
})();
if (typeof module !== 'undefined') module.exports = ShippingLabel;
