<?php $csrf=htmlspecialchars(token(),ENT_QUOTES,'UTF-8'); ?>
<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="console-token" content="<?=$csrf?>"><title>M04S · 打印工作台</title><link rel="stylesheet" href="/assets/style.css"><script src="/assets/image-tools.js" defer></script><script src="/assets/preview-panel.js" defer></script><script src="/assets/shipping-label.js" defer></script><script src="/assets/app.js" defer></script></head>
<body>
<div class="shell">
<aside class="sidebar">
 <a class="brand" href="/" aria-label="M04S 打印工作台"><span class="brand-mark"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 12V5h16v7M8 23H5V12h22v11h-3M8 19h16v9H8z"/><path d="M22 15h1"/></svg></span><span>M04S<small>打印工作台</small></span></a>
 <div class="nav-caption">工作空间</div>
 <nav aria-label="主导航">
  <button class="nav-item active" data-page="editor"><span class="nav-icon">▤</span>图文编辑器</button>
  <button class="nav-item" data-page="device"><span class="nav-icon">◉</span>设备状态</button>
  <button class="nav-item" data-page="settings"><span class="nav-icon">☷</span>打印设置</button>
  <button class="nav-item" data-page="history"><span class="nav-icon">↺</span>打印记录<span id="queueBadge" class="nav-badge" hidden>0</span></button>
 </nav>
 <div class="sidebar-note"><span class="tiny-label">从想法，到纸面</span><p>编辑、预览、打印。<br>让每一张纸都恰到好处。</p></div>
 <div class="service-status"><i id="serviceDot" class="dot"></i><div id="serviceLabel">正在检查打印服务<small>本机工作区</small></div></div>
