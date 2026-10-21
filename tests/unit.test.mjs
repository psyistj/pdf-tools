import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PDFDocument } from '../vendor/pdf-lib/pdf-lib.esm.min.js';
import {
  A4_MM,
  ID_CARD_MM,
  applyInverseTransform,
  applyTransform,
  buildExportFilename,
  cappedDeviceScale,
  clampRect,
  containLayout,
  defaultCrop,
  exportPixelSize,
  fitAspect,
  mmToPt,
  mmToPx,
  moveRect,
  nudgeByViewPixels,
  pageToView,
  pageViewportTransform,
  presetById,
  ptToMm,
  pxToMm,
  resizeByHandle,
  viewToPage,
  visualRectToPdfBox,
} from '../src/crop-model.js';
import { exportVectorPdf } from '../src/exporter.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function assertInside(rect, pageWidth, pageHeight) {
  assert.ok(rect.width > 0 && rect.height > 0, JSON.stringify(rect));
  assert.ok(rect.x >= -1e-6, JSON.stringify(rect));
  assert.ok(rect.y >= -1e-6, JSON.stringify(rect));
  assert.ok(rect.x + rect.width <= pageWidth + 1e-6, JSON.stringify(rect));
  assert.ok(rect.y + rect.height <= pageHeight + 1e-6, JSON.stringify(rect));
}

function assertRatio(rect, ratio) {
  const actual = rect.width / rect.height;
  assert.ok(Math.abs(actual - ratio) / ratio < 1e-6, `${actual} vs ${ratio}`);
}

test('view and page coordinates round-trip through contain layout', () => {
  const layout = containLayout(612, 792, 900, 700);
  assert.ok(layout.scale < 1);
  assert.ok(layout.offsetX > 0 || layout.offsetY > 0);
  const point = { x: 123.5, y: 456.25 };
  const back = viewToPage(pageToView(point, layout), layout);
  assert.ok(Math.abs(back.x - point.x) < 1e-9);
  assert.ok(Math.abs(back.y - point.y) < 1e-9);

  const letterbox = containLayout(100, 200, 100, 100);
  assert.equal(letterbox.scale, 0.5);
  assert.equal(letterbox.offsetX, 25);
  assert.equal(letterbox.offsetY, 0);
  assert.equal(letterbox.drawnWidth, 50);
  assert.equal(letterbox.drawnHeight, 100);
});

test('viewport transform matches pdf.js user space for rotation 0 and 90', () => {
  const upright = pageViewportTransform({ viewBox: [0, 0, 612, 792], rotation: 0 });
  assert.equal(upright.width, 612);
  assert.equal(upright.height, 792);
  upright.transform.forEach((value, index) => {
    assert.ok(Math.abs(value - [1, 0, 0, -1, 0, 792][index]) < 1e-9);
  });
  const topLeft = applyTransform([0, 792], upright.transform);
  assert.ok(Math.abs(topLeft[0]) < 1e-9 && Math.abs(topLeft[1]) < 1e-9);
  const roundTrip = applyInverseTransform(applyTransform([120, 340], upright.transform), upright.transform);
  assert.ok(Math.abs(roundTrip[0] - 120) < 1e-9);
  assert.ok(Math.abs(roundTrip[1] - 340) < 1e-9);

  const turned = pageViewportTransform({ viewBox: [0, 0, 200, 100], rotation: 90 });
  assert.equal(turned.width, 100);
  assert.equal(turned.height, 200);
  const box = visualRectToPdfBox(
    { x: 0, y: 0, width: turned.width, height: turned.height },
    { viewBox: [0, 0, 200, 100], rotation: 90 },
  );
  assert.ok(Math.abs(box.x) < 1e-6);
  assert.ok(Math.abs(box.y) < 1e-6);
  assert.ok(Math.abs(box.width - 200) < 1e-6);
  assert.ok(Math.abs(box.height - 100) < 1e-6);
});

