import { DOCUMENT_SCHEMA_VERSION } from './constants';

/**
 * 페이지 본문(ProseMirror/TipTap JSON) 검증·텍스트 추출 (CLAUDE.md 6절·7절).
 *
 * 서버는 HTML을 받지 않고 이 JSON만 받는다. 허용 목록 밖의 노드·마크·속성은 거부한다.
 * **편집기(apps/web)의 스키마와 이 허용 목록은 같다** — `apps/web/src/components/extensions.spec.ts`가 양쪽으로 대조한다
 * (P9_설계서_Gate D.7). 어긋나면 편집기가 만든 문서가 거부되고(실시간 편집에서는 연결이 끊긴다), 허용 목록에만 있는 것은
 * 조작한 클라이언트만 넣는 "보이지 않는 속성"이 된다(보류 22).
 * 같은 규칙을 실시간 편집의 관문(`apps/api/src/pages/domain/gate.ts`)도 쓴다 — 그래서 속성·마크 판정을 함수로 내보낸다.
 * 검증은 순수 함수라 A등급(테스트 먼저).
 */

export type DocNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  marks?: DocMark[];
  text?: string;
};

export type DocMark = {
  type: string;
  attrs?: Record<string, unknown>;
};

/**
 * 허용 노드와 각 노드에 허용되는 속성 키.
 * `doc`에 `schemaVersion`을 허용한다 — 저장된 문서가 어느 스키마로 만들어졌는지 스스로 말해야
 * 나중에 허용 목록이 바뀌었을 때 옛 문서를 어떻게 다룰지 판단할 수 있다 (`CLAUDE.md` 6절).
 */
export const ALLOWED_NODES: Record<string, readonly string[]> = {
  doc: ['schemaVersion'],
  // **`textAlign`을 뺐다** (P9 D.7). 편집기에 정렬 확장이 없어 만들 수 없는 속성이었다 — 조작한 클라이언트만 넣는다
  paragraph: [],
  heading: ['level'],
  text: [],
  bulletList: [],
  orderedList: ['start', 'type'],
  listItem: [],
  codeBlock: ['language'],
  blockquote: [],
  horizontalRule: [],
  hardBreak: [],
  table: [],
  tableRow: [],
  // `align`은 편집기가 붙여 넣은 HTML의 정렬에서 만든다 (P9 D.7 — 전에는 정렬된 표를 붙여 넣으면 저장이 멈췄다)
  tableCell: ['colspan', 'rowspan', 'colwidth', 'align'],
  tableHeader: ['colspan', 'rowspan', 'colwidth', 'align'],
};

/** 허용 마크와 속성 키 */
export const ALLOWED_MARKS: Record<string, readonly string[]> = {
  bold: [],
  italic: [],
  strike: [],
  underline: [],
  code: [],
  // `title`은 붙여 넣은 링크의 `title`에서 온다 (P9 D.7)
  link: ['href', 'target', 'rel', 'class', 'title'],
};

const BLOCKS = ['blockquote', 'bulletList', 'codeBlock', 'heading', 'horizontalRule', 'orderedList', 'paragraph', 'table'] as const;

/**
 * **그 자리에 올 수 있는 자식** — 편집기 스키마의 내용 식에서 나올 수 있는 노드 종류다(P9_설계서_Gate D.2). `text`는 글자.
 * 순서와 개수(예: `listItem`은 문단으로 시작한다)는 보지 않는다 — 내용 식 전체를 옮기려면 서버에 ProseMirror가 든다(D.8).
 *
 * 조작한 클라이언트는 이것을 무시할 수 있고, 받은 편집기는 그런 문서를 그린 뒤 그 근처의 편집에서 깨진다(P9 B.1).
 */
export const ALLOWED_CHILDREN: Record<string, readonly string[]> = {
  doc: BLOCKS,
  paragraph: ['hardBreak', 'text'],
  heading: ['hardBreak', 'text'],
  text: [],
  bulletList: ['listItem'],
  orderedList: ['listItem'],
  listItem: BLOCKS,
  codeBlock: ['text'],
  blockquote: BLOCKS,
  horizontalRule: [],
  hardBreak: [],
  table: ['tableRow'],
  tableRow: ['tableCell', 'tableHeader'],
  tableCell: BLOCKS,
  tableHeader: BLOCKS,
};

