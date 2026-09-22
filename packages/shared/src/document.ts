import { DOCUMENT_SCHEMA_VERSION } from './constants';

/**
 * 페이지 본문(ProseMirror/TipTap JSON) 검증·텍스트 추출 (CLAUDE.md 6절·7절).
 *
 * 서버는 HTML을 받지 않고 이 JSON만 받는다. 허용 목록 밖의 노드·마크·속성은 거부한다.
 * 편집기(apps/web)의 확장 목록과 이 허용 목록은 같아야 한다 — 어긋나면 편집기가 만든 문서가 400으로 거부된다.
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
  paragraph: ['textAlign'],
  heading: ['level', 'textAlign'],
  text: [],
  bulletList: [],
  orderedList: ['start', 'type'],
  listItem: [],
  taskList: [],
  taskItem: ['checked'],
  codeBlock: ['language'],
  blockquote: [],
  horizontalRule: [],
  hardBreak: [],
  table: [],
  tableRow: [],
  tableCell: ['colspan', 'rowspan', 'colwidth'],
  tableHeader: ['colspan', 'rowspan', 'colwidth'],
};

/** 허용 마크와 속성 키 */
export const ALLOWED_MARKS: Record<string, readonly string[]> = {
  bold: [],
  italic: [],
  strike: [],
  underline: [],
  code: [],
  link: ['href', 'target', 'rel', 'class'],
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
    if (typeof type !== 'string' || !(type in ALLOWED_NODES)) {
      errors.push(`${path}: 허용되지 않는 노드 '${String(type)}'`);
      return;
    }
    checkAttrs(node.attrs, ALLOWED_NODES[type], `${path}(${type})`, errors);

    if (type === 'heading') {
      const level = (node.attrs as Record<string, unknown> | undefined)?.level;
      if (typeof level !== 'number' || level < 1 || level > 6) errors.push(`${path}: heading.level은 1~6`);
    }
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
        node.content.forEach((child, i) => visit(child, `${path}.content[${i}]`, depth + 1));
      }
    }
  };

  if (!isRecord(input) || input.type !== 'doc') {
    return { ok: false, errors: ['최상위 노드는 type: "doc"이어야 한다'] };
  }
  visit(input, 'doc', 0);
  return errors.length ? { ok: false, errors } : { ok: true };
}

function checkMark(mark: unknown, path: string, errors: string[]): void {
  if (!isRecord(mark) || typeof mark.type !== 'string' || !(mark.type in ALLOWED_MARKS)) {
    errors.push(`${path}: 허용되지 않는 마크 '${isRecord(mark) ? String(mark.type) : typeof mark}'`);
    return;
  }
  checkAttrs(mark.attrs, ALLOWED_MARKS[mark.type], path, errors);
  if (mark.type === 'link') {
    const href = (mark.attrs as Record<string, unknown> | undefined)?.href;
    if (typeof href !== 'string' || !ALLOWED_LINK_HREF.test(href.trim())) {
      errors.push(`${path}: 허용되지 않는 링크 주소 '${String(href)}'`);
    }
  }
}

function checkAttrs(attrs: unknown, allowed: readonly string[], path: string, errors: string[]): void {
  if (attrs === undefined || attrs === null) return;
  if (!isRecord(attrs)) {
    errors.push(`${path}: attrs는 객체`);
    return;
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
    if (!allowed.includes(key)) errors.push(`${path}: 허용되지 않는 속성 '${key}'`);
    if (!isPrimitiveOrPrimitiveArray(value)) errors.push(`${path}: 속성 '${key}' 값은 원시값 또는 원시값 배열`);
  }
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

const BLOCK_NODES = new Set([
  'paragraph',
  'heading',
  'listItem',
  'taskItem',
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
