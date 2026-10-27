// 여러 AI 제공사(Gemini, Claude, OpenAI, OpenAI 호환)를 브라우저에서 직접 호출합니다.
// 키는 사용자의 브라우저에서 각 제공사로만 전송됩니다. (선택: 서버 경유 모드)

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    note: '무료 사용량이 있습니다.',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'AIza...',
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (추천·무료)' },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (가장 빠름)' },
    ],
    defaultModel: 'gemini-3.8-flash',
    nativeBoxes: true,
    imageWidth: 1400,
  },
  anthropic: {
    label: 'Anthropic Claude',
    note: '유료(사용한 만큼 과금)입니다.',
    keyUrl: 'https://platform.claude.com/settings/keys',
    keyHint: 'sk-ant-...',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (최고 품질)' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (추천)' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (빠르고 저렴)' },
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
    ],
    defaultModel: 'claude-sonnet-5-5',
    imageWidth: 1150,
  },
  openai: {
    label: 'OpenAI',
    note: '유료(사용한 만큼 과금)입니다.',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-...',
    models: [
      { id: 'gpt-6-astra', label: 'GPT-6 Astra (최고 성능)' },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol (추천)' },
      { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra (빠름)' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna (저렴)' },
    ],
    defaultModel: 'gpt-6.1-sol',
    imageWidth: 1300,
  },
  compat: {
    label: 'OpenAI 호환 (OpenRouter 등)',
    note: '주소와 모델 이름을 직접 입력합니다. 이미지 입력을 지원하는 모델이어야 합니다.',
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-...',
    models: [],
    defaultModel: '',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    imageWidth: 1200,
  },
};

