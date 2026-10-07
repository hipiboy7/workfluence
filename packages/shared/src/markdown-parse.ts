import { DOCUMENT_SCHEMA_VERSION, MARKDOWN_LIMITS } from './constants';
import { ALLOWED_LINK_HREF, validateDocument, type DocMark, type DocNode } from './document';

/**
 * 마크다운 → 문서 JSON (A등급, docs/spinoff/public-api 설계서 3.4절 · FR-2215).
 *
 * 공개 API가 에이전트의 마크다운을 받아 편집기와 같은 문서(ProseMirror JSON)로 바꾼다. **직접 쓴 CommonMark·GFM의 부분집합**이다 — 라이브러리를
 * 들이면 허용 목록 밖의 것(원시 HTML·그림)까지 만들어 내고, 그것을 걸러 내는 코드를 따로 써야 하며 반입 이미지가 커진다(사용자 결정 2026-10-07).
 *
 * 지키는 것:
 * 1. **허용 목록 밖은 만들지 않고 거절한다** — 원시 HTML·그림·`http(s)`·내부 경로·`#`가 아닌 링크 주소. 조용히 고치지 않는다(문서 규칙과 같다).
 * 2. **까닭은 입력한 글을 되읊지 않는다** — 줄 번호와 규칙만. 오류는 응답·로그·감사로 가고 본문은 거기 남지 않는다(7절).
 * 3. **성공한 결과는 `validateDocument`를 통과한다** — 마지막에 정본 검증을 한 번 더 한다(편집기가 그리는 모양: 목록 항목의 첫 자식은 문단, 비어 있을
 *    수 없는 노드는 빈 문단을 담는다).
 * 4. **오래 걸리지 않는다** — 훑은 글자 수에 예산(`MARKDOWN_LIMITS.maxWork`)이 있고, 짝 없는 서식 표지는 한 번 실패한 자리를 기억한다.
 *
 * 지원: 문단(줄 끝 `\`·빈칸 둘은 줄바꿈), `#` 제목 1~6, 가로줄, 인용, 울타리 코드 블록, 글머리·번호 목록(중첩), GFM 표(정렬), 굵게·기울임·취소선·
 * 코드 조각·링크·`<http(s)://…>`. **지원하지 않음**: 들여 쓴 코드 블록·setext 제목·참조식 링크·본문의 맨 주소 자동 링크(링크로 만들지 않고 글자로
 * 둔다)·밑줄(마크다운에 표기가 없다)·그림·원시 HTML. 반대 방향(`renderDocMarkdown`)이 쓴 것은 다시 읽힌다(왕복 시험).
 */

export type MarkdownParseResult = { ok: true; doc: DocNode } | { ok: false; errors: string[] };

class ParseError extends Error {}

interface Ctx {
  work: number;
}

interface Line {
  t: string;
  /** 원문의 줄 번호(1부터) — 오류가 말한다 */
  no: number;
}

const MARK_ORDER = ['bold', 'italic', 'strike', 'underline', 'code', 'link'];
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const ALNUM = /[\p{L}\p{N}]/u;
const BLANK = /^[ \t]*$/;

const charge = (ctx: Ctx, n: number): void => {
  ctx.work += n;
  if (ctx.work > MARKDOWN_LIMITS.maxWork) throw new ParseError('마크다운이 너무 복잡하다 — 문단·표를 나누어 보낸다');
};

// ---- 글 안의 서식 ----

type Loc = (pos: number) => number;

