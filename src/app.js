import * as model from './crop-model.js';

const $ = (id) => document.getElementById(id);
const e2e = new URLSearchParams(location.search).get('e2e') === '1';
const CURSOR_CLASSES = ['is-move', 'is-nw', 'is-n', 'is-ne', 'is-e', 'is-se', 'is-s', 'is-sw', 'is-w', 'is-dragging'];

const state = {
  fileName: '',
  fileSize: 0,
  bytes: null,
  session: null,
  pageCount: 0,
  pageNumber: 1,
  pageWidth: 0,
  pageHeight: 0,
  pageMeta: null,
  crop: null,
  ratioId: 'free',
  ratio: null,
  unit: 'px',
  layout: null,
  backing: 1,
  rendered: false,
  busy: false,
  docGeneration: 0,
};

const crops = new Map();
let engine;
let exporterModule;
let openToken = 0;
let showToken = 0;
let stageGen = 0;
let drag = null;
let dragDepth = 0;
let thumbObserver;

function snapshot() {
  let cropClient = null;
  if (state.layout && state.crop) {
    const rect = $('overlayCanvas').getBoundingClientRect();
    const view = model.pageRectToView(state.crop, state.layout);
    cropClient = {
      x: rect.left + view.x + view.width / 2,
      y: rect.top + view.y + view.height / 2,
      width: view.width,
      height: view.height,
    };
  }
  return {
    fileName: state.fileName,
    fileSize: state.fileSize,
    pageCount: state.pageCount,
    pageNumber: state.pageNumber,
    crop: state.crop ? { ...state.crop } : null,
    rendered: state.rendered,
    busy: state.busy,
    error: $('errorText').textContent,
    cropClient,
  };
}