/**
 * **글자를 담는 노드가 받는 마크** (P9 D.2). `codeBlock`은 아무 마크도 받지 않는다 — 코드 블록 안의 굵은 글자를 받은
 * 편집기는 **그 블록을 통째로 지웠다**(P9 B.1 실측).
 */
export const MARKS_IN: Record<string, readonly string[]> = {
  paragraph: ['bold', 'code', 'italic', 'link', 'strike', 'underline'],
  heading: ['bold', 'code', 'italic', 'link', 'strike', 'underline'],
  codeBlock: [],
};

/** 링크는 http(s)·내부 경로·앵커만 (CLAUDE.md 7절). javascript:·data: 등은 거부. */
export const ALLOWED_LINK_HREF = /^(https?:\/\/|\/(?!\/)|#)/i;

export const MAX_DOCUMENT_NODES = 50_000;
export const MAX_DOCUMENT_DEPTH = 64;

export type DocumentValidation = { ok: true } | { ok: false; errors: string[] };

export function validateDocument(input: unknown): DocumentValidation {
  const errors: string[] = [];
  let nodeCount = 0;

  const visit = (node: unknown, path: string, depth: number): void => {
    if (errors.length >= 20) return;
    if (depth > MAX_DOCUMENT_DEPTH) {
      errors.push(`${path}: 중첩 깊이 ${MAX_DOCUMENT_DEPTH} 초과`);
      return;
    }
    if (++nodeCount > MAX_DOCUMENT_NODES) {
      errors.push(`노드 수 ${MAX_DOCUMENT_NODES} 초과`);
      return;
    }
    if (!isRecord(node)) {
      errors.push(`${path}: 노드는 객체여야 한다`);
      return;
    }
    const type = node.type;
    if (typeof type !== 'string' || !Object.hasOwn(ALLOWED_NODES, type)) {
      errors.push(`${path}: 허용되지 않는 노드 '${cut(String(type))}'`);
      return;
    }
    for (const problem of nodeAttrProblems(type, node.attrs)) errors.push(`${path}(${type}): ${problem}`);

    if (type === 'text') {
      if (typeof node.text !== 'string' || node.text.length === 0) errors.push(`${path}: text 노드는 비어 있지 않은 문자열`);
      if (node.content !== undefined) errors.push(`${path}: text 노드는 content를 가질 수 없다`);
    } else if (node.text !== undefined) {
      errors.push(`${path}: '${type}' 노드는 text를 가질 수 없다`);
    }

    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks)) {
        errors.push(`${path}: marks는 배열`);
      } else {
        node.marks.forEach((mark, i) => checkMark(mark, `${path}.marks[${i}]`, errors));
      }
    }

    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) {
        errors.push(`${path}: content는 배열`);
      } else {
        node.content.forEach((child, i) => {
          const childPath = `${path}.content[${i}]`;
          placementProblems(type, child, childPath, errors);
          visit(child, childPath, depth + 1);
        });
      }
    }
  };

  if (!isRecord(input) || input.type !== 'doc') {
    return { ok: false, errors: ['최상위 노드는 type: "doc"이어야 한다'] };
  }
  visit(input, 'doc', 0);
  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * 자식 하나가 그 자리에 올 수 있는가 (P9 D.2). **모르는 노드는 여기서 짚지 않는다** — 방문할 때 "허용되지 않는 노드"
 * 하나로 짚는다. 같은 잘못을 두 번 말하면 오류 20건의 한도를 헛되이 쓴다.
 */
function placementProblems(parent: string, child: unknown, path: string, errors: string[]): void {
  if (!isRecord(child) || typeof child.type !== 'string' || !Object.hasOwn(ALLOWED_NODES, child.type)) return;
  if (!ALLOWED_CHILDREN[parent].includes(child.type)) {
    errors.push(`${path}: '${parent}' 안에 올 수 없는 '${child.type}'`);
    return;
  }
  if (child.type !== 'text' || !Array.isArray(child.marks)) return;
  const allowed = MARKS_IN[parent];
  for (const m of child.marks) {
    if (isRecord(m) && typeof m.type === 'string' && Object.hasOwn(ALLOWED_MARKS, m.type) && !allowed.includes(m.type)) {
      errors.push(`${path}: '${parent}' 안의 글자는 마크 '${m.type}'를 받지 않는다`);
    }
  }
}