/** 줄 머리·끝의 빈칸을 정리한 한 덩어리 글을 노드 목록으로. `loc`은 이 글의 위치 → 원문 줄 번호 */
function parseInline(src: string, ctx: Ctx, loc: Loc): DocNode[] {
  const out: DocNode[] = [];

  const canon = (marks: DocMark[]): DocMark[] => {
    const seen = new Map<string, DocMark>();
    for (const m of marks) if (!seen.has(m.type)) seen.set(m.type, m);
    return [...seen.values()].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
  };

  const emit = (text: string, marks: DocMark[]): void => {
    if (!text) return;
    const m = canon(marks);
    const last = out[out.length - 1];
    if (last && last.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(m)) last.text += text;
    else out.push({ type: 'text', text, ...(m.length ? { marks: m } : {}) });
  };

  const linkError = (pos: number): ParseError =>
    new ParseError(`${loc(pos)}행: 링크 주소는 http(s)://로 시작하거나 /로 시작하는 내부 경로, #앵커만 받는다`);

  /** 닫는 백틱 덩어리(길이가 같은 것)의 위치. 한 번 못 찾은 자리는 기억한다 — 닫지 않은 백틱 수만 개가 제곱으로 훑지 않게 */
  const codeFail = new Map<number, number>();
  const findCodeClose = (s: string, from: number, n: number): number => {
    const failed = codeFail.get(n);
    if (failed !== undefined && from >= failed) return -1;
    const re = /`+/g;
    re.lastIndex = from;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      if (m[0].length === n) {
        charge(ctx, m.index - from);
        return m.index;
      }
    }
    charge(ctx, s.length - from);
    codeFail.set(n, Math.min(failed ?? Infinity, from));
    return -1;
  };

  /** `[글](주소 "제목")` — 아니면 `null`. 대괄호·주소 길이에 상한이 있다(되풀이 훑기를 막는다) */
  const tryLink = (s: string, i: number): { labelEnd: number; dest: string; end: number } | null => {
    const limit = Math.min(s.length, i + 2000);
    let j = i;
    let depth = 0;
    for (; j < limit; j++) {
      const ch = s[j];
      if (ch === '\\') {
        j++;
        continue;
      }
      if (ch === '[') depth++;
      else if (ch === ']' && --depth === 0) break;
    }
    charge(ctx, j - i);
    if (j >= limit || s[j] !== ']' || s[j + 1] !== '(') return null;
    let k = j + 2;
    while (s[k] === ' ') k++;
    let dest: string;
    if (s[k] === '<') {
      const e = s.indexOf('>', k + 1);
      if (e < 0 || e - k > 8000 || s.slice(k + 1, e).includes('\n')) return null;
      dest = s.slice(k + 1, e);
      k = e + 1;
    } else {
      const start = k;
      const lim = Math.min(s.length, k + 8000);
      let parens = 0;
      for (; k < lim; k++) {
        const ch = s[k];
        if (ch === '\\') {
          k++;
          continue;
        }
        if (/\s/.test(ch)) break;
        if (ch === '(') parens++;
        else if (ch === ')') {
          if (parens === 0) break;
          parens--;
        }
      }
      charge(ctx, k - start);
      dest = s.slice(start, k).replace(/\\([!-/:-@[-`{-~])/g, '$1');
    }
    while (s[k] === ' ') k++;
    const q = s[k];
    if (q === '"' || q === "'" || q === '(') {
      const closer = q === '(' ? ')' : q;
      const e = s.indexOf(closer, k + 1);
      if (e < 0 || e - k > 2000) return null;
      k = e + 1;
      while (s[k] === ' ') k++;
    }
    if (s[k] !== ')') return null;
    return { labelEnd: j, dest, end: k + 1 };
  };

  const run = (s: string, off: number, marks: DocMark[], depth: number): void => {
    charge(ctx, s.length);
    const nestOk = depth < MARKDOWN_LIMITS.maxNesting;
    const inLink = marks.some((m) => m.type === 'link');
    const emFail = new Map<string, number>();
    let buf = '';
    const flush = (): void => {
      if (buf) emit(buf, marks);
      buf = '';
    };

    /** 닫는 서식 표지의 위치. 코드 조각 안은 건너뛰고, 한 번 못 찾은 자리는 기억한다 */
    const findEmClose = (from: number, c: string, k: number): number => {
      const key = c + k;
      const failed = emFail.get(key);
      if (failed !== undefined && from >= failed) return -1;
      let j = from;
      let found = -1;
      while (j < s.length) {
        const ch = s[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '`') {
          let n = 1;
          while (s[j + n] === '`') n++;
          const cl = findCodeClose(s, j + n, n);
          j = cl >= 0 ? cl + n : j + n;
          continue;
        }
        if (ch !== c) {
          j++;
          continue;
        }
        let r = 1;
        while (s[j + r] === c) r++;
        const prev = s[j - 1];
        const lenOk = c === '~' ? r >= 2 : k === 1 ? r === 1 : r >= k;
        const afterOk = c !== '_' || !ALNUM.test(s[j + k] ?? '');
        if (j > from && prev !== undefined && !/\s/.test(prev) && lenOk && afterOk) {
          found = j;
          break;
        }
        j += r;
      }
      charge(ctx, (found >= 0 ? found : s.length) - from);
      if (found < 0) emFail.set(key, Math.min(failed ?? Infinity, from));
      return found;
    };

    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\n') {
        flush();
        out.push({ type: 'hardBreak' });
        i++;
      } else if (c === '\\') {
        const nx = s[i + 1];
        if (nx !== undefined && ESCAPABLE.test(nx)) {
          buf += nx;
          i += 2;
        } else {
          buf += c;
          i++;
        }
      } else if (c === '`') {
        let n = 1;
        while (s[i + n] === '`') n++;
        const close = findCodeClose(s, i + n, n);
        if (close < 0) {
          buf += '`'.repeat(n);
          i += n;
          continue;
        }
        let inner = s.slice(i + n, close).replace(/\n/g, ' ');
        if (inner.length >= 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '') inner = inner.slice(1, -1);
        flush();
        emit(inner, [...marks, { type: 'code' }]);
        i = close + n;
      } else if (c === '<' && /[A-Za-z/!?]/.test(s[i + 1] ?? '')) {
        const rest = s.slice(i, i + 2100);
        const auto = /^<(https?:\/\/[^\s<>]*)>/i.exec(rest);
        if (auto) {
          flush();
          emit(auto[1], inLink ? marks : [...marks, { type: 'link', attrs: { href: auto[1] } }]);
          i += auto[0].length;
        } else if (/^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/.test(rest)) {
          throw linkError(off + i);
        } else {
          throw new ParseError(`${loc(off + i)}행: 원시 HTML은 받지 않는다 — 꺾쇠를 글자로 쓰려면 \\<로, 코드로 보이려면 백틱 안에 쓴다`);
        }
      } else if (c === '!' && s[i + 1] === '[') {
        if (tryLink(s, i + 1)) throw new ParseError(`${loc(off + i)}행: 그림은 문서에 넣을 수 없다 — 글·제목·목록·표·인용·코드·링크만 받는다`);
        buf += c;
        i++;
      } else if (c === '[' && !inLink) {
        const L = tryLink(s, i);
        if (!L) {
          buf += c;
          i++;
          continue;
        }
        const href = L.dest.trim();
        if (!ALLOWED_LINK_HREF.test(href)) throw linkError(off + i);
        flush();
        run(s.slice(i + 1, L.labelEnd), off + i + 1, [...marks, { type: 'link', attrs: { href } }], depth + 1);
        i = L.end;
      } else if ((c === '*' || c === '_' || c === '~') && nestOk) {
        let r = 1;
        while (s[i + r] === c) r++;
        const k = c === '~' ? (r === 2 ? 2 : 0) : r <= 3 ? r : 0;
        const next = s[i + r];
        const canOpen = k > 0 && next !== undefined && !/\s/.test(next) && (c !== '_' || !ALNUM.test(s[i - 1] ?? ''));
        const close = canOpen ? findEmClose(i + r, c, k) : -1;
        if (close < 0) {
          buf += c.repeat(r);
          i += r;
          continue;
        }
        const added: DocMark[] = c === '~' ? [{ type: 'strike' }] : k === 1 ? [{ type: 'italic' }] : k === 2 ? [{ type: 'bold' }] : [{ type: 'bold' }, { type: 'italic' }];
        flush();
        run(s.slice(i + r, close), off + i + r, [...marks, ...added], depth + 1);
        i = close + k;
      } else {
        buf += c;
        i++;
      }
    }
    flush();
  };

  run(src, 0, [], 0);
  return out;
}