test('visual crop maps to a PDF CropBox on an upright page', () => {
  const viewBox = [0, 0, 612, 792];
  const box = visualRectToPdfBox(
    { x: 72, y: 36, width: 144, height: 72 },
    { viewBox, rotation: 0, userUnit: 1 },
  );
  assert.ok(Math.abs(box.x - 72) < 1e-6);
  assert.ok(Math.abs(box.y - (792 - 36 - 72)) < 1e-6);
  assert.ok(Math.abs(box.width - 144) < 1e-6);
  assert.ok(Math.abs(box.height - 72) < 1e-6);
});

test('clampRect keeps a crop inside the page', () => {
  assert.deepEqual(
    clampRect({ x: -20, y: 80, width: 1000, height: 50 }, 200, 100),
    { x: 0, y: 50, width: 200, height: 50 },
  );
  const moved = moveRect({ x: 10, y: 10, width: 40, height: 20 }, -100, 500, 100, 80);
  assert.deepEqual(moved, { x: 0, y: 60, width: 40, height: 20 });
  const layout = { scale: 2, offsetX: 0, offsetY: 0 };
  const nudged = nudgeByViewPixels({ x: 0, y: 0, width: 20, height: 20 }, 10, -10, layout, 100, 100);
  assert.equal(nudged.x, 5);
  assert.equal(nudged.y, 0);
});

test('1:1, A4 and ID-card ratios stay inside the page', () => {
  assert.equal(presetById('1:1').ratio, 1);
  assert.equal(presetById('a4').ratio, A4_MM.width / A4_MM.height);
  assert.equal(presetById('a4-land').ratio, A4_MM.height / A4_MM.width);
  assert.equal(presetById('id-card').ratio, ID_CARD_MM.width / ID_CARD_MM.height);

  const ratios = [1, A4_MM.width / A4_MM.height, ID_CARD_MM.width / ID_CARD_MM.height];
  const pages = [
    [1000, 1000],
    [200, 800],
    [800, 200],
    [mmToPt(A4_MM.width), mmToPt(A4_MM.height)],
    [mmToPt(ID_CARD_MM.width), mmToPt(ID_CARD_MM.height)],
    [50, 40],
  ];
  for (const ratio of ratios) {
    for (const [pageWidth, pageHeight] of pages) {
      const rect = fitAspect(pageWidth, pageHeight, ratio);
      assertInside(rect, pageWidth, pageHeight);
      assertRatio(rect, ratio);
    }
  }

  const card = fitAspect(mmToPt(ID_CARD_MM.width), mmToPt(ID_CARD_MM.height), ID_CARD_MM.width / ID_CARD_MM.height);
  assert.ok(Math.abs(card.width - mmToPt(ID_CARD_MM.width)) < 1e-6);
  assert.ok(Math.abs(card.height - mmToPt(ID_CARD_MM.height)) < 1e-6);

  for (const ratio of [null, ...ratios]) {
    for (const handle of HANDLES) {
      const start = ratio
        ? fitAspect(640, 480, ratio)
        : { x: 40, y: 30, width: 200, height: 120 };
      const rect = resizeByHandle(start, handle, { x: -80, y: 960 }, 640, 480, ratio);
      assertInside(rect, 640, 480);
      if (ratio) assertRatio(rect, ratio);
    }
  }
});

test('east handle grows a free crop and stops at the page edge', () => {
  const grown = resizeByHandle(
    { x: 10, y: 10, width: 50, height: 40 },
    'e',
    { x: 80, y: 10 },
    200,
    200,
    null,
  );
  assert.deepEqual(grown, { x: 10, y: 10, width: 70, height: 40 });
  const capped = resizeByHandle(
    { x: 150, y: 20, width: 40, height: 40 },
    'e',
    { x: 500, y: 20 },
    200,
    200,
    null,
  );
  assertInside(capped, 200, 200);
  assert.equal(capped.x + capped.width, 200);
});