</aside>
<div class="workspace">
<header class="topbar"><div><span class="breadcrumb">工作空间 <span>/</span> <b id="pageTitle">图文编辑器</b></span></div><div class="header-actions"><span class="connection-chip" id="connectionChip"><i class="dot"></i><span>未连接</span></span><button class="btn small" id="connectionButton">连接打印机</button></div></header>
<main>
<section id="page-editor" class="page active">
 <div class="page-heading"><div><div class="eyebrow">CREATE & PRINT</div><h1>把内容，变成纸上的作品。</h1><p>自由组合文字与图片，边编辑，边看见最终效果。</p></div><div class="heading-actions"><button class="btn" id="downloadButton">↓ 导出图片</button><button class="btn primary" id="printButton" disabled>打印作品 <span>↗</span></button></div></div>
 <div class="editor-layout">
  <div class="editor-column">
   <section class="card document-card"><div class="card-heading"><h2>当前作品</h2><span id="saveState" class="muted small-text">尚未保存</span></div>
    <input id="documentTitle" class="title-input" aria-label="作品名称" value="我的第一张作品" maxlength="100">
    <div class="document-tools"><select id="draftSelect" aria-label="打开草稿"><option value="">选择已保存的草稿</option></select><button class="btn small" id="newDocumentButton">新建</button><button class="icon-button" id="deleteDraftButton" aria-label="删除当前草稿" title="删除当前草稿">×</button></div>
   </section>
   <section class="card import-card"><div class="card-heading"><h2>网页与文档打印</h2><span class="muted small-text">导入后预览</span></div>
    <label class="sr-only" for="webUrl">网页地址</label><input id="webUrl" type="url" placeholder="粘贴网页链接 https://…"><div class="import-actions"><button class="btn" id="importWebButton">导入网页</button><button class="btn" id="importDocumentButton">上传文档</button></div>
    <div class="form-grid" style="margin-top:12px"><label class="small-text muted">PDF 页码范围<input id="importPageRange" placeholder="全部，或 1-3,5" maxlength="100"></label><label class="check-label"><input id="webImages" type="checkbox" checked>包含网页图片</label></div>
    <input id="documentFile" type="file" accept=".pdf,.docx,.doc,.txt" hidden><p class="field-note" id="importState">PDF 保留页面版式；Word、TXT 和网页正文可继续编辑。导入会创建新草稿。</p>
    <div id="importPages" class="import-pages" hidden><div class="form-grid"><label class="small-text muted">文档页<select id="importPageSelect"></select></label><button class="btn" id="printAllPages">打印全部导入页</button></div></div>
   </section>
   <section class="card editor-card"><div class="card-heading"><h2>内容编辑</h2><span class="muted small-text" id="blockCount">0 个内容块</span></div>
    <div class="insert-toolbar"><button class="btn" id="addTextButton"><b>T</b> 文字</button><button class="btn" id="addImageButton">▧ 图片</button><button class="btn" id="addDividerButton">— 分隔线</button><button class="btn" id="addSpaceButton">↕ 留白</button></div>
    <input type="file" id="imageFile" accept="image/png,image/jpeg,image/webp" hidden>
    <div id="blocks" class="blocks"></div><div class="editor-help">使用 ↑ ↓ 调整顺序。所有修改会自动保存为草稿。</div>
   </section>
  </div>
  <div class="preview-column">
   <section class="card preview-card"><div class="card-heading"><div class="preview-heading"><span class="live-indicator"></span><h2>实时打印预览</h2></div><div class="preview-tools"><button class="btn small" id="floatingPreviewButton" aria-controls="floatingPreview" aria-expanded="false" title="打开可以移动的预览浮窗">浮窗</button><button class="icon-button" id="zoomOut" aria-label="缩小预览">−</button><span id="zoomLabel">100%</span><button class="icon-button" id="zoomIn" aria-label="放大预览">＋</button></div></div>
    <div class="paper-stage"><div class="width-ruler"><span id="widthRuler">50.1 mm · 592 点</span></div><div class="paper-viewport" id="paperViewport"><canvas id="previewCanvas" width="592" height="700" aria-label="当前作品的黑白打印预览"></canvas></div><div id="previewEmpty" hidden>添加文字或图片，开始创作</div></div>
    <div class="preview-footer"><span id="paperDimensions">正在生成预览</span><span id="previewState">黑白点阵</span></div>
   </section>
   <section class="card layout-card"><div class="card-heading"><h2>纸面与图像</h2><span class="small-text muted">预览即打印内容</span></div><div class="form-grid">
    <label class="full-width">打印版式<select id="labelPreset"><option value="none">普通图文</option><option value="76x130">快递面单 · 76 × 130 mm</option><option value="100x180">快递面单 · 100 × 180 mm</option><option value="custom">自定义面单</option></select></label>
    <label>面单宽度（mm）<input id="labelWidth" type="number" min="20" max="105" value="76" disabled></label><label>面单长度（mm）<input id="labelHeight" type="number" min="30" max="1000" value="130" disabled></label>
    <label>面单内边距（mm）<input id="labelInset" type="number" min="0" max="10" step="0.5" value="0" disabled></label>
    <div class="full-width"><button class="btn" id="uploadLabelButton">上传面单 PDF／图片</button><input id="labelFile" type="file" accept=".pdf,image/png,image/jpeg" hidden></div>
    <p class="field-note full-width">面单模式：每页一张完整 PDF 页面或图片，等比例居中，不裁剪。两种预设默认使用 110 mm 连续纸；固定长度为图像长度，收尾走纸与间隙定位仍待实测。此功能不代表拼多多 App 已能直接连接。</p>
    <label class="full-width">纸张宽度<select id="paperWidth"><option value="53">53 mm · 小卷纸</option><option value="80">80 mm · 中卷纸</option><option value="110">110 mm · 大卷纸</option><option value="legacy">53 mm · 原有打印宽度</option></select></label>
    <label>纸面高度<select id="heightMode"><option value="auto">随内容自动延长</option><option value="fixed">固定高度</option></select></label><label>高度（mm）<input id="paperHeight" type="number" min="15" max="1000" value="60" disabled></label>
    <label>边距（mm）<input id="paperMargin" type="number" min="0" max="15" step="0.5" value="3"></label><label>图像处理<select id="processing"><option value="threshold">文字清晰</option><option value="dither">照片抖动</option></select></label>
   </div><label class="range-label">黑白阈值 <output id="thresholdValue">180</output><input id="threshold" type="range" min="40" max="240" value="180"></label><p class="field-note" id="paperWidthNote">请选择与打印机中已安装纸卷一致的宽度。</p></section>
   <div class="inline-job" id="activeJob" hidden><span class="live-indicator"></span><div><b id="activeJobTitle">正在打印</b><span id="activeJobPhase"></span></div><progress id="activeJobProgress" max="1" value="0"></progress></div>
  </div>
 </div>