// ---- 블록 ----

const RE_FENCE_BT = /^( {0,3})(`{3,})([^`]*)$/;
const RE_FENCE_TD = /^( {0,3})(~{3,})(.*)$/;
const RE_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_QUOTE = /^ {0,3}>/;
const RE_BULLET = /^( {0,3})([-+*])(?=[ \t]|$)(.*)$/;
const RE_ORDERED = /^( {0,3})(\d{1,9})([.)])(?=[ \t]|$)(.*)$/;
const CODE_LANGUAGE = /^[A-Za-z0-9_+.#-]{1,40}$/;

const isBlank = (t: string): boolean => BLANK.test(t);
const indentOf = (t: string): number => /^ */.exec(t)![0].length;
const stripIndent = (t: string, n: number): string => t.slice(Math.min(n, indentOf(t)));

/** 문단 도중에 새 블록을 여는 줄인가 — 목록은 빈 항목·`1`이 아닌 번호로는 문단을 끊지 못한다 (CommonMark) */
function startsBlock(t: string, nested = false): boolean {
  if (RE_HEADING.test(t) || RE_FENCE_BT.test(t) || RE_FENCE_TD.test(t) || RE_HR.test(t) || RE_QUOTE.test(t)) return true;
  const b = RE_BULLET.exec(t);
  if (b) return b[3].trim() !== '';
  const o = RE_ORDERED.exec(t);
  // 항목·인용 **안**에서는 어떤 번호든 문단을 끊는다 — `renderDocMarkdown`이 문단 바로 뒤에 `3. 나`처럼 안쪽 번호 목록을 붙여 쓴다(왕복)
  return !!o && (nested || o[2] === '1') && o[4].trim() !== '';
}

const paragraphNode = (content: DocNode[]): DocNode => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });

