import { PDFDocument } from '../vendor/pdf-lib/pdf-lib.esm.min.js';
import {
  buildExportFilename,
  exportPixelSize,
  messageForExportError,
  visualRectToPdfBox,
} from './crop-model.js';

export const MAX_EXPORT_PIXELS = 40_000_000;

export { buildExportFilename, messageForExportError };

export async function exportVectorPdf(sourceBytes, pageIndex, crop, pageMeta) {
  let source;
  try {
    source = await PDFDocument.load(sourceBytes);
  } catch (error) {
    throw Object.assign(new Error(messageForExportError(error)), { cause: error, name: error?.name });
  }
  const output = await PDFDocument.create();
  let page;
  try {
    [page] = await output.copyPages(source, [pageIndex]);
  } catch (error) {
    throw new Error('导出失败：无法复制选中页。');
  }
  output.addPage(page);
  const box = visualRectToPdfBox(crop, pageMeta);
  if (!(box.width > 0) || !(box.height > 0)) {
    throw new Error('导出失败：裁剪框尺寸无效。');
  }
  page.setMediaBox(box.x, box.y, box.width, box.height);
  page.setCropBox(box.x, box.y, box.width, box.height);
  page.setBleedBox(box.x, box.y, box.width, box.height);
  page.setTrimBox(box.x, box.y, box.width, box.height);
  page.setArtBox(box.x, box.y, box.width, box.height);
  return output.save();
}

export async function exportRasterBlob(page, crop, { mime, dpi, quality = 0.92, onProgress } = {}) {
  const size = exportPixelSize(crop.width, crop.height, dpi);
  if (size.width * size.height > MAX_EXPORT_PIXELS) {
    throw new Error(`导出失败：目标约 ${size.width}×${size.height} 像素，超过 4000 万像素上限。请降低 DPI 或缩小裁剪框后重试。`);
  }
  onProgress?.(0.3, '正在渲染当前页…');
  const scale = dpi / 72;
  const viewport = page.getViewport({
    scale,
    offsetX: -crop.x * scale,
    offsetY: -crop.y * scale,
  });
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, size.width, size.height);
  const task = page.render({ canvasContext: context, viewport, background: 'white' });
  try {
    await task.promise;
  } catch (error) {
    if (error?.name === 'RenderingCancelledException') throw new Error('导出失败：渲染已取消。请重试。');
    throw new Error('导出失败：页面渲染出错。请重试。');
  }
  onProgress?.(0.82, '正在编码图片…');
  const blob = await canvasToBlob(canvas, mime, quality);
  canvas.width = 0;
  canvas.height = 0;
  return { blob, size };
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error('导出失败：浏览器无法编码该图片。'));
      else resolve(blob);
    }, type, quality);
  });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}