</section>
<section id="page-device" class="page">
 <div class="page-heading"><div><div class="eyebrow">YOUR PRINTER</div><h1>设备状态</h1><p>查看打印机当前状态，保持每次打印都在准备之中。</p></div><button class="btn" id="refreshStatusButton">↻ 刷新状态</button></div>
 <div class="device-layout"><section class="card printer-card"><div class="printer-illustration"><svg viewBox="0 0 320 220" aria-hidden="true"><defs><linearGradient id="printerBody" x2="0" y2="1"><stop stop-color="#ffffff"/><stop offset="1" stop-color="#dedede"/></linearGradient></defs><ellipse cx="160" cy="190" rx="109" ry="13" fill="#e3e3e3"/><rect x="68" y="76" width="184" height="110" rx="27" fill="url(#printerBody)" stroke="#bbbbbb" stroke-width="2"/><path d="M77 122h166" stroke="#c2c2c2"/><rect x="92" y="116" width="136" height="8" rx="4" fill="#424242"/><path d="M111 120V36h99v84" fill="#fff" stroke="#cecece"/><path d="M125 53h70m-70 12h54m-54 12h66m-66 12h40" stroke="#bcbcbc" stroke-width="3"/><circle cx="217" cy="148" r="6" fill="#6e6e6e"/><text x="89" y="153" fill="#737373" font-size="14" font-family="sans-serif">M04S</text></svg></div><span class="device-type">热敏打印机</span><h2>M04S</h2><p id="devicePhase">尚未连接</p><button class="btn primary" id="deviceConnectButton">连接打印机</button><div id="deviceError" class="notice error" hidden></div><p class="field-note">请打开打印机，并断开手机 App 的连接。</p></section>
 <div class="device-info"><div class="status-grid">
  <div class="card status-card"><span>电池电量</span><strong id="batteryValue">—</strong><div class="battery-track"><i id="batteryBar"></i></div></div>
  <div class="card status-card"><span>上盖状态</span><strong id="coverValue">未知</strong><small>打印前请合上上盖</small></div>
  <div class="card status-card"><span>纸张检测</span><strong id="paperValue">未知</strong><small>来自设备的实时回应</small></div>
  <div class="card status-card"><span>打印头温度</span><strong id="temperatureValue">未知</strong><small>温度状态，不是摄氏度</small></div>
 </div><section class="card"><div class="card-heading"><h2>设备信息</h2><span class="muted small-text" id="statusUpdated">尚未读取</span></div><dl class="device-details"><div><dt>纸张模式</dt><dd id="devicePaperMode">—</dd></div><div><dt>自动关机</dt><dd id="deviceAutoOff">—</dd></div><div><dt>最大打印宽度</dt><dd>1248 点 / 约 105.7 mm</dd></div><div><dt>分辨率</dt><dd>300 DPI</dd></div></dl></section><section class="card feed-card"><div><h2>空白走纸</h2><p>输出一段空白纸，便于留边或撕纸。</p></div><div class="feed-controls"><label class="sr-only" for="feedLength">走纸长度（mm）</label><input id="feedLength" type="number" value="10" min="1" max="200"><span>mm</span><button class="btn" id="feedButton">走纸</button></div><p class="field-note">长度为点阵长度，设备还会执行正常的末尾走纸。</p></section></div></div>
</section>
<section id="page-settings" class="page">
 <div class="page-heading"><div><div class="eyebrow">MAKE IT YOURS</div><h1>打印设置</h1><p>选择适合内容与纸张的参数，保存为下一次打印的默认值。</p></div><button class="btn primary" id="saveSettingsButton">保存默认设置</button></div>
 <div class="settings-layout"><div><section class="card"><div class="card-heading"><h2>打印浓度</h2><span class="small-text muted">已通过纸面验证</span></div><div class="density-options" id="densityOptions">
  <label><input type="radio" name="density" value="light"><span class="density-sample light">Aa</span><b>淡</b><small>轻盈清晰</small></label><label><input type="radio" name="density" value="medium" checked><span class="density-sample medium">Aa</span><b>中</b><small>日常打印</small></label><label><input type="radio" name="density" value="dark"><span class="density-sample dark">Aa</span><b>浓</b><small>更深的黑色</small></label><label><input type="radio" name="density" value="special"><span class="density-sample special">Aa</span><b>专用</b><small>官方专用档位</small></label>
 </div></section><section class="card"><div class="card-heading"><h2>纸张与份数</h2></div><div class="form-grid"><label class="full-width">默认纸张宽度（新作品）<select id="settingPaperWidth"><option value="53">53 mm</option><option value="80">80 mm</option><option value="110">110 mm</option><option value="legacy">53 mm · 原有打印宽度</option></select></label><label>设备纸张模式<select id="settingPaper"><option value="">保持设备当前模式</option><option value="continuous">连续纸</option><option value="gap">间隙模式</option><option value="black-mark">黑标模式</option></select></label><label>打印份数<input id="settingCopies" type="number" min="1" max="20" value="1"></label></div><p class="field-note">间隙与黑标指令可设置和回读，尚未使用对应介质验证自动定位。</p></section>
 <section class="card"><div class="card-heading"><h2>自动关机</h2></div><div class="form-grid"><label>空闲后关闭设备<select id="autoOffMinutes"><option value="0">不自动关机</option><option value="5">5 分钟</option><option value="10" selected>10 分钟</option><option value="15">15 分钟</option><option value="30">30 分钟</option><option value="60">60 分钟</option><option value="120">120 分钟</option></select></label><div class="align-end"><button class="btn" id="applyDeviceSettingsButton">应用到设备</button></div></div><p class="field-note">“应用到设备”会设置纸张、浓度与自动关机时间；“保存默认设置”只保存工作台偏好。</p></section>
 </div><div><section class="card settings-summary"><span class="eyebrow">PRINT PROFILE</span><h2>每一张，都保持一致。</h2><div class="profile-art"><span>Aa</span><div></div></div><p>浓度和图像处理是两件事：浓度控制打印深浅，图像处理决定哪些像素打印为黑色。</p><ul><li>当前作品的处理效果可在编辑器中实时查看。</li><li>设置会应用到后续提交的任务。</li><li>已排队的任务保留提交时的设置。</li></ul></section>
 <details class="card advanced-settings"><summary>高级参数 <span>实验</span></summary><label>浓度系数（100 = 1.0 倍）<input id="settingCoefficient" type="number" min="1" max="255" placeholder="跟随浓度档位"></label><label>速度协议值<input id="settingSpeed" type="number" min="1" max="255" placeholder="不设置"></label><p class="field-note">M04S 的速度值 1、5、25 实测没有明显调速效果。这里保留实验入口，不代表快慢档位或毫米/秒。</p></details></div></div>