/** 표 한 줄을 칸으로 — 바깥 `|`는 떼고, `\|`는 글자 `|`다 (`\\`는 짝으로 건너뛴다) */
function splitRow(raw: string): string[] {
  const s = raw.trim();
  const cells: string[] = [];
  let cur = '';
  let i = s.startsWith('|') ? 1 : 0;
  let endedWithSeparator = false;
  for (; i < s.length; i++) {
    endedWithSeparator = false;
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      cur += s[i + 1] === '|' ? '|' : c + s[i + 1];
      i++;
    } else if (c === '|') {
      cells.push(cur.trim());
      cur = '';
      endedWithSeparator = true;
    } else cur += c;
  }
  if (!endedWithSeparator) cells.push(cur.trim());
  return cells;
}

type Align = 'left' | 'center' | 'right' | null;

/** `lines[i]`가 표의 머리 줄이고 다음 줄이 구분 줄이면 칸과 정렬, 아니면 `null` (GFM — 칸 수가 같아야 한다) */
function tableHead(lines: Line[], i: number): { head: string[]; aligns: Align[] } | null {
  const a = lines[i]?.t;
  const b = lines[i + 1]?.t;
  if (a === undefined || b === undefined || !a.includes('|') || !b.includes('|') || indentOf(a) > 3 || indentOf(b) > 3) return null;
  const head = splitRow(a);
  const delim = splitRow(b);
  if (head.length === 0 || head.length !== delim.length) return null;
  const aligns: Align[] = [];
  for (const d of delim) {
    const m = /^(:?)-+(:?)$/.exec(d);
    if (!m) return null;
    aligns.push(m[1] && m[2] ? 'center' : m[2] ? 'right' : m[1] ? 'left' : null);
  }
  return { head, aligns };
}

