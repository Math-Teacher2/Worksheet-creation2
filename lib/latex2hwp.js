// LaTeX 수식 -> 한글(HWP) 수식 스크립트 변환기.
//
// 한컴 수식 편집기 문법(EqEdit)에 맞춰 변환합니다. 토큰 선택은 python-hwpx
// (Apache-2.0, https://github.com/airmang/python-hwpx)의 equation/authoring.py에서
// 한컴 실제 렌더링으로 검증된 표기(예: \to -> "->", \forall -> "FORALL",
// \text -> {rm "..." it}, 예약어 따옴표 처리)를 참고해 JavaScript로 다시 작성했습니다.
// 원본과 달리 지원하지 않는 명령을 만나도 멈추지 않고 가장 가까운 표기로 바꿉니다.

const GREEK = new Set([
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'varpi', 'rho', 'varrho', 'sigma', 'varsigma',
  'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
]);
const GREEK_UPPER = {
  Gamma: 'GAMMA', Delta: 'DELTA', Theta: 'THETA', Lambda: 'LAMBDA', Xi: 'XI', Pi: 'PI',
  Sigma: 'SIGMA', Upsilon: 'UPSILON', Phi: 'PHI', Psi: 'PSI', Omega: 'OMEGA',
};

const SYMBOLS = {
  times: 'TIMES', div: 'DIV', cdot: 'cdot', pm: '+-', mp: '-+', ast: 'ast', star: 'star',
  circ: 'circ', bullet: 'bullet', oplus: 'oplus', otimes: 'otimes',
  le: 'LEQ', leq: 'LEQ', leqslant: 'LEQ', ge: 'GEQ', geq: 'GEQ', geqslant: 'GEQ',
  ne: 'NEQ', neq: 'NEQ', lt: '<', gt: '>',
  approx: 'approx', equiv: 'equiv', sim: 'sim', simeq: 'simeq', cong: 'cong', propto: 'propto',
  ll: 'll', gg: 'gg',
  in: 'in', notin: 'notin', ni: 'ni', subset: 'subset', subseteq: 'subseteq', supset: 'supset',
  supseteq: 'supseteq', cup: 'cup', cap: 'cap', setminus: '-',
  emptyset: 'emptyset', varnothing: 'emptyset', forall: 'FORALL', exists: 'exists', neg: 'neg',
  lnot: 'neg', land: 'land', lor: 'lor', wedge: 'land', vee: 'lor',
  infty: 'INF', partial: 'partial', nabla: 'nabla', angle: 'ANGLE', triangle: 'TRIANGLE',
  therefore: 'therefore', because: 'because',
  cdots: 'cdots', ldots: 'ldots', dots: 'cdots', vdots: 'vdots', ddots: 'ddots',
  prime: "'", degree: 'DEG',
  to: '->', rightarrow: '->', longrightarrow: '->', leftarrow: '<-', longleftarrow: '<-',
  leftrightarrow: '<->', Rightarrow: 'RARROW', Longrightarrow: 'RARROW', implies: 'RARROW',
  Leftarrow: 'LARROW', Longleftarrow: 'LARROW', impliedby: 'LARROW',
  Leftrightarrow: 'LRARROW', Longleftrightarrow: 'LRARROW', iff: 'LRARROW',
  mapsto: 'mapsto', uparrow: 'uparrow', downarrow: 'downarrow',
  mid: '~|~', parallel: 'parallel', perp: 'perp', vert: '|', lvert: '|', rvert: '|',
  Vert: '||', lVert: '||', rVert: '||',
  lbrace: 'LBRACE', rbrace: 'RBRACE', langle: 'LANGLE', rangle: 'RANGLE',
  lfloor: 'lfloor', rfloor: 'rfloor', lceil: 'lceil', rceil: 'rceil',
  hbar: 'hbar', ell: 'l', aleph: 'aleph',
};

