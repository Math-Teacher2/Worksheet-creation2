// 학습지 문서(JSON) -> HWPX(한글 문서) 변환기.
//
// 구조와 요소 순서는 한컴오피스가 실제로 저장한 HWPX 파일(머리 정보, 표, 그림, 수식)을
// 그대로 따릅니다. 수식은 LaTeX를 한글 수식 스크립트로 바꾸고, 상자 크기를 계산해 넣습니다.

import { zipSync, strToU8 } from 'fflate';
import { parseRich, isDisplayOnly, blankEm } from './rich';
import { latexToHwp } from './latex2hwp';
import { measureHwpEquation } from './eqMeasure';
import { getTheme } from './themes';

// ---------- 단위와 기본 치수 ----------
const mm = (v) => Math.round((v * 7200) / 25.4);
const PAGE_W = 59528;
const PAGE_H = 84188;
const MARGIN_LR = mm(15);
const TEXT_W = PAGE_W - MARGIN_LR * 2; // 51024
const BAR_W = mm(1.6);

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const attrs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(' ');

const NS =
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';

// ---------- 머리 정보(글꼴·테두리·글자 모양·문단 모양) ----------
const FONTS = ['함초롬돋움', '함초롬바탕'];
const FONT_ID = { dotum: 0, batang: 1 };

class Header {
  constructor() {
    this.borderFills = [];
    this.bfKeys = new Map();
    this.charPrs = [];
    this.cpKeys = new Map();
    this.paraPrs = [];
    this.ppKeys = new Map();
    // 1: 테두리 없음(쪽 테두리용), 2: 테두리 없음 + 채우기 없음(글자 기본)
    this.borderFill({});
    this.borderFill({ fillNone: true });
    this.charPr({}); // 0: 본문 기본
    this.paraPr({}); // 0: 본문 기본
  }
  borderFill(spec) {
    const key = JSON.stringify(spec);
    if (this.bfKeys.has(key)) return this.bfKeys.get(key);
    const id = this.borderFills.length + 1;
    this.borderFills.push({ id, spec });
    this.bfKeys.set(key, id);
    return id;
  }
  charPr(spec) {
    const s = { size: 1000, color: '#000000', font: 'batang', bold: false, ...spec };
    const key = JSON.stringify(s);
    if (this.cpKeys.has(key)) return this.cpKeys.get(key);
    const id = this.charPrs.length;
    this.charPrs.push({ id, s });
    this.cpKeys.set(key, id);
    return id;
  }
  paraPr(spec) {
    const s = { align: 'JUSTIFY', line: 160, left: 0, indent: 0, prev: 0, next: 0, keepNext: false, ...spec };
    const key = JSON.stringify(s);
    if (this.ppKeys.has(key)) return this.ppKeys.get(key);
    const id = this.paraPrs.length;
    this.paraPrs.push({ id, s });
    this.ppKeys.set(key, id);
    return id;
  }

  xmlBorderFill({ id, spec }) {
    const side = (name, b) =>
      b
        ? `<hh:${name} type="${b.type || 'SOLID'}" width="${b.width || '0.12 mm'}" color="${b.color || '#000000'}"/>`
        : `<hh:${name} type="NONE" width="0.1 mm" color="#000000"/>`;
    let fill = '';
    if (spec.fill) fill = `<hc:fillBrush><hc:winBrush faceColor="${spec.fill}" hatchColor="#999999" alpha="0"/></hc:fillBrush>`;
    else if (spec.fillNone) fill = '<hc:fillBrush><hc:winBrush faceColor="none" hatchColor="#999999" alpha="0"/></hc:fillBrush>';
    return (
      `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">` +
      '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
      side('leftBorder', spec.left) +
      side('rightBorder', spec.right) +
      side('topBorder', spec.top) +
      side('bottomBorder', spec.bottom) +
      '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>' +
      fill +
      '</hh:borderFill>'
    );
  }
  xmlCharPr({ id, s }) {
    const f = FONT_ID[s.font] ?? 1;
    const seven = (v) => `hangul="${v}" latin="${v}" hanja="${v}" japanese="${v}" other="${v}" symbol="${v}" user="${v}"`;
    return (
      `<hh:charPr id="${id}" height="${s.size}" textColor="${s.color}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="${s.border || 2}">` +
      `<hh:fontRef ${seven(f)}/><hh:ratio ${seven(100)}/><hh:spacing ${seven(s.spacing ?? 0)}/><hh:relSz ${seven(100)}/><hh:offset ${seven(0)}/>` +
      (s.bold ? '<hh:bold/>' : '') +
      '<hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/>' +
      '</hh:charPr>'
    );
  }
  xmlParaPr({ id, s }) {
    const margin = (k) =>
      `<hh:margin><hc:intent value="${s.indent * k}" unit="HWPUNIT"/><hc:left value="${s.left * k}" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="${s.prev * k}" unit="HWPUNIT"/><hc:next value="${s.next * k}" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="PERCENT" value="${s.line}" unit="HWPUNIT"/>`;
    return (
      `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">` +
      `<hh:align horizontal="${s.align}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/>` +
      `<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="${s.keepNext ? 1 : 0}" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>` +
      '<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>' +
      `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${margin(1)}</hp:case><hp:default>${margin(2)}</hp:default></hp:switch>` +
      '<hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>' +
      '</hh:paraPr>'
    );
  }
  xml() {
    const typeInfo = '<hh:typeInfo familyType="FCAT_GOTHIC" weight="8" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>';
    const langs = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
    const fontfaces = langs
      .map(
        (lang) =>
          `<hh:fontface lang="${lang}" fontCnt="${FONTS.length}">` +
          FONTS.map((f, i) => `<hh:font id="${i}" face="${f}" type="TTF" isEmbedded="0">${typeInfo}</hh:font>`).join('') +
          '</hh:fontface>'
      )
      .join('');
    const styleNames = [
      ['바탕글', 'Normal'], ['본문', 'Body'], ['개요 1', 'Outline 1'], ['개요 2', 'Outline 2'], ['개요 3', 'Outline 3'],
      ['개요 4', 'Outline 4'], ['개요 5', 'Outline 5'], ['개요 6', 'Outline 6'], ['개요 7', 'Outline 7'],
    ];
    const styles =
      styleNames
        .map(([n, e], i) => `<hh:style id="${i}" type="PARA" name="${n}" engName="${e}" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="${i}" langID="1042" lockForm="0"/>`)
        .join('') +
      `<hh:style id="9" type="CHAR" name="쪽 번호" engName="Page Number" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/>`;
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hh:head ${NS} version="1.4" secCnt="1">` +
      '<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>' +
      '<hh:refList>' +
      `<hh:fontfaces itemCnt="7">${fontfaces}</hh:fontfaces>` +
      `<hh:borderFills itemCnt="${this.borderFills.length}">${this.borderFills.map((b) => this.xmlBorderFill(b)).join('')}</hh:borderFills>` +
      `<hh:charProperties itemCnt="${this.charPrs.length}">${this.charPrs.map((c) => this.xmlCharPr(c)).join('')}</hh:charProperties>` +
      '<hh:tabProperties itemCnt="2"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/><hh:tabPr id="1" autoTabLeft="1" autoTabRight="0"/></hh:tabProperties>' +
      '<hh:numberings itemCnt="1"><hh:numbering id="1" start="0">' +
      [['1', 'DIGIT', '^1.'], ['2', 'HANGUL_SYLLABLE', '^2.'], ['3', 'DIGIT', '^3)'], ['4', 'HANGUL_SYLLABLE', '^4)'], ['5', 'DIGIT', '(^5)'], ['6', 'HANGUL_SYLLABLE', '(^6)'], ['7', 'CIRCLED_DIGIT', '^7']]
        .map(([lv, fmt, txt]) => `<hh:paraHead start="1" level="${lv}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="${fmt}" charPrIDRef="4294967295" checkable="${lv === '7' ? 1 : 0}">${txt}</hh:paraHead>`)
        .join('') +
      '</hh:numbering></hh:numberings>' +
      `<hh:paraProperties itemCnt="${this.paraPrs.length}">${this.paraPrs.map((p) => this.xmlParaPr(p)).join('')}</hh:paraProperties>` +
      `<hh:styles itemCnt="10">${styles}</hh:styles>` +
      '</hh:refList>' +
      '<hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>' +
      '<hh:docOption><hh:linkinfo path="" pageInherit="1" footnoteInherit="0"/></hh:docOption>' +
      '<hh:trackchageConfig flags="56"/>' +
      '</hh:head>'
    );
  }
}

