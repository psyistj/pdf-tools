/**
 * Pure crop geometry. Visual space is top-left, y-down, in the same units as
 * a pdf.js viewport at scale 1. PDF user space stays bottom-left.
 */

export const PDF_DPI = 72;
export const MM_PER_INCH = 25.4;
export const REFERENCE_DPI = 300;
export const MIN_CROP_PT = 8;
export const RISK_BYTES = 100 * 1024 * 1024;
export const RISK_PAGES = 500;
export const MAX_STAGE_PIXELS = 16_000_000;
export const MAX_PAGE_PIXELS = 12_000_000;

export const A4_MM = Object.freeze({ width: 210, height: 297 });
export const ID_CARD_MM = Object.freeze({ width: 85.6, height: 54 });

export const PRESETS = Object.freeze([
  Object.freeze({ id: 'free', label: '自由', ratio: null }),
  Object.freeze({ id: '1:1', label: '1:1', ratio: 1 }),
  Object.freeze({ id: '4:3', label: '4:3', ratio: 4 / 3 }),
  Object.freeze({ id: '3:4', label: '3:4', ratio: 3 / 4 }),
  Object.freeze({ id: '16:9', label: '16:9', ratio: 16 / 9 }),
  Object.freeze({ id: 'a4', label: 'A4 纵向', ratio: A4_MM.width / A4_MM.height }),
  Object.freeze({ id: 'a4-land', label: 'A4 横向', ratio: A4_MM.height / A4_MM.width }),
  Object.freeze({ id: 'id-card', label: '身份证', ratio: ID_CARD_MM.width / ID_CARD_MM.height }),
]);

const HANDLES = Object.freeze(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);

export function presetById(id) {
  return PRESETS.find((preset) => preset.id === id) || PRESETS[0];
}

export function mmToPx(mm, dpi = REFERENCE_DPI) {
  return (mm / MM_PER_INCH) * dpi;
}

export function pxToMm(px, dpi = REFERENCE_DPI) {
  return (px / dpi) * MM_PER_INCH;
}

export function ptToPx(pt, dpi = REFERENCE_DPI) {
  return pt * (dpi / PDF_DPI);
}

export function pxToPt(px, dpi = REFERENCE_DPI) {
  return px * (PDF_DPI / dpi);
}

export function ptToMm(pt) {
  return (pt / PDF_DPI) * MM_PER_INCH;
}

export function mmToPt(mm) {
  return (mm / MM_PER_INCH) * PDF_DPI;
}

export function exportPixelSize(widthPt, heightPt, dpi) {
  if (!(widthPt > 0) || !(heightPt > 0) || !(dpi > 0)) {
    throw new TypeError('导出尺寸无效');
  }
  return {
    width: Math.max(1, Math.round((widthPt * dpi) / PDF_DPI)),
    height: Math.max(1, Math.round((heightPt * dpi) / PDF_DPI)),
  };
}

export function containLayout(pageWidth, pageHeight, viewWidth, viewHeight) {
  if (!(pageWidth > 0) || !(pageHeight > 0) || !(viewWidth > 0) || !(viewHeight > 0)) {
    return { scale: 1, offsetX: 0, offsetY: 0, drawnWidth: 0, drawnHeight: 0 };
  }
  const scale = Math.min(viewWidth / pageWidth, viewHeight / pageHeight);
  const drawnWidth = pageWidth * scale;
  const drawnHeight = pageHeight * scale;
  return {
    scale,
    offsetX: (viewWidth - drawnWidth) / 2,
    offsetY: (viewHeight - drawnHeight) / 2,
    drawnWidth,
    drawnHeight,
  };
}

export function pageToView(point, layout) {
  return {
    x: layout.offsetX + point.x * layout.scale,
    y: layout.offsetY + point.y * layout.scale,
  };
}

export function viewToPage(point, layout) {
  return {
    x: (point.x - layout.offsetX) / layout.scale,
    y: (point.y - layout.offsetY) / layout.scale,
  };
}

export function pageRectToView(rect, layout) {
  const origin = pageToView({ x: rect.x, y: rect.y }, layout);
  return {
    x: origin.x,
    y: origin.y,
    width: rect.width * layout.scale,
    height: rect.height * layout.scale,
  };
}

export function handlePoints(viewRect) {
  const right = viewRect.x + viewRect.width;
  const bottom = viewRect.y + viewRect.height;
  const midX = viewRect.x + viewRect.width / 2;
  const midY = viewRect.y + viewRect.height / 2;
  return [
    { id: 'nw', x: viewRect.x, y: viewRect.y },
    { id: 'n', x: midX, y: viewRect.y },
    { id: 'ne', x: right, y: viewRect.y },
    { id: 'e', x: right, y: midY },
    { id: 'se', x: right, y: bottom },
    { id: 's', x: midX, y: bottom },
    { id: 'sw', x: viewRect.x, y: bottom },
    { id: 'w', x: viewRect.x, y: midY },
  ];
}