const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'arcsin', 'arccos', 'arctan',
  'log', 'ln', 'lg', 'exp', 'det', 'dim', 'gcd', 'max', 'min', 'sup', 'arg', 'deg', 'mod',
]);
const BIG_OPS = { lim: 'lim', sum: 'sum', prod: 'prod', coprod: 'coprod', int: 'int', iint: 'dint', iiint: 'tint', oint: 'oint', bigcup: 'bigcup', bigcap: 'bigcap' };
const ACCENTS = {
  bar: 'bar', overline: 'overline', vec: 'vec', overrightarrow: 'vec', hat: 'hat', widehat: 'hat',
  tilde: 'tilde', widetilde: 'tilde', dot: 'dot', ddot: 'ddot', underline: 'underline',
  overleftrightarrow: 'dyad', acute: 'acute', grave: 'grave', check: 'check', breve: 'breve',
};
const SPACING = { ',': '`', ';': '~', ':': '~', ' ': '~', '>': '~', quad: '~~', qquad: '~~~~', '!': '', thinspace: '`', enspace: '~', medspace: '~' };
const IGNORED = new Set([
  'displaystyle', 'textstyle', 'scriptstyle', 'limits', 'nolimits', 'left.', 'right.', 'big', 'Big',
  'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'nonumber', 'notag', 'relax',
]);
const TEXT_CMDS = new Set(['text', 'textrm', 'mathrm', 'mbox', 'operatorname', 'textup', 'mathsf', 'textsf', 'texttt', 'mathtt', 'textnormal']);
const ENVS = { cases: 'cases', matrix: 'matrix', pmatrix: 'pmatrix', bmatrix: 'bmatrix', vmatrix: 'dmatrix', Vmatrix: 'dmatrix', Bmatrix: 'matrix', smallmatrix: 'matrix', array: 'matrix', aligned: 'eqalign', align: 'eqalign', 'align*': 'eqalign', gathered: 'pile', gather: 'pile', split: 'eqalign', rcases: 'cases', dcases: 'cases' };

const UNICODE = {
  '≤': 'LEQ', '≦': 'LEQ', '≥': 'GEQ', '≧': 'GEQ', '≠': 'NEQ', '±': '+-', '∓': '-+', '×': 'TIMES',
  '÷': 'DIV', '·': 'cdot', '∙': 'cdot', '⋅': 'cdot', '∞': 'INF', '→': '->', '←': '<-', '↔': '<->',
  '⇒': 'RARROW', '⇐': 'LARROW', '⇔': 'LRARROW', '∈': 'in', '∉': 'notin', '⊂': 'subset', '⊆': 'subseteq',
  '⊃': 'supset', '⊇': 'supseteq', '∪': 'cup', '∩': 'cap', '∅': 'emptyset', '∀': 'FORALL', '∃': 'exists',
  '∴': 'therefore', '∵': 'because', '∠': 'ANGLE', '△': 'TRIANGLE', '°': 'DEG', '′': "'", '…': 'ldots',
  '⋯': 'cdots', '−': '-', '–': '-', '≈': 'approx', '≡': 'equiv', '∼': 'sim', '∥': 'parallel', '⊥': 'perp',
  'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon', 'θ': 'theta', 'λ': 'lambda',
  'μ': 'mu', 'π': 'pi', 'ρ': 'rho', 'σ': 'sigma', 'τ': 'tau', 'φ': 'phi', 'ω': 'omega', 'Δ': 'DELTA',
  'Σ': 'SIGMA', 'Ω': 'OMEGA', '√': 'sqrt', '∑': 'sum', '∫': 'int', '｜': '|',
};

// 한컴 수식에서 명령어로 읽히는 단어들: 변수로 쓰일 때는 따옴표로 감쌉니다.
const RESERVED = new Set([
  ...GREEK, ...Object.values(GREEK_UPPER), ...FUNCTIONS, ...Object.values(BIG_OPS), ...Object.keys(BIG_OPS),
  ...Object.values(ACCENTS), 'over', 'atop', 'choose', 'binom', 'sqrt', 'root', 'of', 'left', 'right',
  'LEFT', 'RIGHT', 'rm', 'it', 'bold', 'RM', 'IT', 'BOLD', 'cases', 'matrix', 'pmatrix', 'bmatrix',
  'dmatrix', 'pile', 'lpile', 'rpile', 'eqalign', 'times', 'TIMES', 'div', 'DIV', 'cdot', 'pm', 'mp',
  'leq', 'geq', 'neq', 'LEQ', 'GEQ', 'NEQ', 'le', 'ge', 'ne', 'in', 'notin', 'subset', 'supset', 'cup',
  'cap', 'inf', 'INF', 'infty', 'to', 'from', 'sim', 'approx', 'equiv', 'circ', 'deg', 'DEG', 'angle',
  'ANGLE', 'prime', 'dots', 'cdots', 'ldots', 'partial', 'nabla', 'forall', 'exists', 'neg', 'land',
  'lor', 'vec', 'bar', 'hat', 'dot', 'line', 'vert', 'VERT', 'LINE', 'smallinter', 'smallunion',
  'therefore', 'because', 'triangle', 'TRIANGLE', 'emptyset', 'ast', 'star', 'prod', 'sum', 'int',
  'oint', 'dint', 'tint', 'lim', 'Lim', 'not', 'rarrow', 'larrow', 'lrarrow', 'RARROW', 'LARROW',
  'LRARROW', 'under', 'dyad', 'acute', 'grave', 'check', 'breve', 'tilde', 'ddot', 'mapsto', 'and',
  'or', 'mod', 'propto', 'cong', 'simeq', 'perp', 'parallel', 'hbar', 'aleph', 'color', 'scale',
]);