// ---------- 본문 조립 도구 ----------
class Writer {
  constructor(theme, mode, images) {
    this.h = new Header();
    this.th = theme;
    this.teacher = mode === 'teacher';
    this.images = images || {};
    this.bin = []; // {id, name, bytes, ext}
    this.binById = new Map();
    this.objId = 1900000000;
    this.z = 0;
    this.fontSize = 1000;
  }
  nextId() {
    this.objId += 7;
    return this.objId;
  }

  // 글자 모양 단축
  cp(o = {}) {
    return this.h.charPr(o);
  }
  pp(o = {}) {
    return this.h.paraPr(o);
  }

  para(runs, { pp = 0, pageBreak = false } = {}) {
    const body = runs.length ? runs.join('') : `<hp:run charPrIDRef="${this.cp({ size: this.fontSize })}"/>`;
    return `<hp:p id="0" paraPrIDRef="${pp}" styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0">${body}</hp:p>`;
  }
  text(t, cpId) {
    if (!t) return '';
    return `<hp:run charPrIDRef="${cpId}"><hp:t>${esc(t)}</hp:t></hp:run>`;
  }
  objRun(xml, cpId) {
    return `<hp:run charPrIDRef="${cpId}">${xml}<hp:t/></hp:run>`;
  }

  equation(latex, { color = '#000000', size } = {}) {
    const script = latexToHwp(latex);
    if (!script) return '';
    const base = size || this.fontSize;
    const m = measureHwpEquation(script, base);
    const id = this.nextId();
    return (
      `<hp:equation id="${id}" zOrder="${this.z++}" numberingType="EQUATION" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" version="Equation Version 60" baseLine="${m.baseLine}" textColor="${color}" baseUnit="${base}" lineMode="CHAR" font="HYhwpEQ">` +
      `<hp:sz width="${m.width}" widthRelTo="ABSOLUTE" height="${m.height}" heightRelTo="ABSOLUTE" protect="0"/>` +
      '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
      '<hp:outMargin left="56" right="56" top="0" bottom="0"/>' +
      '<hp:shapeComment>수식입니다.</hp:shapeComment>' +
      `<hp:script>${esc(script)}</hp:script>` +
      '</hp:equation>'
    );
  }
  eqWidth(latex, size) {
    const script = latexToHwp(latex);
    return script ? measureHwpEquation(script, size || this.fontSize).width + 112 : 0;
  }

  // 리치 텍스트 -> run 목록
  runs(src, { size, color, bold = false, font = 'batang' } = {}) {
    const fs = size || this.fontSize;
    const col = color || this.th.text;
    const nodes = parseRich(src);
    const out = [];
    for (const n of nodes) {
      if (n.t === 'text') {
        out.push(this.text(n.v, this.cp({ size: fs, color: col, bold: bold || n.b, font })));
      } else if (n.t === 'math') {
        out.push(this.objRun(this.equation(n.v, { size: fs, color: col }), this.cp({ size: fs, color: col, font })));
      } else if (n.t === 'blank') {
        out.push(this.text(' ', this.cp({ size: fs, color: col, font })));
        out.push(this.blankBox(n, fs));
        out.push(this.text(' ', this.cp({ size: fs, color: col, font })));
      }
    }
    return out;
  }

  // 정답 길이에 맞춘 너비 (HWPUNIT)
  answerWidth(nodes, fs) {
    let w = 0;
    for (const n of nodes) {
      if (n.t === 'text') for (const ch of n.v) w += (/[가-힣]/.test(ch) ? 1 : 0.55) * fs;
      else if (n.t === 'math') w += this.eqWidth(n.v, fs);
    }
    return w;
  }