function checkMark(mark: unknown, path: string, errors: string[]): void {
  if (!isRecord(mark) || typeof mark.type !== 'string') {
    errors.push(`${path}: 허용되지 않는 마크 '${isRecord(mark) ? cut(String(mark.type)) : typeof mark}'`);
    return;
  }
  for (const problem of markProblems(mark.type, mark.attrs)) errors.push(`${path}: ${problem}`);
}

/**
 * **노드 하나의 속성 문제** — 정본 검증과 실시간 편집의 관문이 같이 쓴다 (P9 FR-1001).
 *
 * 까닭에 **값을 적지 않는다** — 이 글이 경고 로그·감사로그·저장 실패 로그로 간다(7절: 문서 내용을 기록에 남기지 않는다).
 * `partial`이면 "있어야 하는 속성"을 보지 않는다 — 관문은 속성을 하나씩(맵 항목마다) 보므로 없는 것을 판정할 수 없다.
 * 그 자리는 변환이 편집기와 같은 기본값으로 채운다(P9 FR-1010). 있는 값은 그래도 본다.
 */
export function nodeAttrProblems(type: string, attrs: unknown, opts: { partial?: boolean } = {}): string[] {
  if (!Object.hasOwn(ALLOWED_NODES, type)) return [`허용되지 않는 노드 '${cut(type)}'`];
  const out = attrProblems(attrs, ALLOWED_NODES[type]);
  if (type === 'heading') {
    const level = isRecord(attrs) ? attrs.level : undefined;
    const present = level !== undefined && level !== null;
    if ((present || !opts.partial) && (typeof level !== 'number' || level < 1 || level > 6)) out.push('heading.level은 1~6');
  }
  if ((type === 'tableCell' || type === 'tableHeader') && isRecord(attrs)) {
    // **화면이 style에 그대로 넣는 값**이다 — `align`은 `text-align: …`에, `colwidth`는 표 `colgroup`의 `width: …px`에
    // (TipTap 3.31.3). "원시값이면 된다"로는 `left; position:fixed; inset:0`이 지나가 보는 사람 모두의 화면을 덮는다
    // (P9 보안 검토 1). 편집기는 붙여 넣은 HTML에서도 `align`을 이 셋으로, `colwidth`를 `parseInt`한 숫자로 만든다
    const { align, colwidth } = attrs;
    if (align !== undefined && align !== null && !TABLE_ALIGN.has(align as string)) out.push("속성 'align' 값은 left·center·right");
    if (colwidth !== undefined && colwidth !== null && !(Array.isArray(colwidth) && colwidth.every((w) => w === null || typeof w === 'number'))) {
      out.push("속성 'colwidth' 값은 숫자 배열");
    }
  }
  return out;
}

/** 표 칸 정렬 — TipTap `normalizeTableCellAlign`이 받는 값과 같다 */
const TABLE_ALIGN: ReadonlySet<string> = new Set(['left', 'center', 'right']);