test('millimetres and pixels convert exactly at 300 DPI', () => {
  assert.equal(mmToPx(25.4, 300), 300);
  assert.equal(pxToMm(300, 300), 25.4);
  assert.ok(Math.abs(mmToPx(85.6, 300) - (85.6 * 300) / 25.4) < 1e-9);
  assert.ok(Math.abs(pxToMm(mmToPx(85.6, 300), 300) - 85.6) < 1e-9);
  assert.ok(Math.abs(ptToMm(mmToPt(210)) - 210) < 1e-9);
  assert.ok(Math.abs(mmToPx(1, 300) - 300 / 25.4) < 1e-12);
});

test('export pixel size follows the requested DPI', () => {
  assert.deepEqual(exportPixelSize(72, 72, 96), { width: 96, height: 96 });
  assert.deepEqual(exportPixelSize(72, 144, 300), { width: 300, height: 600 });
  assert.deepEqual(exportPixelSize(mmToPt(210), mmToPt(297), 300), { width: 2480, height: 3508 });
  assert.deepEqual(exportPixelSize(mmToPt(210), mmToPt(297), 150), {
    width: Math.round((210 / 25.4) * 150),
    height: Math.round((297 / 25.4) * 150),
  });
  const scale = cappedDeviceScale(5000, 5000, 1, 2, 1_000_000);
  assert.ok(5000 * 5000 * scale * scale <= 1_000_000 * 1.001);
});

test('export filename keeps the source name, page, size and timestamp', () => {
  const name = buildExportFilename({
    sourceName: '合同.pdf',
    pageNumber: 2,
    widthPx: 800,
    heightPx: 600,
    ext: 'png',
    date: new Date(2026, 9, 21, 16, 5, 3),
  });
  assert.equal(name, '合同-p2-800x600-20261021-160503.png');
  const safe = buildExportFilename({
    sourceName: 'a/b:c.pdf',
    pageNumber: 1,
    widthPx: 10,
    heightPx: 12,
    ext: 'pdf',
    date: new Date(2026, 0, 2, 3, 4, 5),
  });
  assert.equal(safe, 'a_b_c-p1-10x12-20260102-030405.pdf');
});

test('default crop is inset and still inside the page', () => {
  const crop = defaultCrop(500, 400);
  assertInside(crop, 500, 400);
  assert.ok(crop.x > 0 && crop.y > 0);
  assert.ok(crop.width < 500 && crop.height < 400);
});

test('vector export writes MediaBox and CropBox for the selected page only', async () => {
  const sourceBytes = new Uint8Array(await readFile(new URL('./fixtures/two-pages.pdf', import.meta.url)));
  const source = await PDFDocument.load(sourceBytes);
  assert.equal(source.getPageCount(), 2);
  const media = source.getPage(0).getMediaBox();
  const viewBox = [media.x, media.y, media.x + media.width, media.y + media.height];
  const crop = { x: 20, y: 30, width: 120, height: 80 };
  const expected = visualRectToPdfBox(crop, { viewBox, rotation: 0, userUnit: 1 });
  assert.ok(Math.abs(expected.x - 20) < 1e-6);
  assert.ok(Math.abs(expected.y - (media.height - 30 - 80)) < 1e-6);

  const exported = await exportVectorPdf(sourceBytes, 0, crop, { viewBox, rotation: 0, userUnit: 1 });
  const saved = await PDFDocument.load(exported);
  assert.equal(saved.getPageCount(), 1);
  const page = saved.getPage(0);
  const cropBox = page.getCropBox();
  const mediaBox = page.getMediaBox();
  for (const box of [cropBox, mediaBox]) {
    assert.ok(Math.abs(box.x - expected.x) < 0.01);
    assert.ok(Math.abs(box.y - expected.y) < 0.01);
    assert.ok(Math.abs(box.width - expected.width) < 0.01);
    assert.ok(Math.abs(box.height - expected.height) < 0.01);
  }
});