  // 빈칸: 글자 테두리(char border)를 준 공백. 교사용에서 정답이 수식이면 글자처럼 취급하는 1칸 표
  blankBorder() {
    const line = { color: '#4A4A4A', width: '0.12 mm' };
    return this.h.borderFill({ left: line, right: line, top: line, bottom: line, fill: '#FFFFFF' });
  }
  blankBox(node, fs) {
    const bf = this.blankBorder();
    const hasMath = node.ans.some((n) => n.t === 'math');
    const ansW = this.answerWidth(node.ans, fs); // HWPUNIT
    const em = Math.max(blankEm(node), ansW / fs + 1.2);
    if (this.teacher && hasMath) {
      const pad = 200;
      const w = Math.round(Math.max(em * fs, ansW + pad * 2));
      const tall = node.ans.some((n) => n.t === 'math' && /\\d?frac|\\lim|\\sum|\\int|\\sqrt/.test(n.v));
      const h = Math.round(fs * (tall ? 2.4 : 1.5));
      const content = this.para(this.runsFromNodes(node.ans, { size: fs, color: this.th.answer, bold: true }), { pp: this.pp({ align: 'CENTER', line: 100 }) });
      return this.objRun(
        this.table({ widths: [w], rows: [[{ content, bf, margin: [56, 56, 28, 28], vAlign: 'CENTER', height: h }]], inline: true, tableBf: bf }),
        this.cp({ size: fs })
      );
    }
    if (this.teacher) {
      const t = node.ans.map((n) => (n.t === 'text' ? n.v : '')).join('').trim();
      const textEm = [...t].reduce((a, ch) => a + (/[가-힣]/.test(ch) ? 1 : 0.55), 0);
      const padEm = Math.max(0.5, (em - textEm) / 2);
      const padN = Math.max(1, Math.round(padEm / 0.5));
      const pad = ' '.repeat(padN);
      return this.text(`${pad}${t}${pad}`, this.cp({ size: fs, color: this.th.answer, bold: true, font: 'batang', border: bf }));
    }
    const n = Math.max(2, Math.round(em));
    return this.text('\u3000'.repeat(n), this.cp({ size: fs, color: this.th.text, font: 'batang', border: bf }));
  }
  runsFromNodes(nodes, { size, color, bold }) {
    const fs = size || this.fontSize;
    return nodes.map((n) =>
      n.t === 'text'
        ? this.text(n.v, this.cp({ size: fs, color, bold: bold || n.b }))
        : n.t === 'math'
          ? this.objRun(this.equation(n.v, { size: fs, color }), this.cp({ size: fs, color }))
          : ''
    );
  }

  // 문단 하나(리치 텍스트). 별행 수식이면 가운데 정렬
  richPara(src, opts = {}) {
    const nodes = parseRich(src);
    const center = isDisplayOnly(nodes);
    const pp = this.pp({ align: center ? 'CENTER' : opts.align || 'JUSTIFY', line: opts.line || 165, left: opts.left || 0, indent: opts.indent || 0, prev: opts.prev || 0, next: opts.next || 0 });
    return this.para(this.runs(src, opts), { pp });
  }

  picture(figId, maxW) {
    const img = this.images[figId];
    if (!img || !img.bytes) return '';
    let binId = this.binById.get(figId);
    if (!binId) {
      binId = `image${this.bin.length + 1}`;
      this.bin.push({ id: binId, name: `${binId}.${img.ext}`, bytes: img.bytes, ext: img.ext });
      this.binById.set(figId, binId);
    }
    // 교과서 쪽 너비 대비 그림 너비를 본문 너비에 맞춰 환산
    const natural = Math.round((img.frac || 0.4) * TEXT_W * 1.08);
    const w = Math.max(mm(18), Math.min(maxW, natural));
    const h = Math.round((w * img.h) / img.w);
    const id = this.nextId();
    const dimW = img.w * 75;
    const dimH = img.h * 75;
    const ident = 'e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"';
    const xml =
      `<hp:pic id="${id}" zOrder="${this.z++}" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${id}" reverse="0">` +
      `<hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/><hp:flip horizontal="0" vertical="0"/>` +
      `<hp:rotationInfo angle="0" centerX="${Math.round(w / 2)}" centerY="${Math.round(h / 2)}" rotateimage="1"/>` +
      `<hp:renderingInfo><hc:transMatrix ${ident}/><hc:scaMatrix ${ident}/><hc:rotMatrix ${ident}/></hp:renderingInfo>` +
      `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect>` +
      `<hp:imgClip left="0" right="${dimW}" top="0" bottom="${dimH}"/>` +
      '<hp:inMargin left="0" right="0" top="0" bottom="0"/>' +
      `<hp:imgDim dimwidth="${dimW}" dimheight="${dimH}"/>` +
      `<hc:img binaryItemIDRef="${binId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>` +
      '<hp:effects/>' +
      `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>` +
      '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
      '<hp:outMargin left="0" right="0" top="0" bottom="0"/>' +
      '<hp:shapeComment>교과서 그림</hp:shapeComment>' +
      '</hp:pic>';
    return xml;
  }
  // 그림 여러 개는 한 줄에 나란히
  figuresParas(ids, maxW) {
    const list = (ids || []).filter((id) => this.images[id] && this.images[id].bytes);
    if (!list.length) return [];
    const gap = mm(4);
    const each = list.length > 1 ? Math.floor((maxW - gap * (list.length - 1)) / list.length) : maxW;
    const runs = [];
    list.forEach((id, i) => {
      if (i) runs.push(this.text('    ', this.cp({})));
      runs.push(this.objRun(this.picture(id, each), this.cp({})));
    });
    return [this.para(runs, { pp: this.pp({ align: 'CENTER', line: 100, prev: 100, next: 100 }) })];
  }