function publish() {
  if (!e2e) return;
  window.__pdfTools = window.__pdfTools || { lastExport: null };
  window.__pdfTools.getSnapshot = snapshot;
  window.__pdfTools.booted = true;
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function selectedFormat() {
  return document.querySelector('input[name="format"]:checked')?.value || 'pdf';
}

function showError(message, canRetry = false) {
  $('errorBanner').hidden = false;
  $('errorText').textContent = message;
  $('btnRetry').hidden = !canRetry;
  publish();
}

function clearError() {
  $('errorBanner').hidden = true;
  $('errorText').textContent = '';
  $('btnRetry').hidden = true;
}

function showWarning(message) {
  $('riskBanner').hidden = false;
  $('riskText').textContent = message;
}

function setBusy(busy, label, progress) {
  state.busy = busy;
  document.body.classList.toggle('is-busy', busy);
  $('progressWrap').hidden = !busy;
  if (busy) {
    $('progressTrack').style.setProperty('--progress', String(Math.min(1, Math.max(0, progress ?? 0))));
    $('progressLabel').textContent = label || '正在处理…';
  }
  sync();
}

function syncNumbers() {
  if (!state.crop) return;
  const values = model.rectToUnitValues(state.crop, state.unit);
  for (const [id, key] of [['cropX', 'x'], ['cropY', 'y'], ['cropW', 'width'], ['cropH', 'height']]) {
    const field = $(id);
    if (document.activeElement === field) continue;
    field.value = model.formatMeasure(values[key]);
  }
}

function syncPill() {
  if (!state.crop) return;
  const mm = model.rectToUnitValues(state.crop, 'mm');
  const px = model.rectToUnitValues(state.crop, 'px');
  $('pillMm').textContent = `${model.formatMeasure(mm.width)} × ${model.formatMeasure(mm.height)} mm`;
  $('pillPx').textContent = `${model.formatMeasure(px.width)} × ${model.formatMeasure(px.height)} px`;
}

function sync() {
  const hasDoc = Boolean(state.session);
  document.body.classList.toggle('has-doc', hasDoc);
  $('fileMeta').hidden = !hasDoc;
  $('fileEmpty').hidden = hasDoc;
  $('dropzone').hidden = hasDoc;
  $('dimPill').hidden = !hasDoc;
  $('btnExport').disabled = !hasDoc || state.busy;
  $('btnPrev').disabled = !hasDoc || state.busy || state.pageNumber <= 1;
  $('btnNext').disabled = !hasDoc || state.busy || state.pageNumber >= state.pageCount;
  $('pageInput').disabled = !hasDoc || state.busy;
  $('pageInput').max = String(Math.max(1, state.pageCount));
  if (document.activeElement !== $('pageInput')) $('pageInput').value = hasDoc ? String(state.pageNumber || 1) : '';
  $('pageCountLabel').textContent = hasDoc ? `/ ${state.pageCount}` : '/ —';
  if (!state.busy) $('railEmpty').hidden = hasDoc || state.pageCount > 0;
  for (const id of ['btnSelectAll', 'btnReset', 'btnCenter', 'cropX', 'cropY', 'cropW', 'cropH']) {
    $(id).disabled = !hasDoc || state.busy;
  }
  if (hasDoc) {
    $('fileName').textContent = state.fileName;
    $('fileSize').textContent = formatBytes(state.fileSize);
    $('filePages').textContent = `${state.pageCount} 页`;
  }
  const format = selectedFormat();
  $('dpiRow').hidden = format === 'pdf';
  $('jpgRow').hidden = format !== 'jpg';
  $('jpgQualityVal').textContent = `${Math.round(Number($('jpgQuality').value) * 100)}%`;
  for (const button of $('presetList').querySelectorAll('.preset-btn')) {
    const on = button.dataset.id === state.ratioId;
    button.classList.toggle('is-active', on);
    button.setAttribute('aria-pressed', String(on));
    button.disabled = !hasDoc || state.busy;
  }
  for (const button of $('thumbList').querySelectorAll('.thumb')) {
    const on = Number(button.dataset.page) === state.pageNumber;
    button.classList.toggle('is-active', on);
    if (on) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  $('unitPx').classList.toggle('is-active', state.unit === 'px');
  $('unitMm').classList.toggle('is-active', state.unit === 'mm');
  $('unitPx').setAttribute('aria-pressed', String(state.unit === 'px'));
  $('unitMm').setAttribute('aria-pressed', String(state.unit === 'mm'));
  syncNumbers();
  syncPill();
  publish();
}

function drawOverlay() {
  const canvas = $('overlayCanvas');
  const cssWidth = $('stage').clientWidth;
  const cssHeight = $('stage').clientHeight;
  const backing = state.backing || model.backingStoreScale(cssWidth, cssHeight, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(cssWidth * backing));
  canvas.height = Math.max(1, Math.round(cssHeight * backing));
  const context = canvas.getContext('2d');
  context.setTransform(backing, 0, 0, backing, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);
  if (!state.layout || !state.crop) return;
  const view = model.pageRectToView(state.crop, state.layout);
  context.fillStyle = 'rgba(6, 7, 10, 0.62)';
  context.beginPath();
  context.rect(0, 0, cssWidth, cssHeight);
  context.rect(view.x, view.y, view.width, view.height);
  context.fill('evenodd');
  context.strokeStyle = 'rgba(255,255,255,0.28)';
  context.lineWidth = 1;
  context.beginPath();
  const thirds = [
    [view.x + view.width / 3, view.y, view.x + view.width / 3, view.y + view.height],
    [view.x + (view.width * 2) / 3, view.y, view.x + (view.width * 2) / 3, view.y + view.height],
    [view.x, view.y + view.height / 3, view.x + view.width, view.y + view.height / 3],
    [view.x, view.y + (view.height * 2) / 3, view.x + view.width, view.y + (view.height * 2) / 3],
  ];
  for (const [x1, y1, x2, y2] of thirds) {
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
  }
  context.stroke();
  context.strokeStyle = '#6366f1';
  context.lineWidth = 1.5;
  context.strokeRect(view.x + 0.5, view.y + 0.5, Math.max(0, view.width - 1), Math.max(0, view.height - 1));
  for (const handle of model.handlePoints(view)) {
    context.fillStyle = '#ffffff';
    context.strokeStyle = '#6366f1';
    context.lineWidth = 1.5;
    context.beginPath();
    context.rect(handle.x - 4, handle.y - 4, 8, 8);
    context.fill();
    context.stroke();
  }
}

function rememberCrop() {
  if (state.pageNumber && state.crop) crops.set(state.pageNumber, { ...state.crop });
}

function setCursor(name) {
  const stage = $('stage');
  stage.classList.remove(...CURSOR_CLASSES);
  if (name) stage.classList.add(name);
}

function clientToView(event) {
  const rect = $('overlayCanvas').getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function updateCursor(view) {
  if (!state.layout || !state.crop || drag) return;
  const hit = model.hitTestCrop(view.x, view.y, model.pageRectToView(state.crop, state.layout));
  if (hit.type === 'move') setCursor('is-move');
  else if (hit.type === 'handle') setCursor(`is-${hit.handle}`);
  else setCursor('');
}

async function renderStage() {
  const session = state.session;
  const pageNumber = state.pageNumber;
  const generation = ++stageGen;
  const cssWidth = $('stage').clientWidth;
  const cssHeight = $('stage').clientHeight;
  if (!session || cssWidth < 2 || cssHeight < 2) return;
  state.rendered = false;
  try {
    const result = await session.renderStage($('pageCanvas'), pageNumber, {
      cssWidth,
      cssHeight,
      dpr: window.devicePixelRatio || 1,
    });
    if (generation !== stageGen || session !== state.session) return;
    if (!result || result.cancelled) return;
    state.layout = result.layout;
    state.backing = result.backing;
    state.rendered = true;
    drawOverlay();
    sync();
  } catch (error) {
    if (generation !== stageGen || session !== state.session) return;
    showError('无法渲染当前页。文件可能包含不受支持的内容。');
  }
}

async function showPage(pageNumber) {
  const session = state.session;
  const token = ++showToken;
  if (!session) return;
  state.rendered = false;
  state.pageNumber = pageNumber;
  sync();
  const page = await session.getPage(pageNumber);
  if (token !== showToken || session !== state.session) return;
  const meta = engine.pageMeta(page);
  state.pageMeta = meta;
  state.pageWidth = meta.pageWidth;
  state.pageHeight = meta.pageHeight;
  state.crop = crops.has(pageNumber)
    ? model.enforceBounds(crops.get(pageNumber), meta.pageWidth, meta.pageHeight, state.ratio)
    : (state.ratio
      ? model.fitAspect(meta.pageWidth, meta.pageHeight, state.ratio)
      : model.defaultCrop(meta.pageWidth, meta.pageHeight));
  rememberCrop();
  sync();
  $('thumbList').querySelector(`[data-page="${pageNumber}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  await renderStage();
}

function goToPage(pageNumber) {
  if (!state.session || state.busy) return;
  const next = Math.min(state.pageCount, Math.max(1, Math.round(Number(pageNumber)) || state.pageNumber));
  if (next === state.pageNumber && state.rendered) return;
  showPage(next);
}

function ensureThumbs() {
  if (thumbObserver) return;
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const button = entry.target;
      if (button.dataset.loaded === '1' || button.dataset.loading === '1') continue;
      const session = state.session;
      if (!session) continue;
      button.dataset.loading = '1';
      const generation = state.docGeneration;
      const canvas = button.querySelector('canvas');
      session.renderThumbnail(canvas, Number(button.dataset.page)).then((result) => {
        button.dataset.loading = '0';
        if (generation !== state.docGeneration || result?.cancelled) return;
        button.dataset.loaded = '1';
        button.classList.add('is-ready');
      }).catch(() => {
        button.dataset.loading = '0';
      });
    }
  }, { root: $('thumbList'), rootMargin: '180px 0px' });
}

function buildThumbs(count) {
  ensureThumbs();
  thumbObserver.disconnect();
  const list = $('thumbList');
  list.replaceChildren();
  for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'thumb';
    button.dataset.page = String(pageNumber);
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const label = document.createElement('span');
    label.textContent = String(pageNumber);
    button.append(canvas, label);
    button.addEventListener('click', () => goToPage(pageNumber));
    item.append(button);
    list.append(item);
    thumbObserver.observe(button);
  }
}

function adopt(session, file, bytes) {
  state.session?.close();
  state.docGeneration += 1;
  crops.clear();
  state.session = session;
  state.bytes = bytes;
  state.fileName = file.name || 'clipboard.pdf';
  state.fileSize = file.size || bytes.byteLength;
  state.pageCount = session.pageCount;
  state.pageNumber = 1;
  state.layout = null;
  state.rendered = false;
  state.pageMeta = null;
  state.crop = null;
  state.ratioId = 'free';
  state.ratio = null;
  buildThumbs(session.pageCount);
  sync();
}

function isPdfCandidate(file) {
  const type = (file.type || '').toLowerCase();
  if (type === 'application/pdf') return true;
  if (type) return false;
  const name = file.name || '';
  return !name || /\.pdf$/i.test(name);
}

function confirmRisk(message) {
  $('riskDialogText').textContent = message;
  $('riskDialog').hidden = false;
  $('riskContinue').focus();
  return new Promise((resolve) => {
    const finish = (value) => {
      $('riskDialog').hidden = true;
      $('riskContinue').removeEventListener('click', yes);
      $('riskCancel').removeEventListener('click', no);
      resolve(value);
    };
    const yes = () => finish(true);
    const no = () => finish(false);
    $('riskContinue').addEventListener('click', yes);
    $('riskCancel').addEventListener('click', no);
  });
}

async function openFile(file) {
  const token = ++openToken;
  clearError();
  if (!file) return;
  if (!isPdfCandidate(file)) {
    showError('仅接受 PDF 文件（application/pdf）。');
    return;
  }
  if (file.size > model.RISK_BYTES) {
    const accepted = await confirmRisk(`「${file.name || '未命名.pdf'}」约 ${formatBytes(file.size)}，超过 100MB。解析和渲染会占用较多内存，仍可继续。`);
    if (!accepted || token !== openToken) return;
  }
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    if (token === openToken) showError('无法读取该 PDF：文件已损坏或不是有效的 PDF。');
    return;
  }
  if (token !== openToken) return;
  if (!model.hasPdfHeader(bytes)) {
    showError('无法读取该 PDF：文件已损坏或不是有效的 PDF。');
    return;
  }
  setBusy(true, '正在载入 PDF…', 0.25);
  try {
    const session = await engine.openSession(bytes);
    if (token !== openToken) {
      session.close();
      return;
    }
    adopt(session, file, bytes);
    if (session.pageCount > model.RISK_PAGES) {
      showWarning(`该 PDF 共 ${session.pageCount} 页，超过 500 页。可以继续使用；缩略图和翻页会较慢。单页模式下，裁剪与导出只作用于当前页。`);
    }
    await showPage(1);
  } catch (error) {
    if (token !== openToken) return;
    showError(model.messageForLoadError(error));
  } finally {
    if (token === openToken) setBusy(false);
  }
}

function applyPreset(id) {
  if (!state.session || state.busy) return;
  const preset = model.presetById(id);
  state.ratioId = preset.id;
  state.ratio = preset.ratio;
  if (state.pageWidth) {
    state.crop = preset.ratio
      ? model.fitAspect(state.pageWidth, state.pageHeight, preset.ratio)
      : state.crop;
    rememberCrop();
    drawOverlay();
  }
  sync();
}

function selectAll() {
  if (!state.pageWidth) return;
  state.ratioId = 'free';
  state.ratio = null;
  state.crop = model.fullPageRect(state.pageWidth, state.pageHeight);
  rememberCrop();
  drawOverlay();
  sync();
}

function resetCrop() {
  if (!state.pageWidth) return;
  state.ratioId = 'free';
  state.ratio = null;
  state.crop = model.defaultCrop(state.pageWidth, state.pageHeight);
  rememberCrop();
  drawOverlay();
  sync();
}

function centerCrop() {
  if (!state.crop) return;
  state.crop = model.centerRect(state.crop, state.pageWidth, state.pageHeight);
  rememberCrop();
  drawOverlay();
  sync();
}

function commitNumbers(edited) {
  if (!state.pageWidth || state.busy) return;
  const values = {};
  for (const [id, key] of [['cropX', 'x'], ['cropY', 'y'], ['cropW', 'width'], ['cropH', 'height']]) {
    const number = Number($(id).value);
    if (!Number.isFinite(number)) return;
    values[key] = number;
  }
  let rect = model.rectFromUnitValues(values, state.unit);
  if (state.ratio && edited === 'width') rect.height = rect.width / state.ratio;
  if (state.ratio && edited === 'height') rect.width = rect.height * state.ratio;
  const ratio = edited === 'width' || edited === 'height' ? state.ratio : null;
  state.crop = model.enforceBounds(rect, state.pageWidth, state.pageHeight, ratio);
  rememberCrop();
  drawOverlay();
  syncNumbers();
  syncPill();
  publish();
}

function nudge(dx, dy) {
  if (!state.layout || !state.crop || state.busy) return;
  state.crop = model.nudgeByViewPixels(state.crop, dx, dy, state.layout, state.pageWidth, state.pageHeight);
  rememberCrop();
  drawOverlay();
  syncNumbers();
  syncPill();
  publish();
}

async function noteExport(kind, name, bytes) {
  if (!e2e) return;
  window.__pdfTools.lastExport = {
    kind,
    name,
    byteLength: bytes.length,
    signature: Array.from(bytes.slice(0, 8)),
  };
}

async function runExport() {
  if (!state.session || state.busy || !state.crop || !state.pageMeta) return;
  const kind = selectedFormat();
  clearError();
  setBusy(true, '正在准备导出…', 0.08);
  try {
    const dpi = kind === 'pdf' ? 72 : Number($('dpiSelect').value);
    const pixels = model.exportPixelSize(state.crop.width, state.crop.height, dpi);
    const filename = model.buildExportFilename({
      sourceName: state.fileName,
      pageNumber: state.pageNumber,
      widthPx: pixels.width,
      heightPx: pixels.height,
      ext: kind === 'jpg' ? 'jpg' : kind,
      date: new Date(),
    });
    if (kind === 'pdf') {
      setBusy(true, '正在写入裁剪框…', 0.5);
      const bytes = await exporterModule.exportVectorPdf(state.bytes, state.pageNumber - 1, state.crop, state.pageMeta);
      await noteExport('pdf', filename, bytes);
      setBusy(true, '正在保存…', 0.92);
      exporterModule.downloadBlob(new Blob([bytes], { type: 'application/pdf' }), filename);
    } else {
      const page = await state.session.getPage(state.pageNumber);
      const rendered = await exporterModule.exportRasterBlob(page, state.crop, {
        mime: kind === 'png' ? 'image/png' : 'image/jpeg',
        dpi,
        quality: Number($('jpgQuality').value),
        onProgress: (amount, label) => setBusy(true, label, amount),
      });
      const bytes = new Uint8Array(await rendered.blob.arrayBuffer());
      await noteExport(kind, filename, bytes);
      setBusy(true, '正在保存…', 0.96);
      exporterModule.downloadBlob(rendered.blob, filename);
    }
    $('exportStatus').textContent = `已导出 ${filename}`;
    clearError();
  } catch (error) {
    showError(model.messageForExportError(error), true);
  } finally {
    setBusy(false);
  }
}

function hasDragFiles(event) {
  return [...(event.dataTransfer?.items || [])].some((item) => item.kind === 'file')
    || (event.dataTransfer?.files?.length > 0);
}

function bind() {
  $('btnOpen').addEventListener('click', () => $('fileInput').click());
  $('btnBrowse').addEventListener('click', (event) => {
    event.stopPropagation();
    $('fileInput').click();
  });
  $('dropzone').addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    $('fileInput').click();
  });
  $('fileInput').addEventListener('change', () => {
    const [file] = $('fileInput').files || [];
    $('fileInput').value = '';
    if (file) openFile(file);
  });
  $('btnPrev').addEventListener('click', () => goToPage(state.pageNumber - 1));
  $('btnNext').addEventListener('click', () => goToPage(state.pageNumber + 1));
  $('pageInput').addEventListener('change', () => goToPage($('pageInput').value));
  $('pageInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      goToPage($('pageInput').value);
    }
  });
  $('btnSelectAll').addEventListener('click', selectAll);
  $('btnReset').addEventListener('click', resetCrop);
  $('btnCenter').addEventListener('click', centerCrop);
  $('unitPx').addEventListener('click', () => { state.unit = 'px'; sync(); });
  $('unitMm').addEventListener('click', () => { state.unit = 'mm'; sync(); });
  for (const [id, key] of [['cropX', 'x'], ['cropY', 'y'], ['cropW', 'width'], ['cropH', 'height']]) {
    $(id).addEventListener('change', () => commitNumbers(key));
    $(id).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitNumbers(key);
      }
    });
  }
  for (const input of document.querySelectorAll('input[name="format"]')) {
    input.addEventListener('change', sync);
  }
  $('jpgQuality').addEventListener('input', sync);
  $('btnExport').addEventListener('click', runExport);
  $('btnRetry').addEventListener('click', runExport);
  $('btnDismissRisk').addEventListener('click', () => { $('riskBanner').hidden = true; });

  const overlay = $('overlayCanvas');
  overlay.addEventListener('pointerdown', (event) => {
    if (!state.layout || !state.crop || state.busy) return;
    $('stage').focus({ preventScroll: true });
    const view = clientToView(event);
    const hit = model.hitTestCrop(view.x, view.y, model.pageRectToView(state.crop, state.layout));
    if (hit.type === 'outside') return;
    drag = {
      type: hit.type,
      handle: hit.handle,
      startPage: model.viewToPage(view, state.layout),
      startCrop: { ...state.crop },
    };
    overlay.setPointerCapture(event.pointerId);
    setCursor(hit.type === 'move' ? 'is-move' : `is-${hit.handle}`);
    $('stage').classList.add('is-dragging');
    event.preventDefault();
  });
  overlay.addEventListener('pointermove', (event) => {
    const view = clientToView(event);
    if (!drag || !state.layout) {
      updateCursor(view);
      return;
    }
    const point = model.viewToPage(view, state.layout);
    state.crop = drag.type === 'move'
      ? model.moveRect(drag.startCrop, point.x - drag.startPage.x, point.y - drag.startPage.y, state.pageWidth, state.pageHeight)
      : model.resizeByHandle(drag.startCrop, drag.handle, point, state.pageWidth, state.pageHeight, state.ratio);
    rememberCrop();
    drawOverlay();
    syncNumbers();
    syncPill();
  });
  const endDrag = (event) => {
    if (!drag) return;
    drag = null;
    $('stage').classList.remove('is-dragging');
    try { overlay.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    sync();
  };
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);

  window.addEventListener('dragenter', (event) => {
    if (!hasDragFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    document.body.classList.add('is-file-drag');
  });
  window.addEventListener('dragover', (event) => {
    if (!hasDragFiles(event)) return;
    event.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('is-file-drag');
  });
  window.addEventListener('drop', (event) => {
    if (!hasDragFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('is-file-drag');
    const file = event.dataTransfer.files?.[0];
    if (file) openFile(file);
  });
  window.addEventListener('paste', (event) => {
    if (event.target.closest('input, textarea')) return;
    const files = [...(event.clipboardData?.files || [])];
    for (const item of event.clipboardData?.items || []) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (!files.length) return;
    event.preventDefault();
    const pdf = files.find((file) => isPdfCandidate(file));
    if (!pdf) {
      showError('剪贴板里没有 PDF。仅接受 application/pdf。');
      return;
    }
    openFile(pdf);
  });
  document.addEventListener('keydown', (event) => {
    if (event.target.closest('input, textarea, select')) return;
    if (!state.session || state.busy) return;
    if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault();
      goToPage(state.pageNumber + (event.key === 'PageDown' ? 1 : -1));
      return;
    }
    if ((event.metaKey || event.ctrlKey) && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      goToPage(state.pageNumber + (event.key === 'ArrowRight' ? 1 : -1));
      return;
    }
    const step = event.shiftKey ? 10 : 1;
    const delta = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    nudge(delta[0], delta[1]);
  });
  $('pageRail').addEventListener('keydown', (event) => {
    if (event.target.closest('input, textarea, select')) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    goToPage(state.pageNumber + (forward ? 1 : -1));
  });

  let resizeFrame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (state.session) renderStage();
    });
  }).observe($('stage'));
}

function buildPresets() {
  const list = $('presetList');
  const hints = {
    free: '不约束比例',
    '1:1': '1 : 1',
    '4:3': '4 : 3',
    '3:4': '3 : 4',
    '16:9': '16 : 9',
    a4: '210 × 297 mm',
    'a4-land': '297 × 210 mm',
    'id-card': '85.6 × 54 mm',
  };
  for (const preset of model.PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preset-btn';
    button.dataset.id = preset.id;
    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = preset.label;
    const dim = document.createElement('span');
    dim.className = 'p-dim';
    dim.textContent = hints[preset.id];
    button.append(name, dim);
    button.addEventListener('click', () => applyPreset(preset.id));
    list.append(button);
  }
}

async function boot() {
  try {
    engine = await import('./pdf-engine.js');
    exporterModule = await import('./exporter.js');
  } catch (error) {
    $('bootError').hidden = false;
    $('bootError').textContent = '无法加载本地 PDF 引擎。请通过 HTTP 打开本页，并确认 vendor 目录完整。';
    throw error;
  }
  buildPresets();
  bind();
  sync();
  publish();
}

boot();
