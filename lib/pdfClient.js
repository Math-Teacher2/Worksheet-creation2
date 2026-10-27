// 브라우저 전용: PDF/이미지 -> AI에게 보낼 페이지 이미지, 그림 잘라내기용 고해상도 렌더링

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

const docCache = new WeakMap();
export async function openPdf(file) {
  if (docCache.has(file)) return docCache.get(file);
  const p = (async () => {
    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    return pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  })();
  docCache.set(file, p);
  try {
    return await p;
  } catch (e) {
    docCache.delete(file);
    throw new Error(`PDF를 열지 못했습니다: ${file.name} (${e.message || e})`);
  }
}

// "1-3, 7, 10~12" -> [1,2,3,7,10,11,12]
export function parsePageRange(input, total) {
  const all = Array.from({ length: total }, (_, i) => i + 1);
  if (!input || !String(input).trim()) return all;
  const set = new Set();
  for (const part of String(input).split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*[-~]\s*(\d+))?$/);
    if (!m) continue;
    const a = Math.max(1, parseInt(m[1], 10));
    const b = Math.min(total, parseInt(m[2] || m[1], 10));
    for (let p = a; p <= b; p++) set.add(p);
  }
  const list = [...set].sort((x, y) => x - y);
  return list.length ? list : all;
}

export async function getPageCount(file) {
  if (!file) return 0;
  if (file.type && file.type.startsWith('image/')) return 1;
  return (await openPdf(file)).numPages;
}

// 페이지를 지정 너비로 그린 canvas
export async function renderPageCanvas(pdf, pageNo, width) {
  const page = await pdf.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const scale = width / base.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

async function pageText(pdf, pageNo) {
  try {
    const page = await pdf.getPage(pageNo);
    const tc = await page.getTextContent();
    return tc.items
      .map((it) => it.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

// 위·왼쪽에 0~1000 눈금자를 붙임 (Gemini 외 모델이 좌표를 정확히 읽도록)
function withRuler(canvas) {
  const pad = 30;
  const out = document.createElement('canvas');
  out.width = canvas.width + pad;
  out.height = canvas.height + pad;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, pad, pad);
  ctx.strokeStyle = '#d00';
  ctx.fillStyle = '#d00';
  ctx.font = 'bold 13px sans-serif';
  ctx.lineWidth = 1;
  for (let v = 0; v <= 1000; v += 50) {
    const x = pad + (v / 1000) * canvas.width;
    const y = pad + (v / 1000) * canvas.height;
    const major = v % 100 === 0;
    ctx.beginPath();
    ctx.moveTo(x, pad);
    ctx.lineTo(x, pad - (major ? 12 : 6));
    ctx.moveTo(pad, y);
    ctx.lineTo(pad - (major ? 12 : 6), y);
    ctx.stroke();
    if (major && v > 0 && v < 1000) {
      ctx.textAlign = 'center';
      ctx.fillText(String(v), x, 12);
      ctx.save();
      ctx.translate(12, y);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(String(v), 0, 4);
      ctx.restore();
    }
  }
  return out;
}

function toJpegPart(canvas, quality) {
  return { mime: 'image/jpeg', data: canvas.toDataURL('image/jpeg', quality).split(',')[1] };
}

async function imageFileCanvas(file, maxWidth) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bitmap.width * scale);
  c.height = Math.round(bitmap.height * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bitmap, 0, 0, c.width, c.height);
  return c;
}

// 교과서 -> [{page, mime, data, text}]
export async function prepareSource(file, range, { imageWidth = 1300, ruler = false, budget = 14_000_000, onProgress } = {}) {
  const pdf = await openPdf(file);
  const pages = parsePageRange(range, pdf.numPages).slice(0, 40);
  let width = imageWidth;
  let quality = 0.8;
  for (let round = 0; round < 4; round++) {
    const images = [];
    let total = 0;
    for (let i = 0; i < pages.length; i++) {
      const canvas = await renderPageCanvas(pdf, pages[i], width);
      const part = toJpegPart(ruler ? withRuler(canvas) : canvas, quality);
      total += part.data.length;
      images.push({ ...part, page: pages[i], text: await pageText(pdf, pages[i]) });
      if (onProgress) onProgress(i + 1, pages.length);
    }
    if (total <= budget) return { images, pages, pageCount: pdf.numPages };
    width = Math.round(width * 0.82);
    quality = Math.max(0.6, quality - 0.06);
  }
  throw new Error('교과서 쪽이 너무 많아 한 번에 보낼 수 없습니다. 쪽 범위를 줄여 주세요.');
}

// 구성 참고 학습지(PDF/이미지) -> [{mime, data}]
export async function prepareTemplate(file, range, onProgress) {
  if (file.type && file.type.startsWith('image/')) {
    return { images: [toJpegPart(await imageFileCanvas(file, 1200), 0.75)] };
  }
  const pdf = await openPdf(file);
  const pages = range && String(range).trim() ? parsePageRange(range, pdf.numPages).slice(0, 6) : Array.from({ length: Math.min(3, pdf.numPages) }, (_, i) => i + 1);
  const images = [];
  for (let i = 0; i < pages.length; i++) {
    images.push(toJpegPart(await renderPageCanvas(pdf, pages[i], 1000), 0.7));
    if (onProgress) onProgress(i + 1, pages.length);
  }
  return { images };
}