  // 문단 XML에서 높이(HWPUNIT)를 대략 계산 (저장 크기를 그대로 쓰는 프로그램을 위해)
  estimateHeight(xml, width) {
    const objs = [];
    let body = String(xml || '').replace(/<hp:(tbl|pic|equation)\b[\s\S]*?<\/hp:\1>/g, (m) => {
      const sz = m.match(/<hp:sz width="(\d+)"[^>]*height="(\d+)"/);
      objs.push(sz ? { w: +sz[1], h: +sz[2] } : { w: 0, h: 0 });
      return `\u0001${objs.length - 1}\u0002`;
    });
    let total = 0;
    const paras = body.match(/<hp:p\b[\s\S]*?<\/hp:p>/g) || [];
    for (const p of paras) {
      const ppId = +(p.match(/paraPrIDRef="(\d+)"/) || [0, 0])[1];
      const pp = this.h.paraPrs[ppId]?.s || { line: 160, prev: 0, next: 0 };
      let size = 0;
      for (const m of p.matchAll(/charPrIDRef="(\d+)"/g)) size = Math.max(size, this.h.charPrs[+m[1]]?.s.size || 1000);
      if (!size) size = 1000;
      let w = 0;
      for (const m of p.matchAll(/<hp:t>([\s\S]*?)<\/hp:t>/g)) {
        const t = m[1].replace(/&[a-z]+;/g, 'x');
        for (const ch of t) w += (/[가-힣ㄱ-ㅎ\u3000]/.test(ch) ? 1 : 0.55) * size;
      }
      let tallest = 0;
      let objCount = 0;
      for (const m of p.matchAll(/\u0001(\d+)\u0002/g)) {
        const o = objs[+m[1]];
        w += o.w;
        tallest = Math.max(tallest, o.h);
        objCount++;
      }
      const lines = Math.max(1, Math.ceil(w / Math.max(1000, width)));
      const lineH = (size * pp.line) / 100;
      let h = lines * lineH;
      if (tallest > size * 1.6) h += (tallest - size * 1.2) * Math.min(objCount, lines, 2);
      total += h + (pp.prev || 0) + (pp.next || 0);
    }
    // 한컴은 저장된 칸 높이를 최소값으로 쓰므로, 남는 빈 공간이 생기지 않게 조금 작게 잡음
    return Math.round(total * 0.85);
  }

  // 표. rows: [[{content, bf, colSpan, rowSpan, margin:[l,r,t,b], vAlign, height}]]
  table({ widths, rows, inline = false, tableBf, pageBreak = 'TABLE', headerRows = 0 }) {
    const colCnt = widths.length;
    const occupied = [];
    const placed = []; // 1차: 칸 위치·필요 높이 계산
    rows.forEach((row, r) => {
      occupied[r] = occupied[r] || [];
      let c = 0;
      row.forEach((cell) => {
        while (occupied[r][c]) c++;
        const cs = cell.colSpan || 1;
        const rs = cell.rowSpan || 1;
        for (let rr = r; rr < r + rs; rr++) {
          occupied[rr] = occupied[rr] || [];
          for (let cc = c; cc < c + cs; cc++) occupied[rr][cc] = true;
        }
        const w = widths.slice(c, c + cs).reduce((a, b) => a + b, 0);
        const margin = cell.margin || [510, 510, 283, 283];
        const need = this.estimateHeight(cell.content, w - margin[0] - margin[1]) + margin[2] + margin[3];
        placed.push({ cell, r, c, cs, rs, w, margin, need: Math.max(cell.height || 0, need, 600) });
        c += cs;
      });
    });
    const rowH = rows.map(() => 0);
    placed.filter((p) => p.rs === 1).forEach((p) => (rowH[p.r] = Math.max(rowH[p.r], p.need)));
    rowH.forEach((h, i) => (rowH[i] = h || 1000));
    // 여러 줄을 합친 칸이 더 높으면 마지막 줄을 늘림
    placed
      .filter((p) => p.rs > 1)
      .forEach((p) => {
        const span = rowH.slice(p.r, p.r + p.rs).reduce((a, b) => a + b, 0);
        if (p.need > span) rowH[p.r + p.rs - 1] += p.need - span;
      });
    const totalH = rowH.reduce((a, b) => a + b, 0);
    const cellsXml = rows.map((_, r) =>
      `<hp:tr>${placed
        .filter((p) => p.r === r)
        .map((p) => {
          const h = rowH.slice(p.r, p.r + p.rs).reduce((a, b) => a + b, 0);
          const [ml, mr, mt, mb] = p.margin;
          return (
            `<hp:tc name="" header="${r < headerRows ? 1 : 0}" hasMargin="1" protect="0" editable="0" dirty="0" borderFillIDRef="${p.cell.bf || 1}">` +
            `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${p.cell.vAlign || 'TOP'}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">` +
            (p.cell.content || this.para([])) +
            '</hp:subList>' +
            `<hp:cellAddr colAddr="${p.c}" rowAddr="${p.r}"/><hp:cellSpan colSpan="${p.cs}" rowSpan="${p.rs}"/>` +
            `<hp:cellSz width="${p.w}" height="${h}"/><hp:cellMargin left="${ml}" right="${mr}" top="${mt}" bottom="${mb}"/>` +
            '</hp:tc>'
          );
        })
        .join('')}</hp:tr>`
    );
    const width = widths.reduce((a, b) => a + b, 0);
    const id = this.nextId();
    return (
      `<hp:tbl id="${id}" zOrder="${this.z++}" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="${inline ? 'NONE' : pageBreak}" repeatHeader="${headerRows ? 1 : 0}" rowCnt="${rows.length}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="${tableBf || 1}" noAdjust="0">` +
      `<hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${totalH}" heightRelTo="ABSOLUTE" protect="0"/>` +
      (inline
        ? '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="40" right="40" top="0" bottom="0"/>'
        : '<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/>') +
      '<hp:inMargin left="510" right="510" top="141" bottom="141"/>' +
      cellsXml.join('') +
      '</hp:tbl>'
    );
  }
  // 표를 담는 문단
  tablePara(tblXml, { pageBreak = false, keepNext = false } = {}) {
    return this.para([this.objRun(tblXml, this.cp({ size: 100 }))], { pp: this.pp({ align: 'LEFT', line: 100, keepNext }), pageBreak });
  }
  gap(size = 450, keepNext = false) {
    return this.para([`<hp:run charPrIDRef="${this.cp({ size })}"/>`], { pp: this.pp({ align: 'LEFT', line: 100, keepNext }) });
  }

  border(color, width = '0.12 mm', type = 'SOLID') {
    return { color, width, type };
  }
  // 바깥 테두리만 있는 칸 테두리 계산
  outlineBf({ r, c, rows, cols, rs = 1, cs = 1, color, width, type, fill }) {
    const b = this.border(color, width, type);
    return this.h.borderFill({
      left: c === 0 ? b : null,
      right: c + cs >= cols ? b : null,
      top: r === 0 ? b : null,
      bottom: r + rs >= rows ? b : null,
      fill,
    });
  }
}

