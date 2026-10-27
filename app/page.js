'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WorksheetView from '../components/WorksheetView';
import CropEditor from '../components/CropEditor';
import { PROVIDERS, generate } from '../lib/llm';
import { buildSystemPrompt, buildUserInstruction, VERIFY_SYSTEM, buildVerifyInstruction, buildReviseInstruction } from '../lib/prompt';
import { parseModelJson } from '../lib/jsonRepair';
import { normalizeDoc, collectAnswerItems, applyAnswerFixes } from '../lib/doc';
import { THEMES } from '../lib/themes';
import { SAMPLE_DOC } from '../lib/sample';
import { SAMPLE_IMAGES } from '../lib/sampleImages';

const LS = 'worksheet-settings-v2';
const loadSettings = () => {
  try {
    return JSON.parse(localStorage.getItem(LS) || '{}');
  } catch {
    return {};
  }
};
const saveSettings = (s) => {
  try {
    localStorage.setItem(LS, JSON.stringify(s));
  } catch {}
};

function downloadBlob(bytes, name, type) {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').slice(0, 60);

export default function Home() {
  // ----- AI 설정 -----
  const [provider, setProvider] = useState('gemini');
  const [conf, setConf] = useState({}); // {gemini:{key,model}, anthropic:{...}, compat:{key,model,baseUrl}}
  const [remember, setRemember] = useState(true);
  const [useProxy, setUseProxy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // ----- 입력 -----
  const [sourceFile, setSourceFile] = useState(null);
  const [sourcePages, setSourcePages] = useState('');
  const [sourceCount, setSourceCount] = useState(0);
  const [templateFile, setTemplateFile] = useState(null);
  const [templatePages, setTemplatePages] = useState('');
  const [subject, setSubject] = useState('');
  const [scope, setScope] = useState('');
  const [extra, setExtra] = useState('');
  const [verify, setVerify] = useState(true);
  const [theme, setTheme] = useState('navy');

  // ----- 결과 -----
  const [doc, setDoc] = useState(null);
  const [figs, setFigs] = useState({});
  const [teacherView, setTeacherView] = useState(false);
  const [isSample, setIsSample] = useState(false);

  // ----- 진행 상태 -----
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [notes, setNotes] = useState([]);
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef(null);
  const sourceImagesRef = useRef(null);

  // ----- 편집 -----
  const [cropTarget, setCropTarget] = useState(null); // {mode:'edit', id} | {mode:'add', path}
  const [reviseText, setReviseText] = useState('');
  const [jsonEdit, setJsonEdit] = useState(null);
  const [jsonErr, setJsonErr] = useState('');

  const pinfo = PROVIDERS[provider];
  const cur = conf[provider] || {};
  const model = cur.model || pinfo.defaultModel;
  const apiKey = (cur.key || '').trim();

  useEffect(() => {
    const s = loadSettings();
    if (s.provider && PROVIDERS[s.provider]) setProvider(s.provider);
    if (s.conf) setConf(s.conf);
    if (typeof s.remember === 'boolean') setRemember(s.remember);
    if (typeof s.useProxy === 'boolean') setUseProxy(s.useProxy);
    if (s.theme && THEMES[s.theme]) setTheme(s.theme);
    if (typeof s.verify === 'boolean') setVerify(s.verify);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const keep = remember ? conf : Object.fromEntries(Object.entries(conf).map(([k, v]) => [k, { ...v, key: '' }]));
    saveSettings({ provider, conf: keep, remember, useProxy, theme, verify });
  }, [loaded, provider, conf, remember, useProxy, theme, verify]);

  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  useEffect(() => {
    if (!doc || isSample) return;
    const h = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [doc, isSample]);

  const setCur = (patch) => setConf((c) => ({ ...c, [provider]: { ...(c[provider] || {}), ...patch } }));

  const onSourceFile = async (f) => {
    setSourceFile(f);
    setSourceCount(0);
    sourceImagesRef.current = null;
    if (!f) return;
    try {
      const { getPageCount } = await import('../lib/pdfClient');
      setSourceCount(await getPageCount(f));
    } catch (e) {
      setError(e.message);
    }
  };

  const llmArgs = () => ({
    provider,
    model,
    apiKey,
    baseUrl: provider === 'compat' ? cur.baseUrl || PROVIDERS.compat.defaultBaseUrl : undefined,
    useProxy,
  });

  const run = async (job) => {
    setError('');
    setNotes([]);
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await job(ctrl.signal);
    } catch (e) {
      setError(e.name === 'AbortError' ? '중단했습니다.' : e.message || String(e));
    } finally {
      setStatus('');
      setBusy(false);
      abortRef.current = null;
    }
  };

  const addNote = (n) => setNotes((x) => [...x, n]);

  const cropFigures = async (d, file, existing = {}) => {
    const { cropAll } = await import('../lib/figures');
    const need = d.figures.filter((f) => !existing[f.id]);
    if (!need.length) return existing;
    setStatus(`교과서 그림을 잘라오는 중... (0/${need.length})`);
    const got = await cropAll(file, need, (i, n) => setStatus(`교과서 그림을 잘라오는 중... (${i}/${n})`));
    return { ...existing, ...got };
  };

  const handleGenerate = () => {
    if (!apiKey) return setError(`${pinfo.label} API 키를 입력해 주세요.`);
    if (!model) return setError('모델 이름을 입력해 주세요.');
    if (!sourceFile) return setError('교과서 PDF를 올려 주세요.');
    run(async (signal) => {
      const { prepareSource, prepareTemplate } = await import('../lib/pdfClient');
      const ruler = !pinfo.nativeBoxes;
      setStatus('교과서 페이지를 읽는 중...');
      const src = await prepareSource(sourceFile, sourcePages, {
        imageWidth: pinfo.imageWidth,
        ruler,
        onProgress: (i, n) => setStatus(`교과서 페이지를 읽는 중... (${i}/${n})`),
      });
      sourceImagesRef.current = src;
      if (src.pages.length > 16) addNote(`교과서 ${src.pages.length}쪽을 한 번에 보냅니다. 결과가 길면 잘릴 수 있으니, 품질을 위해 6~12쪽씩 나눠 만드는 것을 권합니다.`);

      const parts = [];
      if (templateFile) {
        setStatus('구성 참고 학습지를 읽는 중...');
        const tpl = await prepareTemplate(templateFile, templatePages);
        parts.push({ type: 'text', text: '[구성 참고 학습지] 활동 흐름만 참고하세요. 디자인·내용은 따라 하지 마세요.' });
        tpl.images.forEach((im, i) => {
          parts.push({ type: 'text', text: `[구성 참고 학습지 ${i + 1}]` });
          parts.push({ type: 'image', ...im });
        });
      }
      parts.push({ type: 'text', text: '[교과서] 아래 페이지들이 학습지 내용의 유일한 근거입니다.' });
      src.images.forEach((im) => {
        parts.push({ type: 'text', text: `[교과서 PDF ${im.page}쪽] 추출 텍스트(참고, 수식 누락): ${im.text ? im.text.slice(0, 2500) : '(없음)'}` });
        parts.push({ type: 'image', mime: im.mime, data: im.data });
      });
      parts.push({
        type: 'text',
        text: buildUserInstruction({ subject, scope, extra, pageLabels: src.pages.map((p) => `${p}`), hasTemplate: !!templateFile }),
      });

      setStatus(`AI(${model})가 학습지를 작성하는 중...`);
      const r = await generate({
        ...llmArgs(),
        system: buildSystemPrompt({ rulerMode: ruler }),
        parts,
        json: true,
        maxTokens: 48000,
        signal,
        onStatus: (m) => addNote(m),
        onText: (t) => {
          const blocks = (t.match(/"type"\s*:/g) || []).length;
          const lessons = (t.match(/"chapterTitle"\s*:/g) || []).length;
          setStatus(`AI(${model})가 작성하는 중... ${lessons ? `${lessons}차시 · ` : ''}${blocks}개 블록 · ${t.length.toLocaleString()}자`);
        },
      });
      const truncated = r.finish === 'MAX_TOKENS';
      if (truncated) addNote('AI 출력 한도에 걸려 끝부분이 잘렸습니다. 완성된 부분까지만 보여 드립니다. 쪽 범위를 줄여 다시 만들면 전체를 받을 수 있습니다.');
      let d = normalizeDoc(parseModelJson(r.text, { allowTruncated: truncated }));
      if (!d.lessons.length) throw new Error('AI 응답에 학습지 내용이 없습니다. 다시 시도해 주세요.');
      if (subject.trim()) d = { ...d, subject: subject.trim() };
      setIsSample(false);
      setDoc(d);
      setFigs({});
      const outside = d.figures.filter((x) => !src.pages.includes(x.page));
      if (outside.length) addNote(`그림 ${outside.length}개가 보낸 쪽 범위 밖(${[...new Set(outside.map((x) => x.page))].join(', ')}쪽)을 가리킵니다. 해당 그림의 [✂ 위치 조정]으로 확인해 주세요.`);
      const f = await cropFigures(d, sourceFile, {});
      setFigs(f);

      if (verify) {
        const items = collectAnswerItems(d);
        if (items.length) {
          setStatus('교과서와 대조해 문제와 정답을 검산하는 중...');
          try {
            const vparts = [];
            src.images.forEach((im) => {
              vparts.push({ type: 'text', text: `[교과서 PDF ${im.page}쪽]` });
              vparts.push({ type: 'image', mime: im.mime, data: im.data });
            });
            vparts.push({ type: 'text', text: buildVerifyInstruction(items) });
            const v = await generate({
              ...llmArgs(),
              system: VERIFY_SYSTEM,
              parts: vparts,
              json: true,
              maxTokens: 16000,
              signal,
              onText: (t) => setStatus(`교과서와 대조해 검산하는 중... (${t.length.toLocaleString()}자)`),
            });
            const fixes = parseModelJson(v.text, { allowTruncated: true }).fixes || [];
            const res = applyAnswerFixes(d, fixes);
            if (res.changed) {
              setDoc(res.doc);
              addNote(`검산에서 ${fixes.length}개 문항을 바로잡았습니다: ${fixes.map((x) => `${x.id}${x.reason ? `(${x.reason})` : ''}`).join(', ').slice(0, 300)}`);
            } else addNote('검산 결과: 고칠 곳을 찾지 못했습니다.');
          } catch (e) {
            if (e.name === 'AbortError') throw e;
            addNote(`검산 단계는 실패해서 건너뛰었습니다. (${e.message})`);
          }
        }
      }
      addNote('그림이 어긋났으면 그림 아래 [✂ 위치 조정]을, 빠진 그림은 각 칸의 [+ 그림]을 눌러 직접 지정할 수 있습니다.');
    });
  };

  const handleRevise = () => {
    if (!doc || !reviseText.trim()) return;
    if (!apiKey) return setError(`${pinfo.label} API 키를 입력해 주세요.`);
    run(async (signal) => {
      setStatus('수정 요청을 반영하는 중...');
      const r = await generate({
        ...llmArgs(),
        system: buildSystemPrompt({ rulerMode: !pinfo.nativeBoxes }),
        parts: [{ type: 'text', text: buildReviseInstruction(JSON.stringify(doc), reviseText.trim()) }],
        json: true,
        maxTokens: 48000,
        signal,
        onText: (t) => setStatus(`수정 요청을 반영하는 중... (${t.length.toLocaleString()}자)`),
      });
      if (r.finish === 'MAX_TOKENS') throw new Error('수정 결과가 너무 길어 잘렸습니다. 요청을 나눠서 해 주세요.');
      const d = normalizeDoc(parseModelJson(r.text));
      if (!d.lessons.length) throw new Error('수정 결과가 비어 있습니다.');
      setDoc(d);
      if (sourceFile && !isSample) setFigs(await cropFigures(d, sourceFile, figs));
      setReviseText('');
    });
  };

  // ----- 그림 편집 -----
  const onEditFigure = useCallback((id) => setCropTarget({ mode: 'edit', id }), []);
  const onAddFigure = useCallback((path) => setCropTarget({ mode: 'add', path }), []);
  const onRemoveFigure = useCallback((id) => {
    setDoc((d) => {
      const n = structuredClone(d);
      n.lessons.forEach((l) =>
        l.sections.forEach((s) =>
          s.blocks.forEach((b) => {
            b.figures = (b.figures || []).filter((x) => x !== id);
            if (b.items && b.type === 'problems') b.items.forEach((it) => (it.figures = (it.figures || []).filter((x) => x !== id)));
          })
        )
      );
      return n;
    });
  }, []);

  const applyCrop = async ({ page, box, refine }) => {
    const { cropFigure } = await import('../lib/figures');
    if (cropTarget.mode === 'edit') {
      const id = cropTarget.id;
      const fig = await cropFigure(sourceFile, { id, page, box }, { refine, grow: false });
      setFigs((f) => ({ ...f, [id]: fig }));
      setDoc((d) => ({ ...d, figures: d.figures.map((x) => (x.id === id ? { ...x, page: fig.page, box: fig.box } : x)) }));
    } else {
      const id = `u${Date.now().toString(36)}`;
      const fig = await cropFigure(sourceFile, { id, page, box }, { refine, grow: false });
      const [li, si, bi] = cropTarget.path;
      setFigs((f) => ({ ...f, [id]: fig }));
      setDoc((d) => {
        const n = structuredClone(d);
        n.figures.push({ id, page: fig.page, box: fig.box, desc: '' });
        const b = n.lessons[li].sections[si].blocks[bi];
        b.figures = [...(b.figures || []), id];
        return n;
      });
    }
    setCropTarget(null);
  };

  const cropInitial = useMemo(() => {
    if (!cropTarget || !doc) return null;
    if (cropTarget.mode === 'edit') return doc.figures.find((f) => f.id === cropTarget.id) || null;
    const pages = sourceImagesRef.current?.pages;
    return { page: pages?.[0] || 1, box: null };
  }, [cropTarget, doc]);

  // ----- 내려받기 -----
  const downloadHwpx = async (mode) => {
    try {
      const { buildHwpx } = await import('../lib/hwpx');
      const { dataUrlToBytes } = await import('../lib/figures');
      const images = {};
      Object.entries(figs).forEach(([id, f]) => {
        if (f && f.dataUrl) images[id] = { bytes: dataUrlToBytes(f.dataUrl), ext: 'png', w: f.w, h: f.h, frac: f.frac };
      });
      const bytes = buildHwpx(doc, { mode, theme, images });
      const l0 = doc.lessons[0];
      const name = `${safeName(doc.subject || '학습지')}_${safeName(l0?.chapterTitle || l0?.topic || '')}_${mode === 'teacher' ? '교사용' : '학생용'}.hwpx`;
      downloadBlob(bytes, name, 'application/hwp+zip');
    } catch (e) {
      setError(`HWPX 만들기 실패: ${e.message}`);
    }
  };

  const showSample = () => {
    setDoc(normalizeDoc(SAMPLE_DOC));
    setFigs(Object.fromEntries(Object.entries(SAMPLE_IMAGES).map(([k, v]) => [k, { ...v, id: k }])));
    setIsSample(true);
    setError('');
    setNotes(['샘플 학습지입니다. API 키 없이 화면과 HWPX 모양을 확인할 수 있습니다.']);
  };

  const canEditFigs = !!sourceFile && !isSample && !busy;

  return (
    <main>
      <aside className="panel no-print">
        <h1>📝 맞춤형 학습지 생성기</h1>
        <p className="hint">교과서 PDF를 올리면 교과서 문제·그림을 그대로 담은 컬러 학습지를 학생용·교사용 HWPX로 만들어 줍니다.</p>

        <div className="card">
          <div className="card-title">① AI 선택</div>
          <label>
            AI 회사
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              {Object.entries(PROVIDERS).map(([id, p]) => (
                <option key={id} value={id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">{pinfo.note}</p>
          <label>
            모델
            {pinfo.models.length ? (
              <select value={pinfo.models.some((m) => m.id === model) ? model : '__custom'} onChange={(e) => setCur({ model: e.target.value === '__custom' ? '' : e.target.value })}>
                {pinfo.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
                <option value="__custom">직접 입력...</option>
              </select>
            ) : null}
            {!pinfo.models.length || !pinfo.models.some((m) => m.id === model) ? (
              <input value={cur.model || ''} onChange={(e) => setCur({ model: e.target.value })} placeholder={provider === 'compat' ? '예: anthropic/claude-sonnet-5.5' : '모델 이름'} />
            ) : null}
          </label>
          {provider === 'compat' ? (
            <label>
              API 주소 (Base URL)
              <input value={cur.baseUrl ?? PROVIDERS.compat.defaultBaseUrl} onChange={(e) => setCur({ baseUrl: e.target.value })} />
            </label>
          ) : null}
          <label>
            {pinfo.label} API 키
            <input type="password" value={cur.key || ''} onChange={(e) => setCur({ key: e.target.value })} placeholder={pinfo.keyHint} autoComplete="off" />
          </label>
          <p className="hint">
            키 발급:{' '}
            <a href={pinfo.keyUrl} target="_blank" rel="noreferrer">
              {pinfo.keyUrl.replace(/^https:\/\//, '')}
            </a>
            . 키는 내 브라우저에서 AI 회사로만 전송되고 이 사이트 서버에는 저장되지 않습니다.
          </p>
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> 이 브라우저에 키 기억하기
          </label>
          <details>
            <summary>고급 설정</summary>
            <label className="check">
              <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} /> 서버 경유 연결 (직접 연결이 막힐 때만)
            </label>
            <p className="hint">켜면 요청이 이 사이트 서버(Vercel)를 거쳐 전달됩니다. 키는 저장하지 않지만 서버를 지나가며, 5분이 넘는 작업은 끊길 수 있습니다.</p>
          </details>
        </div>

        <div className="card">
          <div className="card-title">② 교과서 (필수)</div>
          <input type="file" accept="application/pdf" onChange={(e) => onSourceFile(e.target.files?.[0] || null)} />
          {sourceCount ? <p className="hint">총 {sourceCount}쪽</p> : null}
          <label>
            사용할 쪽 (PDF 쪽 번호, 예: 3-10)
            <input value={sourcePages} onChange={(e) => setSourcePages(e.target.value)} placeholder="비우면 전체" />
          </label>
          <p className="hint">한 번에 6~12쪽(2~3차시)씩 만들 때 품질이 가장 좋습니다.</p>
        </div>

        <div className="card">
          <div className="card-title">③ 구성 참고 학습지 (선택)</div>
          <input type="file" accept="application/pdf,image/*" onChange={(e) => setTemplateFile(e.target.files?.[0] || null)} />
          <label>
            참고할 쪽 (예: 1-3)
            <input value={templatePages} onChange={(e) => setTemplatePages(e.target.value)} placeholder="비우면 앞 3쪽" />
          </label>
          <p className="hint">평소 학습지의 활동 흐름(빈칸 정리 → 예시 → 문제 → 생각해보기)만 참고하고, 디자인은 아래 색 테마로 새로 만듭니다.</p>
        </div>

        <div className="card">
          <div className="card-title">④ 내용 설정</div>
          <label>
            과목명
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="예: 미적분Ⅰ (비우면 교과서에서 읽음)" />
          </label>
          <label>
            만들 범위·차시 (선택)
            <textarea rows={3} value={scope} onChange={(e) => setScope(e.target.value)} placeholder="예: 1차시 함수의 수렴과 발산(10~13쪽), 2차시 우극한과 좌극한(15~17쪽)" />
          </label>
          <label>
            추가 요청 (선택)
            <textarea rows={2} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="예: 개념 빈칸을 조금 더 많이, 생각해보기는 차시마다 1개" />
          </label>
          <label>
            색 테마
            <select value={theme} onChange={(e) => setTheme(e.target.value)}>
              {Object.entries(THEMES).map(([id, t]) => (
                <option key={id} value={id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} /> 교과서와 대조해 문제·정답 검산 (권장)
          </label>
        </div>

        <button type="button" onClick={handleGenerate} disabled={busy}>
          {busy ? '작업 중...' : '학습지 만들기'}
        </button>
        {busy ? (
          <button type="button" className="secondary" onClick={() => abortRef.current?.abort()}>
            중단
          </button>
        ) : null}
        {status ? (
          <p className="status">
            {status} <span className="muted">({elapsed}초)</span>
          </p>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
        {notes.map((n, i) => (
          <p key={i} className="note-msg">
            {n}
          </p>
        ))}

        {doc ? (
          <div className="card">
            <div className="card-title">⑤ 내려받기</div>
            <div className="seg">
              <button type="button" className={!teacherView ? 'on' : ''} onClick={() => setTeacherView(false)}>
                학생용 보기
              </button>
              <button type="button" className={teacherView ? 'on' : ''} onClick={() => setTeacherView(true)}>
                교사용 보기
              </button>
            </div>
            <button type="button" onClick={() => downloadHwpx('student')} disabled={busy}>
              ⬇ 학생용 HWPX
            </button>
            <button type="button" onClick={() => downloadHwpx('teacher')} disabled={busy}>
              ⬇ 교사용 HWPX (정답·풀이)
            </button>
            <button type="button" className="secondary" onClick={() => window.print()}>
              🖨 지금 보기를 PDF로 저장/인쇄
            </button>
            {!isSample ? (
              <>
                <label>
                  AI에게 수정 요청
                  <textarea rows={3} value={reviseText} onChange={(e) => setReviseText(e.target.value)} placeholder="예: 2차시 개념 확인 문항을 하나 더, 1차시 학습목표를 더 짧게" />
                </label>
                <button type="button" className="secondary" onClick={handleRevise} disabled={busy || !reviseText.trim()}>
                  수정 반영
                </button>
              </>
            ) : null}
            <button type="button" className="ghost" onClick={() => setJsonEdit(JSON.stringify(doc, null, 2))} disabled={busy}>
              내용 직접 고치기 (고급)
            </button>
          </div>
        ) : (
          <button type="button" className="ghost" onClick={showSample}>
            샘플 학습지 보기 (키 없이)
          </button>
        )}
      </aside>

      <section className="preview">
        {doc ? (
          <WorksheetView
            doc={doc}
            figs={figs}
            teacher={teacherView}
            theme={theme}
            onEditFigure={canEditFigs ? onEditFigure : undefined}
            onRemoveFigure={canEditFigs ? onRemoveFigure : undefined}
            onAddFigure={canEditFigs ? onAddFigure : undefined}
          />
        ) : (
          <div className="empty no-print">
            <p>
              왼쪽에서 AI와 키를 고르고 교과서 PDF를 올린 뒤 <b>학습지 만들기</b>를 누르세요.
            </p>
            <p className="hint">완성되면 여기에서 확인하고, 학생용·교사용 HWPX로 내려받을 수 있습니다.</p>
          </div>
        )}
      </section>

      {cropTarget && sourceFile ? (
        <CropEditor
          file={sourceFile}
          initial={cropInitial}
          title={cropTarget.mode === 'edit' ? '그림 위치 조정' : '이 칸에 넣을 교과서 그림 고르기'}
          onApply={applyCrop}
          onCancel={() => setCropTarget(null)}
        />
      ) : null}

      {jsonEdit !== null ? (
        <div className="modal no-print" role="dialog" aria-modal="true">
          <div className="modal-card">
            <div className="modal-head">
              <b>내용 직접 고치기</b>
              <span className="hint">문장·정답을 직접 고칠 수 있습니다. 수식은 $...$, 빈칸은 [[정답]] 표기를 지켜 주세요.</span>
            </div>
            <textarea className="json-edit" value={jsonEdit} onChange={(e) => setJsonEdit(e.target.value)} spellCheck={false} />
            {jsonErr ? <p className="error">{jsonErr}</p> : null}
            <div className="modal-foot">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setJsonEdit(null);
                  setJsonErr('');
                }}
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => {
                  try {
                    const d = normalizeDoc(JSON.parse(jsonEdit));
                    setDoc(d);
                    setJsonEdit(null);
                    setJsonErr('');
                  } catch (e) {
                    setJsonErr(`형식 오류: ${e.message} (쉼표·따옴표를 확인해 주세요)`);
                  }
                }}
              >
                적용
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