</section>
<section id="page-history" class="page">
 <div class="page-heading"><div><div class="eyebrow">FROM SCREEN TO PAPER</div><h1>打印记录</h1><p>任务进度、设备操作与完成结果，都有迹可循。</p></div><button class="btn" id="refreshHistoryButton">↻ 刷新记录</button></div>
 <div class="history-stats"><div class="card"><span>打印完成</span><strong id="completedCount">0</strong></div><div class="card"><span>等待 / 处理中</span><strong id="pendingCount">0</strong></div><div class="card"><span>失败任务</span><strong id="failedCount">0</strong></div></div>
 <section class="card history-card"><div class="table-scroll"><table><thead><tr><th>任务</th><th>时间</th><th>状态</th><th>操作</th></tr></thead><tbody id="historyBody"></tbody></table></div><div id="historyEmpty" class="empty-state"><span>▤</span><h2>第一张作品，从这里开始</h2><p>提交打印后，可在这里查看进度与结果。</p><button class="btn" data-go="editor">去编辑作品</button></div></section>
</section>
</main><footer class="workspace-footer"><span>M04S PRINT STUDIO</span><span>内容和记录保存在本机工作区</span></footer>
</div></div>
<div class="toast" id="toast" role="status" hidden></div>
<button class="btn preview-launcher" id="previewLauncher" aria-controls="floatingPreview" aria-expanded="false" hidden>▧ 预览浮窗</button>
<section class="floating-preview" id="floatingPreview" aria-label="浮动打印预览" hidden>
 <div class="floating-preview-header" id="floatingPreviewHandle" tabindex="0" aria-label="移动预览浮窗：拖动顶部或使用方向键"><div><span class="drag-grip" aria-hidden="true">⠿</span><b>浮动预览</b></div><div class="floating-preview-actions"><button class="icon-button" id="minimizeFloatingPreview" aria-label="收起浮动预览" aria-expanded="true">−</button><button class="icon-button" id="closeFloatingPreview" aria-label="关闭浮动预览">×</button></div></div>
 <div class="floating-preview-body"><canvas id="floatingPreviewCanvas" width="592" height="700" aria-label="与编辑器同步的黑白打印预览"></canvas></div>
 <div class="floating-preview-footer"><span id="floatingPreviewDimensions"></span><span id="floatingPreviewState"></span><small>拖动顶部移动 · 拖动右下角调整大小</small></div>
</section>
<dialog id="jobDialog"><div class="card-heading"><h2 id="jobDialogTitle">任务详情</h2><button class="icon-button" id="closeJobDialog" aria-label="关闭详情">×</button></div><div id="jobDialogContent"></div></dialog>
<dialog id="confirmDialog"><h2 id="confirmTitle">确认操作</h2><p id="confirmMessage"></p><div class="dialog-actions"><button class="btn" id="confirmCancel">取消</button><button class="btn primary" id="confirmOkay">确认</button></div></dialog>
<dialog id="cropDialog"><h2>框选裁剪</h2><p>在图片上拖动选取要保留的区域，或输入百分比。</p><div class="crop-stage"><canvas id="cropCanvas" aria-label="拖动框选图片裁剪区域"></canvas></div><div class="form-grid crop-fields"><label>左侧（%）<input id="crop-x" type="number" min="0" max="98"></label><label>顶部（%）<input id="crop-y" type="number" min="0" max="98"></label><label>宽度（%）<input id="crop-width" type="number" min="2" max="100"></label><label>高度（%）<input id="crop-height" type="number" min="2" max="100"></label></div><div class="dialog-actions"><button class="btn" id="resetCrop">恢复全图</button><button class="btn" id="cancelCrop">取消</button><button class="btn primary" id="applyCrop">应用裁剪</button></div></dialog>
</body></html>