// ---------- 학습지 블록 ----------
function lessonBanner(W, doc, lesson, pageBreak) {
  const th = W.th;
  const widths = [Math.round(TEXT_W * 0.17), 0, Math.round(TEXT_W * 0.15)];
  widths[1] = TEXT_W - widths[0] - widths[2];
  const subject = W.para([W.text(doc.subject || '학습지', W.cp({ size: 1300, color: '#FFFFFF', bold: true, font: 'dotum' }))], { pp: W.pp({ align: 'CENTER', line: 120 }) });
  const unit = doc.unit ? W.para([W.text(doc.unit, W.cp({ size: 750, color: '#DDE5F0', font: 'dotum' }))], { pp: W.pp({ align: 'CENTER', line: 120 }) }) : '';
  const titleRuns = [];
  if (lesson.chapterNo) titleRuns.push(W.text(`${lesson.chapterNo}  `, W.cp({ size: 1700, color: th.accent, bold: true, font: 'dotum' })));
  titleRuns.push(W.text(lesson.chapterTitle || lesson.topic || '', W.cp({ size: 1700, color: th.text, bold: true, font: 'dotum' })));
  if (lesson.topic && lesson.chapterTitle) titleRuns.push(W.text(`   ${lesson.topic}`, W.cp({ size: 1050, color: th.muted, font: 'dotum' })));
  const lessonNo = W.para(
    [W.text(`${lesson.no}`, W.cp({ size: 1700, color: '#FFFFFF', bold: true, font: 'dotum' })), W.text(' 차시', W.cp({ size: 1050, color: '#FFFFFF', bold: true, font: 'dotum' }))],
    { pp: W.pp({ align: 'CENTER', line: 120 }) }
  );
  const teacherTag = W.teacher ? W.para([W.text('교사용', W.cp({ size: 800, color: '#FFFFFF', bold: true, font: 'dotum' }))], { pp: W.pp({ align: 'CENTER', line: 110 }) }) : '';
  const thick = W.border(th.primary, '0.5 mm');
  const tbl = W.table({
    widths,
    rows: [
      [
        { content: subject + unit, bf: W.h.borderFill({ fill: th.primary }), vAlign: 'CENTER', height: mm(14), margin: [283, 283, 200, 200] },
        { content: W.para(titleRuns, { pp: W.pp({ align: 'LEFT', line: 130 }) }), bf: W.h.borderFill({ bottom: thick, top: thick }), vAlign: 'CENTER', margin: [850, 283, 200, 200] },
        { content: lessonNo + teacherTag, bf: W.h.borderFill({ fill: th.lessonBox }), vAlign: 'CENTER', margin: [200, 200, 200, 200] },
      ],
    ],
  });
  return W.tablePara(tbl, { pageBreak });
}

function infoTable(W, lesson) {
  const th = W.th;
  const line = W.border(th.line, '0.12 mm');
  const all = { left: line, right: line, top: line, bottom: line };
  const label = W.h.borderFill({ ...all, fill: th.headSoft });
  const plain = W.h.borderFill(all);
  const lab = (t) => W.para([W.text(t, W.cp({ size: 900, color: th.primary, bold: true, font: 'dotum' }))], { pp: W.pp({ align: 'CENTER', line: 120 }) });
  const val = (t, align = 'LEFT', color = th.text) => W.para(t ? [W.text(t, W.cp({ size: 950, color, font: 'batang' }))] : [], { pp: W.pp({ align, line: 130 }) });
  const f = [0.14, 0.27, 0.1, 0.27, 0.09, 0.13].map((x) => Math.round(TEXT_W * x));
  f[5] = TEXT_W - f.slice(0, 5).reduce((a, b) => a + b, 0);
  const h = mm(7);
  const m = [283, 283, 140, 140];
  return W.tablePara(
    W.table({
      widths: f,
      rows: [
        [
          { content: lab('학습목표'), bf: label, vAlign: 'CENTER', height: h, margin: m },
          { content: val(lesson.objective), bf: plain, colSpan: 5, vAlign: 'CENTER', height: h, margin: [567, 283, 140, 140] },
        ],
        [
          { content: lab('학번'), bf: label, vAlign: 'CENTER', height: h, margin: m },
          { content: val(''), bf: plain, vAlign: 'CENTER', height: h, margin: m },
          { content: lab('이름'), bf: label, vAlign: 'CENTER', height: h, margin: m },
          { content: val(''), bf: plain, vAlign: 'CENTER', height: h, margin: m },
          { content: lab('날짜'), bf: label, vAlign: 'CENTER', height: h, margin: m },
          { content: val('월      일', 'RIGHT', th.muted), bf: plain, vAlign: 'CENTER', height: h, margin: m },
        ],
      ],
    })
  );
}

function sectionHeader(W, no, sec) {
  const keep = true;
  const th = W.th;
  const thick = W.border(th.primary, '0.4 mm');
  const widths = [mm(8), 0, mm(36)];
  widths[1] = TEXT_W - widths[0] - widths[2];
  return W.tablePara(
    W.table({
      widths,
      rows: [
        [
          { content: W.para([W.text(String(no), W.cp({ size: 1100, color: '#FFFFFF', bold: true, font: 'dotum' }))], { pp: W.pp({ align: 'CENTER', line: 120 }) }), bf: W.h.borderFill({ fill: th.primary, bottom: thick }), vAlign: 'CENTER', height: mm(7.5), margin: [100, 100, 100, 100] },
          { content: W.para(W.runs(sec.title, { size: 1300, color: th.text, bold: true, font: 'dotum' }), { pp: W.pp({ align: 'LEFT', line: 120 }) }), bf: W.h.borderFill({ bottom: thick }), vAlign: 'CENTER', margin: [425, 200, 100, 100] },
          { content: W.para(sec.pages ? [W.text(`교과서 ${sec.pages}쪽`, W.cp({ size: 850, color: th.muted, font: 'dotum' }))] : [], { pp: W.pp({ align: 'RIGHT', line: 120 }) }), bf: W.h.borderFill({ bottom: thick }), vAlign: 'BOTTOM', margin: [200, 200, 100, 100] },
        ],
      ],
    }),
    { keepNext: keep }
  );
}