export class LlmError extends Error {
  constructor(message, status = 0, retryable = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function friendly(provider, status, msg, model) {
  const m = msg || '';
  if (status === 401 || /api key not valid|invalid.*api.?key|incorrect api key|authentication/i.test(m))
    return 'API 키가 올바르지 않습니다. 선택한 AI 회사의 키가 맞는지 확인해 주세요.';
  if (status === 403) return `권한 오류입니다. 이 키로 ${model} 모델을 쓸 수 있는지 확인해 주세요. (${m})`;
  if (status === 404) return `모델(${model})을 찾을 수 없습니다. 모델 이름을 확인해 주세요. (${m})`;
  if (status === 429)
    return provider === 'gemini'
      ? '이 키의 무료 사용량(분당/일일 한도)에 도달했습니다. 1분쯤 뒤 다시 시도하거나 내일 사용해 주세요.'
      : `사용량 한도 또는 잔액 문제로 거절되었습니다. 결제 상태와 한도를 확인해 주세요. (${m})`;
  if (status === 413) return '보낸 자료가 너무 큽니다. 교과서 쪽 범위를 줄여 주세요.';
  if (status === 500 || status === 502 || status === 503 || status === 529)
    return `AI 서버가 일시적으로 바쁩니다(${status}). 잠시 후 다시 시도해 주세요.`;
  return m || `AI 호출 실패 (${status})`;
}

// SSE 버퍼에서 완결된 이벤트(data 줄)들을 꺼냄
export function parseSse(buffer) {
  const events = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop();
  for (const block of blocks) {
    let ev = '';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) continue;
    const payload = data.join('\n');
    if (payload === '[DONE]') {
      events.push({ event: ev, done: true });
      continue;
    }
    try {
      events.push({ event: ev, json: JSON.parse(payload) });
    } catch {
      /* 깨진 조각 무시 */
    }
  }
  return { events, rest };
}

// ----- 제공사별 요청 만들기 -----
function buildRequest(o) {
  const { provider, model, apiKey, system, parts, json, maxTokens, baseUrl, opts } = o;
  if (provider === 'gemini') {
    const contents = [
      {
        role: 'user',
        parts: parts.map((p) => (p.type === 'image' ? { inlineData: { mimeType: p.mime, data: p.data } } : { text: p.text })),
      },
    ];
    const generationConfig = { maxOutputTokens: opts.maxTokens ?? maxTokens };
    if (json && !opts.noJsonMode) generationConfig.responseMimeType = 'application/json';
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig },
    };
  }
  if (provider === 'anthropic') {
    const content = parts.map((p) =>
      p.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } } : { type: 'text', text: p.text }
    );
    const body = { model, max_tokens: opts.maxTokens ?? maxTokens, system, messages: [{ role: 'user', content }], stream: true };
    if (!opts.noThinking) {
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort: opts.effort || 'medium' };
    }
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body,
    };
  }
  // openai / compat (Chat Completions)
  const content = parts.map((p) =>
    p.type === 'image' ? { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}`, detail: 'high' } } : { type: 'text', text: p.text }
  );
  const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content }], stream: true };
  const isOpenAI = provider === 'openai';
  if (isOpenAI && !opts.legacyMax) body.max_completion_tokens = opts.maxTokens ?? maxTokens;
  else body.max_tokens = opts.maxTokens ?? maxTokens;
  if (json && !opts.noJsonMode) body.response_format = { type: 'json_object' };
  if (isOpenAI && !opts.noReasoning) body.reasoning_effort = opts.effort || 'medium';
  const base = (baseUrl || PROVIDERS.compat.defaultBaseUrl).replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  if (!isOpenAI && /openrouter\.ai/.test(base)) {
    headers['HTTP-Referer'] = typeof location !== 'undefined' ? location.origin : 'https://localhost';
    headers['X-Title'] = 'Worksheet Generator';
  }
  return { url: isOpenAI ? 'https://api.openai.com/v1/chat/completions' : `${base}/chat/completions`, headers, body };
}

// 이벤트 하나에서 글자/종료 사유 추출
function readEvent(provider, ev, state) {
  const j = ev.json;
  if (!j) return;
  if (j.proxyError) throw new LlmError(friendly(provider, j.proxyError.status, j.proxyError.message, state.model), j.proxyError.status, [429, 500, 502, 503, 529].includes(j.proxyError.status));
  if (provider === 'gemini') {
    if (j.error) throw new LlmError(friendly(provider, j.error.code, j.error.message, state.model), j.error.code, [429, 500, 503].includes(j.error.code));
    const cand = j.candidates?.[0];
    const piece = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    if (piece) state.text += piece;
    if (cand?.finishReason) state.finish = cand.finishReason;
    if (j.promptFeedback?.blockReason) state.block = j.promptFeedback.blockReason;
    return;
  }
  if (provider === 'anthropic') {
    if (j.type === 'error') {
      const t = j.error?.type || '';
      const status = t === 'overloaded_error' ? 529 : t === 'rate_limit_error' ? 429 : 500;
      throw new LlmError(friendly(provider, status, j.error?.message, state.model), status, true);
    }
    if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') state.text += j.delta.text || '';
    if (j.type === 'message_delta' && j.delta?.stop_reason) state.finish = j.delta.stop_reason === 'max_tokens' ? 'MAX_TOKENS' : j.delta.stop_reason;
    return;
  }
  if (j.error) throw new LlmError(friendly(provider, j.error.code || 500, j.error.message, state.model), 500, false);
  const ch = j.choices?.[0];
  const piece = ch?.delta?.content;
  if (typeof piece === 'string') state.text += piece;
  else if (Array.isArray(piece)) state.text += piece.map((p) => p.text || '').join('');
  if (ch?.finish_reason) state.finish = ch.finish_reason === 'length' ? 'MAX_TOKENS' : ch.finish_reason;
}

async function streamOnce(o) {
  const { provider, model, onText, signal, useProxy } = o;
  const req = buildRequest(o);
  let res;
  try {
    if (useProxy) {
      res = await fetch(`/api/proxy?target=${encodeURIComponent(req.url)}`, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal,
      });
    } else {
      res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal });
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new LlmError(
      '네트워크 오류로 AI 서버에 연결하지 못했습니다. 인터넷 연결이나 보안 프로그램을 확인해 주세요. 계속되면 설정에서 "서버 경유 연결"을 켜 보세요.',
      0,
      true
    );
  }
  if (!res.ok) {
    let msg = '';
    try {
      const t = await res.text();
      try {
        const j = JSON.parse(t);
        msg = j?.error?.message || j?.message || t;
      } catch {
        msg = t;
      }
    } catch {}
    const err = new LlmError(friendly(provider, res.status, String(msg).slice(0, 400), model), res.status, [429, 500, 502, 503, 529].includes(res.status));
    err.raw = String(msg);
    throw err;
  }
  const state = { text: '', finish: '', block: '', model };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const { events, rest } = parseSse(buf);
    buf = rest;
    const before = state.text.length;
    for (const ev of events) readEvent(provider, ev, state);
    if (onText && state.text.length !== before) onText(state.text);
  }
  if (buf.trim()) {
    const { events } = parseSse(`${buf}\n\n`);
    for (const ev of events) readEvent(provider, ev, state);
    if (onText) onText(state.text);
  }
  if (!state.text.trim()) {
    throw new LlmError(`AI가 빈 응답을 보냈습니다${state.block || state.finish ? ` (${state.block || state.finish})` : ''}. 다시 시도해 주세요.`, 200, true);
  }
  return { text: state.text, finish: state.finish, model };
}

// 400 오류일 때 선택 옵션을 하나씩 끄고 재시도
function relaxOptions(provider, err, opts) {
  const raw = `${err.raw || ''} ${err.message}`.toLowerCase();
  if (provider === 'anthropic' && !opts.noThinking && /thinking|output_config|effort/.test(raw)) return { ...opts, noThinking: true };
  if ((provider === 'openai' || provider === 'compat') && !opts.noReasoning && /reasoning/.test(raw)) return { ...opts, noReasoning: true };
  if ((provider === 'openai' || provider === 'compat') && !opts.legacyMax && /max_completion_tokens/.test(raw)) return { ...opts, legacyMax: true };
  if (!opts.noJsonMode && /response_format|json|mime/.test(raw)) return { ...opts, noJsonMode: true };
  if (/max_?tokens|maxoutputtokens|max_completion_tokens|too large|exceeds/.test(raw) && (opts.maxTokens ?? 0) !== 16000) return { ...opts, maxTokens: 16000 };
  if (provider === 'anthropic' && !opts.noThinking) return { ...opts, noThinking: true };
  if ((provider === 'openai' || provider === 'compat') && !opts.noReasoning) return { ...opts, noReasoning: true };
  return null;
}

/**
 * parts: [{type:'text', text} | {type:'image', mime, data(base64)}]
 */
export async function generate({ provider, model, apiKey, baseUrl, system, parts, json = true, maxTokens = 48000, onText, onStatus, signal, useProxy = false, effort }) {
  if (!apiKey) throw new LlmError('API 키를 입력해 주세요.');
  if (!model) throw new LlmError('모델 이름을 입력해 주세요.');
  let opts = { effort };
  let attempt = 0;
  const models = [model];
  if (provider === 'gemini') PROVIDERS.gemini.models.forEach((m) => !models.includes(m.id) && models.push(m.id));
  let mi = 0;
  for (;;) {
    const m = models[mi];
    try {
      return await streamOnce({ provider, model: m, apiKey, baseUrl, system, parts, json, maxTokens, onText, signal, useProxy, opts });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      attempt++;
      if (e.status === 400 && attempt <= 4) {
        const next = relaxOptions(provider, e, opts);
        if (next) {
          opts = next;
          continue;
        }
      }
      if (provider === 'gemini' && e.status === 404 && mi < models.length - 1) {
        mi++;
        if (onStatus) onStatus(`모델 ${m}을(를) 쓸 수 없어 ${models[mi]}(으)로 바꿉니다.`);
        continue;
      }
      if (e.retryable && attempt <= 2 && e.status !== 0 && !(e.status === 200)) {
        const wait = e.status === 429 ? 20000 : 6000;
        if (onStatus) onStatus(`${e.message} ${Math.round(wait / 1000)}초 뒤 다시 시도합니다.`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
}
