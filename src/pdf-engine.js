import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import {
  backingStoreScale,
  cappedDeviceScale,
  containLayout,
  hasPdfHeader,
  messageForLoadError,
} from './crop-model.js';

const assetBase = new URL('../vendor/pdfjs/', import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', assetBase).href;
const CMAP_URL = new URL('cmaps/', assetBase).href;
const FONT_URL = new URL('standard_fonts/', assetBase).href;

export { hasPdfHeader, messageForLoadError };

let loadingTask = null;

export function pageMeta(page) {
  const viewport = page.getViewport({ scale: 1 });
  return {
    pageWidth: viewport.width,
    pageHeight: viewport.height,
    viewBox: Array.from(page.view),
    rotation: page.rotate || 0,
    userUnit: page.userUnit || 1,
  };
}

export async function openSession(bytes) {
  if (!hasPdfHeader(bytes)) {
    const error = new Error('Invalid PDF structure');
    error.name = 'InvalidPDFException';
    throw error;
  }
  if (loadingTask) {
    const previous = loadingTask;
    loadingTask = null;
    try { await previous.destroy(); } catch { /* superseded */ }
  }
  const task = pdfjs.getDocument({
    data: bytes.slice(0),
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: FONT_URL,
    isEvalSupported: false,
    disableAutoFetch: true,
    enableXfa: false,
    verbosity: 0,
  });
  loadingTask = task;
  try {
    const doc = await task.promise;
    if (loadingTask === task) loadingTask = null;
    return new PdfSession(doc);
  } catch (error) {
    if (loadingTask === task) loadingTask = null;
    try { await task.destroy(); } catch { /* already destroyed */ }
    throw error;
  }
}

export class PdfSession {
  constructor(doc) {
    this.doc = doc;
    this.pageCount = doc.numPages;
    this.cache = new Map();
    this.tasks = new Set();
    this.active = new WeakMap();
    this.generation = new WeakMap();
    this.closed = false;
  }

  async getPage(pageNumber) {
    if (this.closed) throw new Error('文档已关闭');
    const cached = this.cache.get(pageNumber);
    if (cached) return cached;
    const page = await this.doc.getPage(pageNumber);
    if (this.closed) throw new Error('文档已关闭');
    this.cache.set(pageNumber, page);
    return page;
  }

  close() {
    this.closed = true;
    for (const task of this.tasks) {
      try { task.cancel(); } catch { /* finished */ }
    }
    this.tasks.clear();
    try { this.doc.destroy(); } catch { /* ignore */ }
  }

  async renderStage(canvas, pageNumber, { cssWidth, cssHeight, dpr }) {
    return this.#exclusive(canvas, async ({ stale, track }) => {
      const page = await this.getPage(pageNumber);
      if (stale()) return { cancelled: true };
      const meta = pageMeta(page);
      const layout = containLayout(meta.pageWidth, meta.pageHeight, cssWidth, cssHeight);
      const deviceScale = cappedDeviceScale(meta.pageWidth, meta.pageHeight, layout.scale, dpr);
      const backing = backingStoreScale(cssWidth, cssHeight, dpr);
      const viewport = page.getViewport({ scale: deviceScale });
      const offscreen = document.createElement('canvas');
      offscreen.width = Math.max(1, Math.ceil(viewport.width));
      offscreen.height = Math.max(1, Math.ceil(viewport.height));
      const offscreenContext = offscreen.getContext('2d', { alpha: false });
      const task = page.render({ canvasContext: offscreenContext, viewport, background: 'white' });
      if (!track(task)) return { cancelled: true };
      try {
        await task.promise;
      } catch (error) {
        if (error?.name === 'RenderingCancelledException' || stale()) return { cancelled: true };
        throw error;
      } finally {
        this.#release(canvas, task);
      }
      if (stale()) return { cancelled: true };
      canvas.width = Math.max(1, Math.round(cssWidth * backing));
      canvas.height = Math.max(1, Math.round(cssHeight * backing));
      const context = canvas.getContext('2d');
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = '#07080c';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        offscreen,
        layout.offsetX * backing,
        layout.offsetY * backing,
        layout.drawnWidth * backing,
        layout.drawnHeight * backing,
      );
      offscreen.width = 0;
      offscreen.height = 0;
      return { cancelled: false, layout, backing, ...meta };
    });
  }

  async renderThumbnail(canvas, pageNumber, cssWidth = 156) {
    return this.#exclusive(canvas, async ({ stale, track }) => {
      const page = await this.getPage(pageNumber);
      if (stale()) return { cancelled: true };
      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const scale = cappedDeviceScale(base.width, base.height, cssWidth / base.width, dpr, 320 * 480);
      const viewport = page.getViewport({ scale });
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const task = page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
        background: 'white',
      });
      if (!track(task)) return { cancelled: true };
      try {
        await task.promise;
      } catch (error) {
        if (error?.name === 'RenderingCancelledException' || stale()) return { cancelled: true };
        throw error;
      } finally {
        this.#release(canvas, task);
      }
      return { cancelled: stale() };
    });
  }

  async #exclusive(canvas, work) {
    const generation = (this.generation.get(canvas) || 0) + 1;
    this.generation.set(canvas, generation);
    const previous = this.active.get(canvas);
    if (previous) {
      try { previous.cancel(); } catch { /* already settled */ }
      try { await previous.promise; } catch { /* cancellation */ }
    }
    if (this.generation.get(canvas) !== generation || this.closed) return { cancelled: true };
    return work({
      stale: () => this.generation.get(canvas) !== generation || this.closed,
      track: (task) => {
        if (this.generation.get(canvas) !== generation || this.closed) {
          try { task.cancel(); } catch { /* ignore */ }
          return false;
        }
        this.active.set(canvas, task);
        this.tasks.add(task);
        return true;
      },
    });
  }

  #release(canvas, task) {
    this.tasks.delete(task);
    if (this.active.get(canvas) === task) this.active.delete(canvas);
  }
}