// 왼쪽 색 막대 + 내용 (+ 오른쪽 그림)
function barBox(W, { barColor, soft, contentParas: paras, figureIds, borderColor, dotted = false }) {
  let contentParas = paras;
  let figs = figureIds && figureIds.length ? figureIds : [];
  if (figs.length >= 2) {
    contentParas = [...contentParas, ...W.figuresParas(figs, TEXT_W - BAR_W - mm(12))];
    figs = [];
  }
  const figW = figs.length ? Math.round(TEXT_W * 0.3) : 0;
  const widths = barColor ? [BAR_W, TEXT_W - BAR_W - figW] : [TEXT_W - figW];
  if (figW) widths.push(figW);
  const line = borderColor ? W.border(borderColor, '0.12 mm', dotted ? 'DOT' : 'SOLID') : null;
  const cells = [];
  if (barColor) cells.push({ content: W.para([]), bf: W.h.borderFill({ fill: barColor }), margin: [0, 0, 0, 0], height: 1000 });
  const mainBf = W.h.borderFill({ fill: soft || undefined, top: line, bottom: line, left: barColor ? null : line, right: figW ? null : line });
  cells.push({ content: contentParas.join('') || W.para([]), bf: mainBf, margin: [567, 425, 283, 283] });
  if (figW) {
    const figBf = W.h.borderFill({ fill: soft || undefined, top: line, bottom: line, right: line });
    cells.push({ content: W.figuresParas(figs, figW - 400).join('') || W.para([]), bf: figBf, vAlign: 'CENTER', margin: [100, 200, 200, 200] });
  }
  return W.tablePara(W.table({ widths, rows: [cells] }));
}

function titleLine(W, mark, label, title, color, extra) {
  const runs = [W.text(`${mark} ${label}`, W.cp({ size: 1000, color, bold: true, font: 'dotum' }))];
  if (title) runs.push(...W.runs(` · ${title}`, { size: 1000, color, bold: true, font: 'dotum' }));
  if (extra) runs.push(W.text(`   ${extra}`, W.cp({ size: 850, color: W.th.muted, font: 'dotum' })));
  return W.para(runs, { pp: W.pp({ align: 'LEFT', line: 150, next: 100 }) });
}

function answerParas(W, a, sol) {
  const out = [];
  const red = W.th.answer;
  if (a) out.push(W.para([W.text('정답  ', W.cp({ size: 900, color: red, bold: true, font: 'dotum' })), ...W.runs(a, { size: 950, color: red, bold: true })], { pp: W.pp({ align: 'LEFT', line: 160, prev: 150 }) }));
  if (sol) {
    String(sol)
      .split(/\n+/)
      .filter((s) => s.trim())
      .forEach((line, i) => {
        const runs = [];
        if (i === 0) runs.push(W.text('풀이  ', W.cp({ size: 850, color: red, bold: true, font: 'dotum' })));
        runs.push(...W.runs(line, { size: 900, color: red }));
        out.push(W.para(runs, { pp: W.pp({ align: 'LEFT', line: 160 }) }));
      });
  }
  return out;
}

const SPACE_LINES = { s: 2, m: 4, l: 7 };

function problemsBlock(W, b) {
  const th = W.th;
  const cols = Math.max(1, Math.min(3, b.cols || 1));
  const figs = b.figures || [];
  const figW = figs.length ? Math.round(TEXT_W * 0.32) : 0;
  const mainW = TEXT_W - figW;
  const colW = Math.floor(mainW / cols);
  const widths = Array(cols).fill(colW);
  widths[cols - 1] = mainW - colW * (cols - 1);
  if (figW) widths.push(figW);
  const nCols = widths.length;

  const headRuns = [W.text(`${b.label}`, W.cp({ size: 1000, color: th.problem, bold: true, font: 'dotum' })), W.text('    ', W.cp({ size: 1000 }))];
  headRuns.push(...W.runs(b.instruction, { size: 1000, color: th.text, font: 'batang' }));
  if (b.pages) headRuns.push(W.text(`   [교과서 ${b.pages}쪽]`, W.cp({ size: 850, color: th.muted, font: 'dotum' })));
  const line = W.border(th.problemLine, '0.12 mm');

  const itemRows = [];
  for (let i = 0; i < b.items.length; i += cols) itemRows.push(b.items.slice(i, i + cols));
  const stemRows = b.stem && b.stem.length ? 1 : 0;
  const totalRows = 1 + stemRows + Math.max(1, itemRows.length);

  const rows = [];
  rows.push([
    {
      content: W.para(headRuns, { pp: W.pp({ align: 'LEFT', line: 150 }) }),
      colSpan: nCols,
      bf: W.h.borderFill({ fill: th.problemSoft, top: line, bottom: line, left: line, right: line }),
      vAlign: 'CENTER',
      margin: [567, 425, 200, 200],
    },
  ]);
  if (stemRows) {
    rows.push([
      {
        content: b.stem.map((s) => W.richPara(s, { line: 170 })).join(''),
        colSpan: figW ? cols : nCols,
        bf: W.outlineBf({ r: 1, c: 0, rows: totalRows, cols: nCols, cs: figW ? cols : nCols, color: th.problemLine }),
        margin: [567, 425, 283, 100],
      },
      ...(figW
        ? [
            {
              content: W.figuresParas(figs, figW - 400).join(''),
              rowSpan: totalRows - 1,
              bf: W.outlineBf({ r: 1, c: nCols - 1, rows: totalRows, cols: nCols, rs: totalRows - 1, color: th.problemLine }),
              vAlign: 'CENTER',
              margin: [100, 200, 200, 200],
            },
          ]
        : []),
    ]);
  }
  const lines = SPACE_LINES[b.space] ?? 4;
  (itemRows.length ? itemRows : [[]]).forEach((group, gi) => {
    const r = 1 + stemRows + gi;
    const cells = [];
    for (let c = 0; c < cols; c++) {
      const it = group[c];
      const paras = [];
      if (it) {
        const num = b.items.length > 1 ? `(${b.items.indexOf(it) + 1}) ` : '';
        const nodesSrc = `${num}${it.q}`;
        paras.push(W.richPara(nodesSrc, { line: 170, left: 0 }));
        if (it.figures && it.figures.length) paras.push(...W.figuresParas(it.figures, widths[c] - 900));
        if (W.teacher) paras.push(...answerParas(W, it.a, it.sol));
        else for (let k = 0; k < lines; k++) paras.push(W.para([]));
      } else paras.push(W.para([]));
      cells.push({
        content: paras.join(''),
        bf: W.outlineBf({ r, c, rows: totalRows, cols: nCols, color: th.problemLine }),
        margin: [567, 425, 283, 200],
      });
    }
    if (figW && !stemRows && gi === 0) {
      cells.push({
        content: W.figuresParas(figs, figW - 400).join(''),
        rowSpan: totalRows - 1,
        bf: W.outlineBf({ r, c: nCols - 1, rows: totalRows, cols: nCols, rs: totalRows - 1, color: th.problemLine }),
        vAlign: 'CENTER',
        margin: [100, 200, 200, 200],
      });
    }
    rows.push(cells);
  });
  // 소문항 줄이 적으면 표 전체를 한 쪽에 두고(머리줄만 남는 일 방지), 많으면 줄 단위로 나눔
  const small = itemRows.length <= 3;
  return W.tablePara(W.table({ widths, rows, pageBreak: small ? 'NONE' : 'CELL', headerRows: small ? 0 : 1 }));
}