function lex(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '\\') {
      if (i + 1 >= n) {
        i++;
        continue;
      }
      const nx = src[i + 1];
      if (nx === '\\') {
        tokens.push('\\\\');
        i += 2;
      } else if (/[a-zA-Z]/.test(nx)) {
        let j = i + 1;
        while (j < n && /[a-zA-Z]/.test(src[j])) j++;
        let name = src.slice(i + 1, j);
        if ((name === 'left' || name === 'right') && src[j] === '.') {
          tokens.push(`\\${name}.`);
          j++;
        } else if (src[j] === '*' && (name === 'operatorname')) {
          j++;
          tokens.push(`\\${name}`);
        } else {
          tokens.push(`\\${name}`);
        }
        i = j;
        // \text{...} 류는 안쪽 글자를 그대로 보존
        if (TEXT_CMDS.has(name)) {
          let k = i;
          while (k < n && src[k] === ' ') k++;
          if (src[k] === '{') {
            let depth = 0;
            let m = k;
            for (; m < n; m++) {
              if (src[m] === '\\') {
                m++;
                continue;
              }
              if (src[m] === '{') depth++;
              else if (src[m] === '}') {
                depth--;
                if (depth === 0) break;
              }
            }
            const raw = src
              .slice(k + 1, m)
              .replace(/\\[,;: !]/g, ' ')
              .replace(/\\([{}%&$#_])/g, '$1')
              .replace(/\\[a-zA-Z]+\s*/g, '');
            tokens.push({ rawtext: raw });
            i = Math.min(n, m + 1);
          }
        }
      } else {
        tokens.push(`\\${nx}`);
        i += 2;
      }
    } else if ('{}^_&[]'.includes(ch)) {
      tokens.push(ch);
      i++;
    } else if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      tokens.push(src.slice(i, j));
      i = j;
    } else if (/[a-zA-Z]/.test(ch)) {
      let j = i;
      while (j < n && /[a-zA-Z]/.test(src[j])) j++;
      tokens.push(src.slice(i, j));
      i = j;
    } else if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(ch)) {
      let j = i;
      while (j < n && /[가-힣ㄱ-ㅎㅏ-ㅣ ]/.test(src[j])) j++;
      tokens.push({ hangul: src.slice(i, j).trim() });
      i = j;
    } else {
      tokens.push(ch);
      i++;
    }
  }
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.t = tokens;
    this.p = 0;
    this.depth = 0;
  }
  peek() {
    return this.t[this.p];
  }
  next() {
    return this.t[this.p++];
  }

  parse() {
    const parts = this.sequence(new Set());
    // 남은 닫는 괄호 등은 버리고 계속
    while (this.p < this.t.length) {
      this.next();
      parts.push(...this.sequence(new Set()));
    }
    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  sequence(stop) {
    const parts = [];
    this.depth++;
    if (this.depth > 60) {
      this.depth--;
      return parts;
    }
    for (;;) {
      const tk = this.peek();
      if (tk === undefined || (typeof tk === 'string' && stop.has(tk))) break;
      if (tk === '^' || tk === '_') {
        this.next();
        while (parts.length && /^[`~]+$/.test(parts[parts.length - 1])) parts.pop();
        const body = this.argument();
        parts.push(`${tk}{${body}}`);
        continue;
      }
      parts.push(this.atom());
    }
    this.depth--;
    return parts;
  }

  // 한 덩어리 인자: {...} 이면 안쪽 내용, 아니면 원자 하나
  argument() {
    if (this.peek() === '{') {
      this.next();
      const inner = this.sequence(new Set(['}']));
      if (this.peek() === '}') this.next();
      return inner.join(' ');
    }
    // \frac12 처럼 한 글자 인자
    const tk = this.peek();
    if (typeof tk === 'string' && /^[0-9]{2,}$/.test(tk)) {
      this.t[this.p] = tk.slice(1);
      return tk[0];
    }
    return this.atom();
  }

  rawGroupText() {
    // \text{...} 의 글자 그대로
    const pk = this.peek();
    if (pk && typeof pk === 'object' && pk.rawtext !== undefined) {
      this.next();
      return pk.rawtext;
    }
    if (this.peek() !== '{') {
      const tk = this.next();
      return typeof tk === 'string' ? tk : tk?.hangul || '';
    }
    this.next();
    let depth = 0;
    const out = [];
    for (;;) {
      const tk = this.next();
      if (tk === undefined) break;
      if (tk === '{') {
        depth++;
        continue;
      }
      if (tk === '}') {
        if (depth === 0) break;
        depth--;
        continue;
      }
      if (typeof tk === 'object') out.push(tk.hangul);
      else if (tk.startsWith('\\')) {
        const name = tk.slice(1);
        if (SPACING[name] !== undefined) out.push(' ');
        else if (name.length === 1) out.push(name);
        else out.push(SYMBOLS[name] ? '' : name);
      } else out.push(tk);
    }
    return out.join(' ').replace(/\s+/g, ' ').replace(/\s([,.)\]])/g, '$1').trim();
  }

  quoted(text) {
    const t = String(text).replace(/"/g, "'").replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return `{rm "${t}" it}`;
  }

  atom() {
    const tk = this.next();
    if (tk === undefined) return '';
    if (typeof tk === 'object') return this.quoted(tk.rawtext !== undefined ? tk.rawtext : tk.hangul);
    if (tk === '{') {
      const inner = this.sequence(new Set(['}']));
      if (this.peek() === '}') this.next();
      return `{${inner.join(' ')}}`;
    }
    if (tk === '}') return '';
    if (tk === '&') return '&';
    if (tk === '\\\\') return '#';
    if (tk === '[' || tk === ']') return tk;
    if (tk.startsWith('\\')) return this.command(tk.slice(1));
    if (/^[a-zA-Z]+$/.test(tk)) return RESERVED.has(tk) ? `"${tk}"` : tk;
    if (UNICODE[tk]) return UNICODE[tk];
    if (tk === '"') return "''";
    if (tk === '~') return '~';
    if (tk === '#') return '"#"';
    if (tk === '`') return '`';
    if (tk === '%') return '%';
    return tk;
  }

  command(name) {
    if (IGNORED.has(name)) return '';
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
      const a = this.argument();
      const b = this.argument();
      return `{{${a}} over {${b}}}`;
    }
    if (name === 'binom' || name === 'dbinom' || name === 'tbinom') {
      const a = this.argument();
      const b = this.argument();
      return `{{${a}} choose {${b}}}`;
    }
    if (name === 'sqrt') {
      if (this.peek() === '[') {
        this.next();
        const idx = this.sequence(new Set([']']));
        if (this.peek() === ']') this.next();
        const body = this.argument();
        return `root {${idx.join(' ')}} of {${body}}`;
      }
      return `sqrt {${this.argument()}}`;
    }
    if (TEXT_CMDS.has(name)) return this.quoted(this.rawGroupText());
    if (name === 'textbf' || name === 'mathbf' || name === 'boldsymbol' || name === 'bm') {
      return `{rm {bold {${this.argument()}}} it}`;
    }
    if (name === 'mathbb' || name === 'mathcal' || name === 'mathscr' || name === 'mathfrak') {
      return `{rm {bold {${this.argument()}}} it}`;
    }
    if (name === 'mathit' || name === 'textit' || name === 'emph') return `{${this.argument()}}`;
    if (name === 'begin') return this.environment();
    if (name === 'end') {
      this.argument();
      return '';
    }
    if (name === 'left') return this.leftRight();
    if (name === 'left.') return this.leftRight('.');
    if (name === 'right' || name === 'right.') {
      if (name === 'right') this.next();
      return '';
    }
    if (ACCENTS[name]) return `${ACCENTS[name]} {${this.argument()}}`;
    if (name === 'overset' || name === 'stackrel') {
      const top = this.argument();
      const base = this.argument();
      return `{{${top}} atop {${base}}}`;
    }
    if (name === 'underset') {
      const bottom = this.argument();
      const base = this.argument();
      return `{{${base}} atop {${bottom}}}`;
    }
    if (name === 'boxed' || name === 'fbox' || name === 'phantom' || name === 'hphantom' || name === 'cancel') {
      const a = this.argument();
      return name.includes('phantom') ? '~' : `{${a}}`;
    }
    if (name === 'color' || name === 'textcolor') {
      this.argument();
      return name === 'textcolor' ? `{${this.argument()}}` : '';
    }
    if (name === 'not') {
      const nx = this.peek();
      if (nx === '=' ) {
        this.next();
        return 'NEQ';
      }
      if (nx === '\\in') {
        this.next();
        return 'notin';
      }
      return '';
    }
    if (BIG_OPS[name]) return BIG_OPS[name];
    if (FUNCTIONS.has(name)) return name;
    if (name === 'inf') return '"inf"';
    if (GREEK.has(name)) return name;
    if (GREEK_UPPER[name]) return GREEK_UPPER[name];
    if (SYMBOLS[name] !== undefined) return SYMBOLS[name];
    if (SPACING[name] !== undefined) return SPACING[name];
    if (name.length === 1) {
      // 이스케이프된 한 글자: \{ \} \% \& \$ \# \_ \|
      if (name === '{') return 'LBRACE';
      if (name === '}') return 'RBRACE';
      if (name === '|') return '||';
      if (name === '&') return '"&"';
      if (name === '#') return '"#"';
      if (name === '_') return '"_"';
      return name;
    }
    // 모르는 명령: 이름을 글자로 남김
    return this.quoted(name);
  }

  delimiter(tk) {
    if (tk === undefined) return '.';
    if (typeof tk === 'object') return '.';
    if (tk === '(' || tk === ')' || tk === '[' || tk === ']' || tk === '|' || tk === '.' || tk === '/') return tk;
    if (tk === '\\{' || tk === '\\lbrace') return 'LBRACE';
    if (tk === '\\}' || tk === '\\rbrace') return 'RBRACE';
    if (tk === '\\langle' || tk === '<') return '<';
    if (tk === '\\rangle' || tk === '>') return '>';
    if (tk === '\\lvert' || tk === '\\rvert' || tk === '\\vert') return '|';
    if (tk === '\\|' || tk === '\\Vert' || tk === '\\lVert' || tk === '\\rVert') return '||';
    if (tk === '\\lfloor' || tk === '\\rfloor' || tk === '\\lceil' || tk === '\\rceil') return tk.slice(1);
    return '.';
  }

  leftRight(forcedOpen) {
    const open = forcedOpen || this.delimiter(this.next());
    const body = this.sequence(new Set(['\\right', '\\right.']));
    let close = '.';
    const tk = this.next();
    if (tk === '\\right') close = this.delimiter(this.next());
    return `LEFT ${open} ${body.join(' ')} RIGHT ${close}`;
  }

  environment() {
    let name = '';
    if (this.peek() === '{') {
      this.next();
      const parts = [];
      while (this.peek() !== undefined && this.peek() !== '}') {
        const tk = this.next();
        parts.push(typeof tk === 'string' ? tk : '');
      }
      if (this.peek() === '}') this.next();
      name = parts.join('');
    }
    // array 열 정의 {cc} 건너뛰기
    if (name === 'array' && this.peek() === '{') {
      let d = 0;
      do {
        const tk = this.next();
        if (tk === '{') d++;
        else if (tk === '}') d--;
      } while (d > 0 && this.peek() !== undefined);
    }
    const builder = ENVS[name] || 'pile';
    const rows = [[]];
    let cur = [];
    const flush = () => {
      rows[rows.length - 1].push(cur.join(' '));
      cur = [];
    };
    for (;;) {
      const tk = this.peek();
      if (tk === undefined) break;
      if (tk === '\\end') {
        this.next();
        this.argument();
        break;
      }
      if (tk === '&') {
        this.next();
        flush();
        continue;
      }
      if (tk === '\\\\') {
        this.next();
        // \\[4pt] 같은 간격 지정 건너뛰기
        if (this.peek() === '[') {
          while (this.peek() !== undefined && this.next() !== ']');
        }
        flush();
        rows.push([]);
        continue;
      }
      if (tk === '^' || tk === '_') {
        this.next();
        cur.push(`${tk}{${this.argument()}}`);
        continue;
      }
      if (tk === '\\hline') {
        this.next();
        continue;
      }
      cur.push(this.atom());
    }
    flush();
    const body = rows
      .filter((r) => r.some((c) => c.trim()))
      .map((r) => r.join(' & '))
      .join(' # ');
    return `${builder} {${body}}`;
  }
}

export function latexToHwp(latex) {
  const src = String(latex ?? '')
    .replace(/^\s*\$+|\$+\s*$/g, '')
    .trim();
  if (!src) return '';
  try {
    const out = new Parser(lex(src)).parse();
    return out || '""';
  } catch {
    return `"${src.replace(/"/g, "'")}"`;
  }
}