function parseBlocks(lines: Line[], depth: number, ctx: Ctx): DocNode[] {
  const nested = depth > 0;
  if (depth > MARKDOWN_LIMITS.maxNesting) throw new ParseError(`${lines[0]?.no ?? 1}행: 인용·목록이 너무 깊이 겹쳤다 (${MARKDOWN_LIMITS.maxNesting}단계까지)`);
  const blocks: DocNode[] = [];

  const inlineOf = (text: string, no: number): DocNode[] => parseInline(text, ctx, () => no);
  /** 항목·인용 안의 줄들을 블록으로. 비어 있으면 빈 문단 하나 — 비어 있을 수 없는 노드다 */
  const inner = (sub: Line[]): DocNode[] => {
    const out = parseBlocks(sub, depth + 1, ctx);
    return out.length ? out : [paragraphNode([])];
  };

  let i = 0;
  while (i < lines.length) {
    const L = lines[i];
    const t = L.t;
    if (isBlank(t)) {
      i++;
      continue;
    }

    // 울타리 코드 블록
    const fence = RE_FENCE_BT.exec(t) ?? RE_FENCE_TD.exec(t);
    if (fence) {
      const indent = fence[1].length;
      const mark = fence[2];
      const body: string[] = [];
      i++;
      const closing = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}[ \\t]*$`);
      while (i < lines.length && !closing.test(lines[i].t)) body.push(stripIndent(lines[i++].t, indent));
      i++; // 닫는 울타리 — 없으면 끝까지가 코드다
      const lang = fence[3].trim().split(/\s+/)[0] ?? '';
      const text = body.join('\n');
      blocks.push({
        type: 'codeBlock',
        ...(CODE_LANGUAGE.test(lang) ? { attrs: { language: lang } } : {}),
        ...(text ? { content: [{ type: 'text', text }] } : {}),
      });
      continue;
    }

    const h = RE_HEADING.exec(t);
    if (h) {
      const raw = (h[2] ?? '').replace(/(^|[ \t]+)#+[ \t]*$/, '').trim();
      const content = inlineOf(raw, L.no);
      blocks.push({ type: 'heading', attrs: { level: h[1].length }, ...(content.length ? { content } : {}) });
      i++;
      continue;
    }

    if (RE_HR.test(t)) {
      blocks.push({ type: 'horizontalRule' });
      i++;
      continue;
    }

    if (RE_QUOTE.test(t)) {
      const sub: Line[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (RE_QUOTE.test(cur.t)) sub.push({ t: cur.t.replace(/^ {0,3}> ?/, ''), no: cur.no });
        else {
          // 게으른 이음 — 인용 안 문단의 다음 줄을 `>` 없이 이어 써도 같은 문단이다
          const prev = sub[sub.length - 1];
          const paragraphish = prev && !isBlank(prev.t) && !RE_HEADING.test(prev.t) && !RE_HR.test(prev.t) && !RE_FENCE_BT.test(prev.t) && !RE_FENCE_TD.test(prev.t);
          if (isBlank(cur.t) || !paragraphish || startsBlock(cur.t)) break;
          sub.push(cur);
        }
        i++;
      }
      blocks.push({ type: 'blockquote', content: inner(sub) });
      continue;
    }

    const bullet = RE_BULLET.exec(t);
    const ordered = bullet ? null : RE_ORDERED.exec(t);
    if (bullet || ordered) {
      const isOrdered = !!ordered;
      const kind = bullet ? bullet[2] : ordered![3];
      const start = ordered ? Number(ordered[2]) : 0;
      const items: DocNode[] = [];
      while (i < lines.length) {
        const first = lines[i];
        const m = isOrdered ? RE_ORDERED.exec(first.t) : RE_BULLET.exec(first.t);
        if (!m || RE_HR.test(first.t) || (isOrdered ? m[3] : m[2]) !== kind) break;
        const indent = m[1].length;
        const markerLen = isOrdered ? m[2].length + 1 : 1;
        const rest = isOrdered ? m[4] : m[3];
        const spaces = /^[ \t]*/.exec(rest)![0].length;
        const sp = rest.trim() === '' ? 1 : spaces >= 5 ? 1 : spaces;
        const contentIndent = indent + markerLen + sp;
        const sub: Line[] = [{ t: rest.trim() === '' ? '' : rest.slice(Math.min(sp, spaces)), no: first.no }];
        let j = i + 1;
        while (j < lines.length) {
          const cur = lines[j];
          if (isBlank(cur.t)) {
            let k = j;
            while (k < lines.length && isBlank(lines[k].t)) k++;
            if (k < lines.length && indentOf(lines[k].t) >= contentIndent) {
              for (; j < k; j++) sub.push({ t: '', no: lines[j].no });
              continue;
            }
            break;
          }
          if (indentOf(cur.t) >= contentIndent) {
            sub.push({ t: stripIndent(cur.t, contentIndent), no: cur.no });
            j++;
            continue;
          }
          const prev = sub[sub.length - 1];
          if (!isBlank(prev.t) && !startsBlock(cur.t) && !RE_BULLET.test(cur.t) && !RE_ORDERED.test(cur.t)) {
            sub.push({ t: cur.t.replace(/^[ \t]+/, ''), no: cur.no }); // 게으른 이음
            j++;
            continue;
          }
          break;
        }
        const body = inner(sub);
        if (body[0].type !== 'paragraph') body.unshift(paragraphNode([])); // 목록 항목의 첫 자식은 문단이다 (FIRST_CHILD)
        items.push({ type: 'listItem', content: body });
        i = j;
        // 항목 사이의 빈 줄은 같은 목록이다 — 다음 표지가 같은 종류인지 본다
        let k = i;
        while (k < lines.length && isBlank(lines[k].t)) k++;
        if (k > i && k < lines.length) {
          const nm = isOrdered ? RE_ORDERED.exec(lines[k].t) : RE_BULLET.exec(lines[k].t);
          if (nm && !RE_HR.test(lines[k].t) && (isOrdered ? nm[3] : nm[2]) === kind) i = k;
        }
      }
      blocks.push(isOrdered ? { type: 'orderedList', attrs: { start }, content: items } : { type: 'bulletList', content: items });
      continue;
    }

    const table = tableHead(lines, i);
    if (table) {
      const width = table.head.length;
      const cell = (kind: 'tableHeader' | 'tableCell', text: string, col: number, no: number): DocNode => ({
        type: kind,
        ...(table.aligns[col] ? { attrs: { align: table.aligns[col] } } : {}),
        content: [paragraphNode(inlineOf(text, no))],
      });
      const rows: DocNode[] = [{ type: 'tableRow', content: table.head.map((c, col) => cell('tableHeader', c, col, L.no)) }];
      i += 2;
      while (i < lines.length && !isBlank(lines[i].t) && !startsBlock(lines[i].t)) {
        const cells = splitRow(lines[i].t);
        const no = lines[i].no;
        rows.push({ type: 'tableRow', content: Array.from({ length: width }, (_, col) => cell('tableCell', cells[col] ?? '', col, no)) });
        i++;
      }
      blocks.push({ type: 'table', content: rows });
      continue;
    }

    // 문단
    const para: Line[] = [L];
    i++;
    while (i < lines.length && !isBlank(lines[i].t) && !startsBlock(lines[i].t, nested) && !tableHead(lines, i)) para.push(lines[i++]);
    let text = '';
    const starts: number[] = [];
    para.forEach((pl, idx) => {
      starts.push(text.length);
      const s = pl.t.replace(/^[ \t]+/, '');
      if (idx === para.length - 1) {
        text += s.replace(/[ \t]+$/, '');
        return;
      }
      const bs = /\\+$/.exec(s);
      if (bs && bs[0].length % 2 === 1) text += `${s.slice(0, -1)}\n`; // 줄 끝 `\` — 줄바꿈
      else if (/ {2,}$/.test(s)) text += `${s.trimEnd()}\n`; // 줄 끝 빈칸 둘 — 줄바꿈
      else text += `${s.trimEnd()} `; // 그냥 줄바꿈은 빈칸 하나
    });
    const loc: Loc = (pos) => {
      let idx = 0;
      while (idx + 1 < starts.length && starts[idx + 1] <= pos) idx++;
      return para[idx].no;
    };
    const content = parseInline(text, ctx, loc);
    if (content.length) blocks.push({ type: 'paragraph', content });
  }
  return blocks;
}

/**
 * 마크다운을 문서로 바꾼다. 어떤 입력에도 던지지 않는다 — 받지 않는 것은 `{ ok: false, errors }`(줄 번호와 규칙, 입력한 글은 되읊지 않는다)이고,
 * 성공한 문서는 `validateDocument`를 통과했다
 */
export function parseMarkdown(input: string): MarkdownParseResult {
  if (input.length > MARKDOWN_LIMITS.maxInputChars) {
    return { ok: false, errors: [`마크다운이 너무 길다 (${MARKDOWN_LIMITS.maxInputChars}자까지)`] };
  }
  try {
    const lines: Line[] = input.split(/\r\n|\r|\n/).map((t, idx) => ({ t: t.replace(/^\t+/, (m) => '    '.repeat(m.length)), no: idx + 1 }));
    const blocks = parseBlocks(lines, 0, { work: 0 });
    const doc: DocNode = {
      type: 'doc',
      attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION },
      content: blocks.length ? blocks : [paragraphNode([])],
    };
    // 마지막 관문 — 위의 규칙이 어긋나도 정본이 받지 않는 문서를 내보내지 않는다
    const v = validateDocument(doc);
    if (!v.ok) return { ok: false, errors: ['변환한 문서가 문서 규칙을 어긋난다', ...v.errors.slice(0, 5)] };
    return { ok: true, doc };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, errors: [e.message] };
    return { ok: false, errors: ['마크다운을 변환하지 못했다'] };
  }
}