export function hitTestCrop(x, y, viewRect, radius = 7) {
  for (const handle of handlePoints(viewRect)) {
    if (Math.abs(x - handle.x) <= radius && Math.abs(y - handle.y) <= radius) {
      return { type: 'handle', handle: handle.id };
    }
  }
  if (x >= viewRect.x && y >= viewRect.y && x <= viewRect.x + viewRect.width && y <= viewRect.y + viewRect.height) {
    return { type: 'move', handle: null };
  }
  return { type: 'outside', handle: null };
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

export function clampRect(rect, pageWidth, pageHeight, minSize = 1) {
  const minW = Math.min(Math.max(minSize, 0), pageWidth);
  const minH = Math.min(Math.max(minSize, 0), pageHeight);
  const width = clamp(rect.width, minW, pageWidth);
  const height = clamp(rect.height, minH, pageHeight);
  return {
    x: clamp(rect.x, 0, pageWidth - width),
    y: clamp(rect.y, 0, pageHeight - height),
    width,
    height,
  };
}

export function fullPageRect(pageWidth, pageHeight) {
  return { x: 0, y: 0, width: pageWidth, height: pageHeight };
}

export function defaultCrop(pageWidth, pageHeight) {
  return clampRect({
    x: pageWidth * 0.1,
    y: pageHeight * 0.1,
    width: pageWidth * 0.8,
    height: pageHeight * 0.8,
  }, pageWidth, pageHeight, Math.min(MIN_CROP_PT, pageWidth, pageHeight));
}

export function centerRect(rect, pageWidth, pageHeight) {
  const width = Math.min(Math.max(rect.width, 0), pageWidth);
  const height = Math.min(Math.max(rect.height, 0), pageHeight);
  return {
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width,
    height,
  };
}

export function fitAspect(pageWidth, pageHeight, ratio) {
  if (!(pageWidth > 0) || !(pageHeight > 0)) throw new TypeError('页面尺寸无效');
  if (ratio == null) return fullPageRect(pageWidth, pageHeight);
  if (!(ratio > 0)) throw new TypeError('比例无效');
  let width = pageWidth;
  let height = width / ratio;
  if (height > pageHeight) {
    height = pageHeight;
    width = height * ratio;
  }
  const fitted = fitRatioSize(width, height, pageWidth, pageHeight, ratio);
  return placeRect(fitted.width, fitted.height, pageWidth, pageHeight, {
    x: (pageWidth - fitted.width) / 2,
    y: (pageHeight - fitted.height) / 2,
  });
}

function fitRatioSize(width, height, pageWidth, pageHeight, ratio) {
  let nextWidth = width;
  let nextHeight = ratio ? nextWidth / ratio : height;
  const overflow = Math.max(nextWidth / pageWidth, nextHeight / pageHeight, 1);
  if (overflow > 1) {
    nextWidth /= overflow;
    nextHeight /= overflow;
  }
  return { width: nextWidth, height: nextHeight };
}

function placeRect(width, height, pageWidth, pageHeight, origin) {
  const x = clamp(origin.x, 0, pageWidth - width);
  const y = clamp(origin.y, 0, pageHeight - height);
  return { x, y, width, height };
}

export function moveRect(rect, dx, dy, pageWidth, pageHeight) {
  const width = Math.min(Math.max(rect.width, 0), pageWidth);
  const height = Math.min(Math.max(rect.height, 0), pageHeight);
  return {
    x: clamp(rect.x + dx, 0, pageWidth - width),
    y: clamp(rect.y + dy, 0, pageHeight - height),
    width,
    height,
  };
}

export function nudgeByViewPixels(rect, dxPx, dyPx, layout, pageWidth, pageHeight) {
  if (!(layout?.scale > 0)) return { ...rect };
  return moveRect(rect, dxPx / layout.scale, dyPx / layout.scale, pageWidth, pageHeight);
}

export function enforceBounds(rect, pageWidth, pageHeight, ratio = null) {
  const minW = Math.min(MIN_CROP_PT, pageWidth);
  const minH = Math.min(MIN_CROP_PT, pageHeight);
  let width = Math.abs(rect.width);
  let height = Math.abs(rect.height);
  if (ratio) {
    const fitted = fitRatioSize(Math.max(width, minW), height, pageWidth, pageHeight, ratio);
    width = fitted.width;
    height = fitted.height;
  } else {
    width = clamp(width, minW, pageWidth);
    height = clamp(height, minH, pageHeight);
  }
  return placeRect(width, height, pageWidth, pageHeight, rect);
}

export function resizeByHandle(rect, handle, pointer, pageWidth, pageHeight, ratio = null) {
  if (!HANDLES.includes(handle)) throw new TypeError('未知控制点');
  if (!(pageWidth > 0) || !(pageHeight > 0)) throw new TypeError('页面尺寸无效');
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const anchorX = handle.includes('w') ? right : handle.includes('e') ? rect.x : rect.x + rect.width / 2;
  const anchorY = handle.includes('n') ? bottom : handle.includes('s') ? rect.y : rect.y + rect.height / 2;
  const minW = Math.min(MIN_CROP_PT, pageWidth);
  const minH = Math.min(MIN_CROP_PT, pageHeight);
  let width;
  let height;
  if (!ratio && (handle === 'n' || handle === 's')) {
    width = rect.width;
    height = Math.abs(pointer.y - anchorY);
  } else if (!ratio && (handle === 'e' || handle === 'w')) {
    width = Math.abs(pointer.x - anchorX);
    height = rect.height;
  } else if (!ratio) {
    width = Math.abs(pointer.x - anchorX);
    height = Math.abs(pointer.y - anchorY);
  } else if (handle === 'n' || handle === 's') {
    height = Math.abs(pointer.y - anchorY);
    width = height * ratio;
  } else if (handle === 'e' || handle === 'w') {
    width = Math.abs(pointer.x - anchorX);
    height = width / ratio;
  } else {
    const rawW = Math.abs(pointer.x - anchorX);
    const rawH = Math.abs(pointer.y - anchorY);
    if (rawH === 0 || rawW / ratio >= rawH) {
      width = rawW;
      height = width / ratio;
    } else {
      height = rawH;
      width = height * ratio;
    }
  }
  width = Math.max(width, minW);
  height = Math.max(height, minH);
  if (ratio) {
    const fitted = fitRatioSize(width, height, pageWidth, pageHeight, ratio);
    width = fitted.width;
    height = fitted.height;
  } else {
    width = Math.min(width, pageWidth);
    height = Math.min(height, pageHeight);
  }
  const x = handle.includes('w') ? anchorX - width : handle.includes('e') ? anchorX : anchorX - width / 2;
  const y = handle.includes('n') ? anchorY - height : handle.includes('s') ? anchorY : anchorY - height / 2;
  return placeRect(width, height, pageWidth, pageHeight, { x, y });
}

export function rectToUnitValues(rect, unit, dpi = REFERENCE_DPI) {
  const convert = unit === 'mm' ? ptToMm : (value) => ptToPx(value, dpi);
  return {
    x: convert(rect.x),
    y: convert(rect.y),
    width: convert(rect.width),
    height: convert(rect.height),
  };
}

export function rectFromUnitValues(values, unit, dpi = REFERENCE_DPI) {
  const convert = unit === 'mm' ? mmToPt : (value) => pxToPt(value, dpi);
  return {
    x: convert(values.x),
    y: convert(values.y),
    width: convert(values.width),
    height: convert(values.height),
  };
}

export function formatMeasure(value) {
  if (!Number.isFinite(value)) return '';
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

/**
 * pdf.js PageViewport transform at the given scale. Maps PDF user space to
 * visual pixels (top-left, y-down).
 */
export function pageViewportTransform({
  viewBox,
  userUnit = 1,
  scale = 1,
  rotation = 0,
  offsetX = 0,
  offsetY = 0,
}) {
  const box = viewBox;
  let rotate = rotation % 360;
  if (rotate < 0) rotate += 360;
  const applied = scale * userUnit;
  const centerX = (box[2] + box[0]) / 2;
  const centerY = (box[3] + box[1]) / 2;
  let rotateA;
  let rotateB;
  let rotateC;
  let rotateD;
  switch (rotate) {
    case 180:
      rotateA = -1; rotateB = 0; rotateC = 0; rotateD = 1;
      break;
    case 90:
      rotateA = 0; rotateB = 1; rotateC = 1; rotateD = 0;
      break;
    case 270:
      rotateA = 0; rotateB = -1; rotateC = -1; rotateD = 0;
      break;
    case 0:
      rotateA = 1; rotateB = 0; rotateC = 0; rotateD = -1;
      break;
    default:
      throw new TypeError('旋转角度必须是 90 度的整数倍');
  }
  let offsetCanvasX;
  let offsetCanvasY;
  let width;
  let height;
  if (rotateA === 0) {
    offsetCanvasX = Math.abs(centerY - box[1]) * applied + offsetX;
    offsetCanvasY = Math.abs(centerX - box[0]) * applied + offsetY;
    width = (box[3] - box[1]) * applied;
    height = (box[2] - box[0]) * applied;
  } else {
    offsetCanvasX = Math.abs(centerX - box[0]) * applied + offsetX;
    offsetCanvasY = Math.abs(centerY - box[1]) * applied + offsetY;
    width = (box[2] - box[0]) * applied;
    height = (box[3] - box[1]) * applied;
  }
  return {
    width,
    height,
    rotation: rotate,
    transform: [
      rotateA * applied,
      rotateB * applied,
      rotateC * applied,
      rotateD * applied,
      offsetCanvasX - rotateA * applied * centerX - rotateC * applied * centerY,
      offsetCanvasY - rotateB * applied * centerX - rotateD * applied * centerY,
    ],
  };
}

export function applyTransform(point, matrix) {
  return [
    matrix[0] * point[0] + matrix[2] * point[1] + matrix[4],
    matrix[1] * point[0] + matrix[3] * point[1] + matrix[5],
  ];
}

export function applyInverseTransform(point, matrix) {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  return [
    (point[0] * matrix[3] - point[1] * matrix[2] + matrix[2] * matrix[5] - matrix[4] * matrix[3]) / determinant,
    (-point[0] * matrix[1] + point[1] * matrix[0] + matrix[4] * matrix[1] - matrix[5] * matrix[0]) / determinant,
  ];
}

export function visualRectToPdfBox(rect, { viewBox, rotation = 0, userUnit = 1 }) {
  const { transform } = pageViewportTransform({ viewBox, rotation, userUnit, scale: 1 });
  const corners = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ].map((point) => applyInverseTransform(point, transform));
  const xs = corners.map((point) => point[0]);
  const ys = corners.map((point) => point[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function cappedDeviceScale(pageWidth, pageHeight, cssScale, dpr, maxPixels = MAX_PAGE_PIXELS) {
  const safeDpr = Math.min(Math.max(Number(dpr) || 1, 1), 3);
  let scale = (cssScale > 0 ? cssScale : 1) * safeDpr;
  const pixels = pageWidth * pageHeight * scale * scale;
  if (pixels > maxPixels && pixels > 0) scale *= Math.sqrt(maxPixels / pixels);
  return scale;
}

export function backingStoreScale(cssWidth, cssHeight, dpr, maxPixels = MAX_STAGE_PIXELS) {
  let scale = Math.min(Math.max(Number(dpr) || 1, 1), 3);
  if (!(cssWidth > 0) || !(cssHeight > 0)) return scale;
  const pixels = cssWidth * cssHeight * scale * scale;
  if (pixels > maxPixels) scale *= Math.sqrt(maxPixels / pixels);
  return scale;
}

export function performanceRisk({ bytes = 0, pages = 0 } = {}) {
  const reasons = [];
  if (bytes > RISK_BYTES) reasons.push('size');
  if (pages > RISK_PAGES) reasons.push('pages');
  return reasons;
}

export function sanitizeStem(name) {
  const base = String(name || 'document').replace(/\.pdf$/i, '');
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned || 'document';
}

export function formatTimestamp(date) {
  const value = date instanceof Date ? date : new Date(date);
  const pad = (part) => String(part).padStart(2, '0');
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}-${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}`;
}

export function buildExportFilename({ sourceName, pageNumber, widthPx, heightPx, ext, date }) {
  const stem = sanitizeStem(sourceName);
  const stamp = formatTimestamp(date);
  return `${stem}-p${pageNumber}-${widthPx}x${heightPx}-${stamp}.${ext}`;
}

export function hasPdfHeader(bytes) {
  if (!bytes || bytes.length < 5) return false;
  const limit = Math.min(bytes.length, 1024);
  for (let index = 0; index <= limit - 4; index += 1) {
    if (bytes[index] === 0x25 && bytes[index + 1] === 0x50 && bytes[index + 2] === 0x44 && bytes[index + 3] === 0x46) {
      return true;
    }
  }
  return false;
}

export function messageForLoadError(error) {
  const name = error?.name || '';
  const message = String(error?.message || '');
  if (name === 'PasswordException' || /password/i.test(message) || /encrypted/i.test(message)) {
    return '该 PDF 已加密，本工具不支持打开受密码保护的文件。';
  }
  if (name === 'InvalidPDFException' || name === 'MissingPDFException' || /invalid pdf/i.test(message)) {
    return '无法读取该 PDF：文件已损坏或不是有效的 PDF。';
  }
  return '无法读取该 PDF：文件已损坏或格式无法识别。';
}

export function messageForExportError(error) {
  const name = error?.name || '';
  const message = String(error?.message || '');
  if (message.startsWith('导出失败')) return message;
  if (name === 'EncryptedPDFError' || /encrypt/i.test(message)) {
    return '导出失败：该 PDF 已加密，无法重写裁剪框。';
  }
  if (name === 'InvalidPDFException' || /invalid pdf/i.test(message)) {
    return '导出失败：原始 PDF 已损坏，无法写入。';
  }
  return '导出失败：处理过程中出现错误。请重试。';
}