function checkBlock(W, b) {
  const th = W.th;
  const cols = Math.max(1, Math.min(3, b.cols || 2));
  const figs = b.figures || [];
  const figW = figs.length ? Math.round(TEXT_W * 0.28) : 0;
  const mainW = TEXT_W - figW;
  const colW = Math.floor(mainW / cols);
  const widths = Array(cols).fill(colW);
  widths[cols - 1] = mainW - colW * (cols - 1);
  if (figW) widths.push(figW);
  const nCols = widths.length;
  const groups = [];
  for (let i = 0; i < b.items.length; i += cols) groups.push(b.items.slice(i, i + cols));
  const totalRows = 1 + Math.max(1, groups.length);
  const dot = { color: th.checkLine, type: 'DOT', width: '0.12 mm' };
  const bf = (r, c, rs = 1, cs = 1) => W.outlineBf({ r, c, rows: totalRows, cols: nCols, rs, cs, ...dot });
  const rows = [
    [
      {
        content: titleLine(W, '●', b.title, '', th.primary, b.source),
        colSpan: figW ? cols : nCols,
        bf: bf(0, 0, 1, figW ? cols : nCols),
        margin: [567, 425, 200, 0],
      },
      ...(figW
        ? [{ content: W.figuresParas(figs, figW - 400).join(''), rowSpan: totalRows, bf: bf(0, nCols - 1, totalRows, 1), vAlign: 'CENTER', margin: [100, 200, 150, 150] }]
        : []),
    ],
  ];
  (groups.length ? groups : [[]]).forEach((g, gi) => {
    const cells = [];
    for (let c = 0; c < cols; c++) {
      cells.push({ content: g[c] ? W.richPara(g[c], { line: 180 }) : W.para([]), bf: bf(gi + 1, c), margin: [567, 283, 60, 160] });
    }
    rows.push(cells);
  });
  return W.tablePara(W.table({ widths, rows, pageBreak: 'NONE' }));
}

function tableBlock(W, b) {
  const th = W.th;
  const n = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1);
  const colW = Math.floor(TEXT_W / n);
  const widths = Array(n).fill(colW);
  widths[n - 1] = TEXT_W - colW * (n - 1);
  const line = W.border(th.line, '0.12 mm');
  const all = { left: line, right: line, top: line, bottom: line };
  const rows = [];
  if (b.header.length) {
    rows.push(
      Array.from({ length: n }, (_, i) => ({
        content: W.para(b.header[i] ? W.runs(b.header[i], { size: 950, color: th.primary, bold: true, font: 'dotum' }) : [], { pp: W.pp({ align: 'CENTER', line: 150 }) }),
        bf: W.h.borderFill({ ...all, fill: th.headSoft }),
        vAlign: 'CENTER',
        margin: [283, 283, 140, 140],
      }))
    );
  }
  b.rows.forEach((r) => {
    rows.push(Array.from({ length: n }, (_, i) => ({ content: r[i] ? W.richPara(r[i], { line: 160, align: 'CENTER' }) : W.para([]), bf: W.h.borderFill(all), vAlign: 'CENTER', margin: [283, 283, 140, 140] })));
  });
  const out = [];
  if (b.title) out.push(W.para(W.runs(`▣ ${b.title}`, { size: 1000, color: th.primary, bold: true, font: 'dotum' }), { pp: W.pp({ align: 'LEFT', line: 150, keepNext: true }) }));
  out.push(W.tablePara(W.table({ widths, rows, pageBreak: 'CELL' })));
  return out.join('');
}

