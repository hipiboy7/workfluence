import { MARKDOWN_LIMITS } from './constants';
import { ALLOWED_LINK_HREF, ALLOWED_MARKS, ALLOWED_NODES, extractText, type DocMark, type DocNode } from './document';

/**
 * 문서 JSON → 마크다운·텍스트 (A등급, P10_설계서_Llm D.7·FR-1140~1142).
 *
 * 페이지 보기의 "마크다운 복사"가 쓴다. 복사한 것은 LLM 질문 칸이나 다른 편집기에 붙는다 — 그래서 두 가지를 지킨다.
 *
 * 1. **허용 목록은 `document.ts`의 것을 그대로 쓴다.** 목록 밖 노드는 통째로 빼고, 목록 밖 마크는 무시하되 글자는 남긴다
 *    (`html.ts`와 같은 규칙 — 목록이 두 벌이면 "저장은 되는데 복사하면 사라지는" 노드가 생긴다, 1.3절).
 * 2. **문서의 글자가 붙인 곳에서 서식이 되지 않는다.** 본문의 `*` 한 글자가 기울임이, 줄 머리의 `#`가 제목이 되지 않게
 *    이스케이프한다.
 */

/** 어디서나 이스케이프하는 기호 — 서식·링크·HTML이 되는 것들 */
const INLINE_SPECIAL = /[\\*_`[\]~<]/g;

function escapeInline(text: string): string {
  return text.replace(INLINE_SPECIAL, (c) => `\\${c}`);
}

/** 줄 머리에서 블록이 되는 표기 — 제목·인용·목록·가로줄·setext 밑줄. 빈칸 셋까지는 들여 써도 같다 (CommonMark) */
const LINE_START = /^( {0,3})(?:([#>+=-])|(\d+)([.)]))/;

function escapeLineStarts(s: string): string {
  return s
    .split('\n')
    .map((line) =>
      line.replace(LINE_START, (_m, space: string, symbol: string | undefined, digits: string | undefined, punct: string | undefined) =>
        symbol !== undefined ? `${space}\\${symbol}` : `${space}${digits}\\${punct}`,
      ),
    )
    .join('\n');
}

const allowed = (node: DocNode): boolean => Object.hasOwn(ALLOWED_NODES, node.type);

/**
 * 가장 긴 백틱 덩어리의 길이. **스프레드로 셈하지 않는다** — `Math.max(...덩어리들)`은 덩어리가 13만 개쯤이면 인자 수 한도에
 * 걸려 던진다 (검토 반영)
 */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) if (m[0].length > longest) longest = m[0].length;
  return longest;
}

/** 코드 조각. 안에 백틱이 있으면 더 긴 백틱으로 감싸고, 백틱으로 시작·끝나면 빈칸을 둔다 (CommonMark) */
function codeSpan(text: string): string {
  const longest = longestBacktickRun(text);
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** **앞뒤 빈칸은 표지 밖으로 뺀다** — `** 굵게 **`는 마크다운에서 굵게가 아니다. 빈칸뿐이면 감싸지 않는다 */
function wrapEmphasis(s: string, marker: string): string {
  // 이 식은 어떤 문자열에도 맞는다 — 가운데가 비었는지(빈칸뿐인지)만 본다
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s) as RegExpExecArray;
  if (!m[2]) return s;
  return `${m[1]}${marker}${m[2]}${marker}${m[3]}`;
}

/** 링크는 허용 주소만 (FR-1142). 통과하지 못하면 **글자만** 남긴다. 주소의 빈칸·괄호는 링크를 끊지 않게 바꾼다 */
function wrapLink(label: string, mark: DocMark): string {
  const raw = typeof mark.attrs?.href === 'string' ? mark.attrs.href.trim() : '';
  if (!raw || !ALLOWED_LINK_HREF.test(raw)) return label;
  const href = raw.replace(/[\s()]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c)));
  return `[${label}](${href})`;
}

function renderText(node: DocNode): string {
  const text = node.text ?? '';
  if (!text) return '';
  const marks = (node.marks ?? []).filter((m) => Object.hasOwn(ALLOWED_MARKS, m.type));
  let out = marks.some((m) => m.type === 'code') ? codeSpan(text) : escapeInline(text);
  for (const mark of marks) {
    if (mark.type === 'bold') out = wrapEmphasis(out, '**');
    else if (mark.type === 'italic') out = wrapEmphasis(out, '*');
    else if (mark.type === 'strike') out = wrapEmphasis(out, '~~');
    else if (mark.type === 'link') out = wrapLink(out, mark);
    // `code`는 위에서 반영했다. `underline`은 마크다운에 표기가 없어 글자만 남긴다
  }
  return out;
}

/** 글자 줄. `hardBreak`를 무엇으로 바꿀지는 자리가 정한다 — 문단은 줄 끝 `\`, 제목·표 칸은 빈칸(한 줄이어야 한다) */
function renderInline(nodes: DocNode[] | undefined, hardBreak: string): string {
  let out = '';
  for (const n of nodes ?? []) {
    if (!allowed(n)) continue;
    if (n.type === 'hardBreak') out += hardBreak;
    else if (n.type === 'text') {
      const piece = renderText(n);
      // **`!` 바로 뒤의 링크는 그림 표기(`![…](…)`)가 된다** — 앞 글자의 `!`를 이스케이프한다 (검토 반영)
      if (piece.startsWith('[') && out.endsWith('!')) out = `${out.slice(0, -1)}\\!`;
      out += piece;
    } else out += renderInline(n.content, hardBreak);
  }
  return out;
}

const HARD_BREAK = '\\\n';

function renderParagraph(node: DocNode): string {
  // 앞뒤의 줄바꿈만 있는 것은 뜻이 없다 — 문단 끝의 `\`는 마크다운에서 글자로 남는다
  const inline = renderInline(node.content, HARD_BREAK).replace(/^(?:\\\n)+/, '').replace(/(?:\\\n)+$/, '');
  return inline.trim() ? escapeLineStarts(inline) : '';
}

function renderHeading(node: DocNode): string {
  const level = Number(node.attrs?.level ?? 1);
  // 단계가 틀리면 1단계로 읽는다 — HTML 내보내기(`html.ts`)와 같다
  const h = Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1;
  const inline = renderInline(node.content, ' ');
  return inline.trim() ? `${'#'.repeat(h)} ${inline}` : '';
}

const isList = (n: DocNode) => n.type === 'bulletList' || n.type === 'orderedList';

/** 목록 항목 안의 블록들. 문단 뒤에 오는 목록은 한 줄로 붙이고(안쪽 목록), 나머지는 빈 줄로 나눈다 */
function renderItemBody(item: DocNode): string {
  let out = '';
  for (const child of item.content ?? []) {
    if (!allowed(child)) continue;
    const text = renderBlock(child);
    if (!text) continue;
    out += out ? `${isList(child) ? '\n' : '\n\n'}${text}` : text;
  }
  return out;
}

function renderList(node: DocNode): string {
  const ordered = node.type === 'orderedList';
  const start = node.attrs?.start;
  let n = ordered && typeof start === 'number' && Number.isInteger(start) && start >= 0 ? start : 1;
  const items: string[] = [];
  for (const item of node.content ?? []) {
    if (!allowed(item)) continue;
    const marker = ordered ? `${n++}.` : '-';
    const body = renderItemBody(item);
    if (!body) {
      items.push(marker);
      continue;
    }
    // 안쪽 줄은 **표지 너비만큼** 들여 쓴다 — 그래야 같은 항목의 몸으로 읽힌다
    const indent = ' '.repeat(marker.length + 1);
    const [first, ...rest] = body.split('\n');
    items.push([`${marker} ${first}`, ...rest.map((l) => (l ? indent + l : ''))].join('\n'));
  }
  return items.join('\n');
}

function renderBlockquote(node: DocNode): string {
  const inner = renderBlocks(node.content);
  if (!inner) return '';
  return inner
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
}

/** 언어 이름으로 받는 글자. 이 밖이면 뺀다 — 울타리 줄에 무엇이 붙든 코드 밖이 되지 않게 */
const CODE_LANGUAGE = /^[A-Za-z0-9_+.#-]{1,40}$/;

function renderCodeBlock(node: DocNode): string {
  const text = (node.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
  // 울타리는 안의 가장 긴 백틱보다 길게 — 코드가 울타리를 닫지 않게
  const longest = longestBacktickRun(text);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const language = node.attrs?.language;
  const lang = typeof language === 'string' && CODE_LANGUAGE.test(language) ? language : '';
  return text ? `${fence}${lang}\n${text}\n${fence}` : `${fence}${lang}\n${fence}`;
}

/** 칸 합치기 값 — 정수 1 이상만, 상한(`MARKDOWN_LIMITS.maxSpan`)까지 */
function spanOf(cell: DocNode, key: 'colspan' | 'rowspan'): number {
  const v = cell.attrs?.[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? Math.min(v, MARKDOWN_LIMITS.maxSpan) : 1;
}

function alignMarker(cell: DocNode | undefined): string {
  const a = cell?.attrs?.align;
  if (a === 'center') return ':---:';
  if (a === 'right') return '---:';
  if (a === 'left') return ':---';
  return '---';
}

/** 칸 하나 — 칸 안의 블록 여럿과 줄바꿈은 빈칸으로 잇는다(표의 칸은 한 줄이다). `|`는 이스케이프한다 */
function cellText(cell: DocNode): string {
  const parts: string[] = [];
  for (const b of cell.content ?? []) {
    if (!allowed(b)) continue;
    const s = b.type === 'paragraph' || b.type === 'heading' ? renderInline(b.content, ' ') : renderBlock(b);
    if (s.trim()) parts.push(s.replace(/\s*\n\s*/g, ' '));
  }
  return parts.join(' ').replace(/\|/g, '\\|');
}

/**
 * GFM 표. **첫 줄이 머리다** — GFM 표는 머리 줄이 있어야 표가 된다. 칸 합치기는 표기가 없어 첫 칸에 두고 나머지를 비운다
 * (열 수가 줄마다 같아야 표가 된다). **세로로 합친 칸(`rowspan`)은 아래 줄에서 그 자리를 비운다** — 안 그러면 아래 줄의 값이
 * 왼쪽으로 밀려 다른 머리 밑에 선다(검토 반영 — 코드 리뷰 11). 정렬은 첫 줄의 칸에서 읽는다.
 */
function renderTable(node: DocNode): string {
  const rows: string[][] = [];
  const heads: (DocNode | undefined)[] = [];
  // 열마다 위에서 내려온 합친 칸이 몇 줄 더 차지하나
  const carry: number[] = [];
  for (const row of node.content ?? []) {
    if (row.type !== 'tableRow') continue;
    const cells: string[] = [];
    const skipCarried = () => {
      while ((carry[cells.length] ?? 0) > 0) {
        carry[cells.length] -= 1;
        cells.push('');
      }
    };
    for (const cell of row.content ?? []) {
      if (cell.type !== 'tableCell' && cell.type !== 'tableHeader') continue;
      skipCarried();
      const cols = spanOf(cell, 'colspan');
      const down = spanOf(cell, 'rowspan') - 1;
      for (let i = 0; i < cols; i++) {
        if (down > 0) carry[cells.length + i] = down;
      }
      cells.push(cellText(cell), ...Array<string>(cols - 1).fill(''));
      if (rows.length === 0) heads.push(cell, ...Array<undefined>(cols - 1).fill(undefined));
    }
    skipCarried();
    rows.push(cells);
  }
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (width === 0) return '';
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  const separator = `| ${Array.from({ length: width }, (_, i) => alignMarker(heads[i])).join(' | ')} |`;
  return [line(rows[0]), separator, ...rows.slice(1).map(line)].join('\n');
}

function renderBlock(node: DocNode): string {
  switch (node.type) {
    case 'paragraph':
      return renderParagraph(node);
    case 'heading':
      return renderHeading(node);
    case 'bulletList':
    case 'orderedList':
      return renderList(node);
    case 'blockquote':
      return renderBlockquote(node);
    case 'codeBlock':
      return renderCodeBlock(node);
    case 'horizontalRule':
      return '---';
    case 'table':
      return renderTable(node);
    case 'text':
      return escapeLineStarts(renderText(node));
    case 'hardBreak':
      return '';
    default:
      // 제자리가 아닌 곳에 온 목록 항목·표 줄 등 — 안의 블록을 그린다
      return renderBlocks(node.content);
  }
}

function renderBlocks(nodes: DocNode[] | undefined): string {
  return (nodes ?? [])
    .filter(allowed)
    .map(renderBlock)
    .filter((s) => s.length > 0)
    .join('\n\n');
}

/** 문서 본문만 */
export function renderDocMarkdown(doc: DocNode): string {
  return renderBlocks(doc.content);
}

/** "마크다운 복사" (FR-1140) — 제목을 1단계 제목으로 얹는다 */
export function pageMarkdown(title: string, doc: DocNode): string {
  const body = renderDocMarkdown(doc);
  const head = `# ${escapeInline(title)}`;
  return body ? `${head}\n\n${body}` : head;
}

/** "텍스트 복사" (FR-1141) — 제목 + 빈 줄 + **검색 인덱스와 같은 평문**(`extractText`). 추출 규칙을 두 벌 두지 않는다 */
export function pageText(title: string, doc: DocNode): string {
  const body = extractText(doc);
  return body ? `${title}\n\n${body}` : title;
}