/** 이름·키는 조작한 클라이언트가 정한다 — 까닭(경고 로그·감사로그로 간다)이 불어나지 않게 40자로 자른다 (P9 코드 리뷰 4) */
function cut(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** **마크 하나의 문제** — 정본 검증과 관문이 같이 쓴다 (P9 FR-1001). 링크 주소도 적지 않는다 */
export function markProblems(type: string, attrs: unknown): string[] {
  if (!Object.hasOwn(ALLOWED_MARKS, type)) return [`허용되지 않는 마크 '${cut(type)}'`];
  const out = attrProblems(attrs, ALLOWED_MARKS[type]);
  if (type === 'link') {
    const href = isRecord(attrs) ? attrs.href : undefined;
    if (typeof href !== 'string' || !ALLOWED_LINK_HREF.test(href.trim())) out.push('허용되지 않는 링크 주소');
  }
  return out;
}

function attrProblems(attrs: unknown, allowed: readonly string[]): string[] {
  const errors: string[] = [];
  if (attrs === undefined || attrs === null) return errors;
  if (!isRecord(attrs)) {
    errors.push('attrs는 객체');
    return errors;
  }
  for (const [key, value] of Object.entries(attrs)) {
    // **값이 `null`·`undefined`인 속성은 없는 속성과 같다.**
    //
    // ProseMirror는 선언된 속성에 기본값 `null`을 채워 내보낸다 — TipTap의 링크는
    // `title: null`을, 표 칸은 `align: null`을 늘 달고 온다. 그것을 "허용되지 않는 속성"으로
    // 거부하면 **링크가 하나라도 있는 문서는 저장이 안 된다.** 실시간 편집에서는 그 거부가
    // 화면에 보이지도 않아(버전만 안 생긴다) 편집이 통째로 사라진다 (P6 자체 점검 1).
    //
    // 값이 없는 속성은 뜻도 없으므로 **허용 목록을 넓히는 대신 빈 값을 건너뛴다** —
    // 목록을 넓히면 편집기가 새 속성을 더할 때마다 같은 일이 반복된다.
    if (value === null || value === undefined) continue;
    if (!allowed.includes(key)) {
      errors.push(`허용되지 않는 속성 '${cut(key)}'`);
      continue;
    }
    if (!isPrimitiveOrPrimitiveArray(value)) errors.push(`속성 '${cut(key)}' 값은 원시값 또는 원시값 배열`);
  }
  return errors;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPrimitive(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function isPrimitiveOrPrimitiveArray(v: unknown): boolean {
  return isPrimitive(v) || (Array.isArray(v) && v.every(isPrimitive));
}

/** 검색 인덱싱용 평문 추출. 블록 경계는 줄바꿈, 인라인은 그대로 이어 붙인다. */
export function extractText(doc: DocNode): string {
  const parts: string[] = [];
  const walk = (node: DocNode): void => {
    if (node.type === 'text') {
      parts.push(node.text ?? '');
      return;
    }
    if (node.type === 'hardBreak') {
      parts.push('\n');
      return;
    }
    node.content?.forEach(walk);
    if (BLOCK_NODES.has(node.type)) parts.push('\n');
  };
  walk(doc);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 끝에 줄바꿈을 두는 블록. **`extractText`가 줄을 나누는 곳이다.**
 *
 * 내보내는 이유: 실시간 상태에서 멘션 자리를 찾는 쪽(`mentionSites`)이
 * **같은 곳에서 줄을 나눠야** 두 쪽이 같은 멘션을 찾는다 (P8_설계서_Mention C.2절).
 */
export const BLOCK_NODES: ReadonlySet<string> = new Set([
  'paragraph',
  'heading',
  'listItem',
  'codeBlock',
  'blockquote',
  'tableRow',
  'horizontalRule',
]);

/** 빈 문서. 새 페이지의 초기 본문. 스키마 버전을 함께 박는다 (`CLAUDE.md` 6절). */
/**
 * 문서에 스키마 버전을 찍는다 (`CLAUDE.md` 6절 "문서에 `schemaVersion` 포함").
 *
 * **편집기는 이 값을 만들지 않는다.** ProseMirror의 `toJSON()`은 type·attrs·content·marks·text만
 * 내보내므로, 화면이 넣어 주기를 기대하면 **아무 오류 없이 버전 없는 문서가 쌓인다.**
 * 그래서 **서버가 저장 직전에 찍는다** — 정본을 쓰는 쪽이 책임진다.
 */
export function stampSchemaVersion(doc: DocNode): DocNode {
  return { ...doc, attrs: { ...(doc.attrs ?? {}), schemaVersion: DOCUMENT_SCHEMA_VERSION } };
}

export function emptyDocument(): DocNode {
  return { type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content: [{ type: 'paragraph' }] };
}

/** 문서에 박힌 스키마 버전. 없으면 버전 표기 이전 문서다. */
export function documentSchemaVersion(doc: DocNode): number | null {
  const v = doc.attrs?.schemaVersion;
  return typeof v === 'number' ? v : null;
}