function blockXml(W, b) {
  const th = W.th;
  switch (b.type) {
    case 'explore':
      return barBox(W, { soft: th.exploreSoft, borderColor: th.line, contentParas: b.items.map((s) => W.richPara(s, { line: 175 })), figureIds: b.figures });
    case 'concept': {
      const paras = [titleLine(W, '■', '핵심 개념', b.title, th.conceptBar)];
      b.items.forEach((s) => paras.push(W.richPara(s, { line: 175 })));
      if (b.note) paras.push(W.richPara(b.note, { size: 880, color: th.muted, line: 160 }));
      return barBox(W, { barColor: th.conceptBar, soft: th.conceptSoft, contentParas: paras, figureIds: b.figures });
    }
    case 'strategy': {
      const paras = [titleLine(W, '★', '풀이 전략', b.title, th.strategy)];
      b.items.forEach((s) => paras.push(W.richPara(s, { line: 175 })));
      if (b.tip) paras.push(W.richPara(`★ ${b.tip}`, { size: 880, color: th.muted, line: 160 }));
      return barBox(W, { barColor: th.strategy, soft: th.strategySoft, contentParas: paras, figureIds: b.figures });
    }
    case 'check':
      return checkBlock(W, b);
    case 'table':
      return tableBlock(W, b);
    case 'problems':
      return problemsBlock(W, b);
    case 'think': {
      const paras = [titleLine(W, '▶', b.title || '생각해보기', '', th.think, b.pages ? `[교과서 ${b.pages}쪽]` : '')];
      b.items.forEach((it, i) => {
        const num = b.items.length > 1 ? `${'①②③④⑤⑥⑦⑧⑨'[i] || `(${i + 1})`} ` : '';
        paras.push(W.richPara(`${num}${it.q}`, { line: 175 }));
        if (W.teacher) paras.push(...answerParas(W, it.a, it.sol));
        else for (let k = 0; k < 4; k++) paras.push(W.para([]));
      });
      return barBox(W, { barColor: th.think, soft: th.thinkSoft, contentParas: paras, figureIds: b.figures });
    }
    default:
      return '';
  }
}

function sectionXml(W, doc) {
  const parts = [];
  const sp = W.th;
  // 첫 문단: 구역 정의 + 쪽 번호
  const secPr =
    '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">' +
    '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>' +
    '<hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>' +
    '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>' +
    '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>' +
    `<hp:pagePr landscape="WIDELY" width="${PAGE_W}" height="${PAGE_H}" gutterType="LEFT_ONLY">` +
    `<hp:margin header="${mm(5)}" footer="${mm(6)}" gutter="0" left="${MARGIN_LR}" right="${MARGIN_LR}" top="${mm(10)}" bottom="${mm(10)}"/>` +
    '</hp:pagePr>' +
    '<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>' +
    '<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>' +
    ['BOTH', 'EVEN', 'ODD']
      .map((t) => `<hp:pageBorderFill type="${t}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`)
      .join('') +
    '</hp:secPr>';
  const first =
    `<hp:p id="0" paraPrIDRef="${W.pp({ align: 'LEFT', line: 100 })}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">` +
    `<hp:run charPrIDRef="${W.cp({ size: 100 })}">${secPr}<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>` +
    '<hp:ctrl><hp:pageNum pos="BOTTOM_CENTER" formatType="DIGIT" sideChar="-"/></hp:ctrl><hp:t/></hp:run></hp:p>';
  parts.push(first);

  doc.lessons.forEach((lesson, li) => {
    parts.push(lessonBanner(W, doc, lesson, li > 0));
    parts.push(W.gap(300));
    parts.push(infoTable(W, lesson));
    if (lesson.review) {
      parts.push(W.gap(400));
      const paras = [titleLine(W, '◆', '지난 시간 정리', lesson.review.title, sp.review)];
      lesson.review.items.forEach((s) => paras.push(W.richPara(s, { line: 170 })));
      parts.push(barBox(W, { barColor: sp.review, soft: sp.reviewSoft, contentParas: paras }));
    }
    lesson.sections.forEach((sec, si) => {
      parts.push(W.gap(700));
      parts.push(sectionHeader(W, si + 1, sec));
      sec.blocks.forEach((b, bi) => {
        parts.push(W.gap(bi === 0 ? 150 : 350, bi === 0));
        parts.push(blockXml(W, b));
      });
    });
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec ${NS}>${parts.join('')}</hs:sec>`;
}

function contentHpf(W, title) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const items = W.bin.map((b) => `<opf:item id="${b.id}" href="BinData/${b.name}" media-type="image/${b.ext === 'jpg' ? 'jpg' : b.ext}" isEmbeded="1"/>`).join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><opf:package ${NS.replace(/xmlns:opf="[^"]+"/, '')} xmlns:opf="http://www.idpf.org/2007/opf/" version="" unique-identifier="" id="">` +
    `<opf:metadata><opf:title>${esc(title)}</opf:title><opf:language>ko</opf:language><opf:meta name="creator" content="text">맞춤형 학습지 생성기</opf:meta><opf:meta name="subject" content="text"/><opf:meta name="description" content="text"/><opf:meta name="lastsaveby" content="text">맞춤형 학습지 생성기</opf:meta><opf:meta name="CreatedDate" content="text">${now}</opf:meta><opf:meta name="ModifiedDate" content="text">${now}</opf:meta><opf:meta name="date" content="text"/><opf:meta name="keyword" content="text"/></opf:metadata>` +
    `<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>${items}<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest>` +
    '<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>'
  );
}

function previewText(doc) {
  const lines = [];
  doc.lessons.forEach((l) => {
    lines.push(`${doc.subject} ${l.chapterNo} ${l.chapterTitle} ${l.topic} (${l.no}차시)`);
    l.sections.forEach((s) => lines.push(s.title));
  });
  return lines.join('\r\n').slice(0, 1000);
}

// images: { [figureId]: { bytes: Uint8Array, ext: 'png'|'jpg', w, h, frac } }
export function buildHwpx(doc, { mode = 'student', theme = 'navy', images = {} } = {}) {
  const W = new Writer(getTheme(theme), mode, images);
  const section = sectionXml(W, doc);
  const header = W.h.xml();
  const title = `${doc.subject || '학습지'} ${doc.lessons[0]?.chapterTitle || ''}`.trim();
  const files = {};
  files.mimetype = [strToU8('application/hwp+zip'), { level: 0 }];
  files['version.xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.4" application="Hancom Office Hangul" appVersion="12, 0, 0, 0 WIN32LEWindows_10"/>'
  );
  files['Contents/header.xml'] = strToU8(header);
  files['Contents/section0.xml'] = strToU8(section);
  files['Preview/PrvText.txt'] = strToU8(previewText(doc));
  files['settings.xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>'
  );
  W.bin.forEach((b) => (files[`BinData/${b.name}`] = [b.bytes, { level: 0 }]));
  files['META-INF/container.xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/><ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/></ocf:rootfiles></ocf:container>'
  );
  files['Contents/content.hpf'] = strToU8(contentHpf(W, title));
  files['META-INF/manifest.xml'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>');
  return zipSync(files, { level: 6, mtime: new Date('2026-01-01T00:00:00') });
}
