'use client';

// 학습지 미리보기 (HWPX와 같은 구성·색으로 화면에 그림)
import { Fragment, useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { parseRich, isDisplayOnly, blankEm } from '../lib/rich';
import { getTheme } from '../lib/themes';

const mathCache = new Map();
function mathHtml(src, display) {
  const key = `${display ? 'D' : 'I'}${src}`;
  if (mathCache.has(key)) return mathCache.get(key);
  let html;
  try {
    html = katex.renderToString(src, { throwOnError: false, strict: 'ignore', displayMode: !!display, output: 'html' });
  } catch {
    html = src.replace(/[<>&]/g, '');
  }
  if (mathCache.size > 3000) mathCache.clear();
  mathCache.set(key, html);
  return html;
}

function Nodes({ nodes, teacher }) {
  return nodes.map((n, i) => {
    if (n.t === 'text') return n.b ? <b key={i}>{n.v}</b> : <Fragment key={i}>{n.v}</Fragment>;
    if (n.t === 'math') return <span key={i} className="m" dangerouslySetInnerHTML={{ __html: mathHtml(n.v, false) }} />;
    if (n.t === 'blank') {
      const em = blankEm(n);
      return (
        <span key={i} className={`blank ${teacher ? 'filled' : ''}`} style={{ minWidth: `${em}em` }}>
          {teacher ? <Nodes nodes={n.ans} teacher={false} /> : ' '}
        </span>
      );
    }
    return null;
  });
}

function Rich({ src, teacher, className = '' }) {
  const nodes = useMemo(() => parseRich(src), [src]);
  if (isDisplayOnly(nodes)) {
    const m = nodes.find((n) => n.t === 'math');
    return <p className={`rp center ${className}`} dangerouslySetInnerHTML={{ __html: mathHtml(m.v, true) }} />;
  }
  return (
    <p className={`rp ${className}`}>
      <Nodes nodes={nodes} teacher={teacher} />
    </p>
  );
}

function Inline({ src, teacher }) {
  const nodes = useMemo(() => parseRich(src), [src]);
  return <Nodes nodes={nodes} teacher={teacher} />;
}

function Figures({ ids, figs, onEditFigure, onRemoveFigure, row }) {
  const list = (ids || []).filter((id) => figs[id]);
  if (!list.length) return null;
  return (
    <div className={`figs ${row || list.length > 1 ? 'row' : ''}`}>
      {list.map((id) => {
        const f = figs[id];
        const width = list.length > 1 ? `${Math.min(100 / list.length - 2, Math.max(18, f.frac * 108))}%` : `${Math.min(100, Math.max(30, f.frac * 300))}%`;
        return (
          <figure key={id} className="fig" style={{ width }}>
            <img src={f.dataUrl} alt={f.desc || '교과서 그림'} />
            {onEditFigure ? (
              <span className="fig-tools no-print">
                <button type="button" onClick={() => onEditFigure(id)}>
                  ✂ 위치 조정
                </button>
                <button type="button" onClick={() => onRemoveFigure(id)}>
                  삭제
                </button>
              </span>
            ) : null}
          </figure>
        );
      })}
    </div>
  );
}

function Answer({ a, sol, teacher }) {
  if (!teacher || (!a && !sol)) return null;
  return (
    <div className="answer">
      {a ? (
        <p className="rp">
          <b className="ans-label">정답</b> <Inline src={a} teacher={false} />
        </p>
      ) : null}
      {sol
        ? String(sol)
            .split(/\n+/)
            .filter((s) => s.trim())
            .map((line, i) => (
              <p key={i} className="rp sol">
                {i === 0 ? <b className="ans-label">풀이</b> : null} <Inline src={line} teacher={false} />
              </p>
            ))
        : null}
    </div>
  );
}

const SPACE = { s: '18mm', m: '32mm', l: '52mm' };

function AddFig({ tools, path }) {
  if (!tools.onAddFigure) return null;
  return (
    <button type="button" className="add-fig no-print" onClick={() => tools.onAddFigure(path)} title="교과서에서 그림을 골라 이 칸에 넣습니다">
      + 그림
    </button>
  );
}

function Block({ b, teacher, figs, tools, path }) {
  const sideFig = (b.figures || []).filter((id) => figs[id]).length === 1;
  const figEl = <Figures ids={b.figures} figs={figs} onEditFigure={tools.onEditFigure} onRemoveFigure={tools.onRemoveFigure} />;
  const add = <AddFig tools={tools} path={path} />;
  switch (b.type) {
    case 'explore':
      return (
        <div className={`blk explore ${sideFig ? 'with-fig' : ''}`}>
          {add}
          <div className="body">
            {b.items.map((s, i) => (
              <Rich key={i} src={s} teacher={teacher} />
            ))}
            {!sideFig ? figEl : null}
          </div>
          {sideFig ? <div className="side">{figEl}</div> : null}
        </div>
      );
    case 'concept':
    case 'strategy': {
      const isC = b.type === 'concept';
      return (
        <div className={`blk bar ${b.type} ${sideFig ? 'with-fig' : ''}`}>
          {add}
          <div className="body">
            <p className="btitle">
              {isC ? '■ 핵심 개념' : '★ 풀이 전략'}
              {b.title ? <Inline src={` · ${b.title}`} teacher={teacher} /> : null}
            </p>
            {b.items.map((s, i) => (
              <Rich key={i} src={s} teacher={teacher} />
            ))}
            {b.note ? <Rich src={b.note} teacher={teacher} className="note" /> : null}
            {b.tip ? <Rich src={`★ ${b.tip}`} teacher={teacher} className="note" /> : null}
            {!sideFig ? figEl : null}
          </div>
          {sideFig ? <div className="side">{figEl}</div> : null}
        </div>
      );
    }
    case 'check':
      return (
        <div className={`blk check ${sideFig ? 'with-fig' : ''}`}>
          {add}
          <div className="body">
            <p className="btitle">
              ● {b.title}
              {b.source ? <span className="src"> {b.source}</span> : null}
            </p>
            <div className={`grid c${b.cols}`}>
              {b.items.map((s, i) => (
                <Rich key={i} src={s} teacher={teacher} />
              ))}
            </div>
            {!sideFig ? figEl : null}
          </div>
          {sideFig ? <div className="side">{figEl}</div> : null}
        </div>
      );
    case 'table':
      return (
        <div className="blk tbl">
          {b.title ? (
            <p className="btitle">
              ▣ <Inline src={b.title} teacher={teacher} />
            </p>
          ) : null}
          <table>
            {b.header.length ? (
              <thead>
                <tr>
                  {b.header.map((h, i) => (
                    <th key={i}>
                      <Inline src={h} teacher={teacher} />
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>
                      <Inline src={c} teacher={teacher} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'problems':
      return (
        <div className={`blk problems ${sideFig ? 'with-fig' : ''}`}>
          {add}
          <div className="phead">
            <b>{b.label}</b>
            <span className="inst">
              <Inline src={b.instruction} teacher={teacher} />
            </span>
            {b.pages ? <span className="src">[교과서 {b.pages}쪽]</span> : null}
          </div>
          <div className="pbody">
            <div className="pmain">
              {(b.stem || []).map((s, i) => (
                <Rich key={i} src={s} teacher={teacher} />
              ))}
              {!sideFig ? figEl : null}
              <div className={`grid c${b.cols}`}>
                {b.items.map((it, i) => (
                  <div key={it.id} className="pitem">
                    <Rich src={`${b.items.length > 1 ? `(${i + 1}) ` : ''}${it.q}`} teacher={teacher} />
                    <Figures ids={it.figures} figs={figs} onEditFigure={tools.onEditFigure} onRemoveFigure={tools.onRemoveFigure} />
                    {teacher ? <Answer a={it.a} sol={it.sol} teacher /> : <div style={{ height: SPACE[b.space] || SPACE.m }} />}
                  </div>
                ))}
              </div>
            </div>
            {sideFig ? <div className="side">{figEl}</div> : null}
          </div>
        </div>
      );
    case 'think':
      return (
        <div className="blk bar think">
          {add}
          <div className="body">
            <p className="btitle">
              ▶ {b.title}
              {b.pages ? <span className="src"> [교과서 {b.pages}쪽]</span> : null}
            </p>
            {b.items.map((it, i) => (
              <div key={it.id} className="titem">
                <Rich src={`${b.items.length > 1 ? `${'①②③④⑤⑥⑦⑧⑨'[i] || `(${i + 1})`} ` : ''}${it.q}`} teacher={teacher} />
                {teacher ? <Answer a={it.a} sol={it.sol} teacher /> : <div style={{ height: '26mm' }} />}
              </div>
            ))}
            {figEl}
          </div>
        </div>
      );
    default:
      return null;
  }
}

export default function WorksheetView({ doc, figs = {}, teacher = false, theme = 'navy', onEditFigure, onRemoveFigure, onAddFigure }) {
  const th = getTheme(theme);
  const style = Object.fromEntries(Object.entries(th).filter(([k]) => k !== 'name').map(([k, v]) => [`--${k}`, v]));
  const tools = onEditFigure ? { onEditFigure, onRemoveFigure, onAddFigure } : {};
  return (
    <div className={`wsdoc ${teacher ? 'teacher' : ''}`} style={style}>
      {doc.lessons.map((l, li) => (
        <section key={li} className="ws-page">
          <table className="banner">
            <tbody>
              <tr>
                <td className="subj">
                  <div className="s1">{doc.subject || '학습지'}</div>
                  {doc.unit ? <div className="s2">{doc.unit}</div> : null}
                </td>
                <td className="ttl">
                  {l.chapterNo ? <span className="no">{l.chapterNo}</span> : null}
                  <span className="t">{l.chapterTitle || l.topic}</span>
                  {l.topic && l.chapterTitle ? <span className="tp">{l.topic}</span> : null}
                </td>
                <td className="lsn">
                  <span className="n">{l.no}</span> 차시
                  {teacher ? <div className="tt">교사용</div> : null}
                </td>
              </tr>
            </tbody>
          </table>
          <table className="info">
            <tbody>
              <tr>
                <th>학습목표</th>
                <td colSpan={5}>{l.objective}</td>
              </tr>
              <tr>
                <th>학번</th>
                <td />
                <th>이름</th>
                <td />
                <th>날짜</th>
                <td className="date">월&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;일</td>
              </tr>
            </tbody>
          </table>
          {l.review ? (
            <div className="blk bar review">
              <div className="body">
                <p className="btitle">
                  ◆ 지난 시간 정리{l.review.title ? <Inline src={` · ${l.review.title}`} teacher={teacher} /> : null}
                </p>
                {l.review.items.map((s, i) => (
                  <Rich key={i} src={s} teacher={teacher} />
                ))}
              </div>
            </div>
          ) : null}
          {l.sections.map((s, si) => (
            <div key={si} className="sec">
              <div className="sechead">
                <span className="num">{si + 1}</span>
                <span className="title">
                  <Inline src={s.title} teacher={teacher} />
                </span>
                {s.pages ? <span className="pages">교과서 {s.pages}쪽</span> : null}
              </div>
              {s.blocks.map((b, bi) => (
                <Block key={bi} b={b} teacher={teacher} figs={figs} tools={tools} path={[li, si, bi]} />
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
