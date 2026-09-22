import { ALLOWED_LINK_HREF, ALLOWED_MARKS, ALLOWED_NODES, type DocMark, type DocNode } from './document';

/**
 * 문서 JSON을 HTML로 그린다 (A등급, P6_설계서_Collab FR-730~737).
 *
 * **내보낸 파일은 앱 밖에서 열린다.** 우리 CSP도, 우리 nginx 헤더도 닿지 않는 곳이다.
 * 그래서 이 파일의 규칙은 화면 렌더와 다르다 — 의심스러운 것은 **빼는 쪽**으로 간다.
 *
 * 허용 목록은 `document.ts`의 것을 **그대로 쓴다** (FR-732). 목록이 두 벌이면 한쪽이
 * 상하고, 그러면 "저장은 되는데 내보내면 사라지는 노드"가 생긴다 (1.3절).
 */

/** 노드 종류 → 태그. 여기 없는 허용 노드는 감싸지 않고 자식만 그린다 */
const TAGS: Record<string, string> = {
  paragraph: 'p',
  blockquote: 'blockquote',
  bulletList: 'ul',
  orderedList: 'ol',
  listItem: 'li',
  taskList: 'ul',
  taskItem: 'li',
  codeBlock: 'pre',
  table: 'table',
  tableRow: 'tr',
  tableCell: 'td',
  tableHeader: 'th',
};

const MARK_TAGS: Record<string, string> = {
  bold: 'strong',
  italic: 'em',
  strike: 's',
  underline: 'u',
  code: 'code',
};

/** 다섯 문자를 전부 바꾼다. 작은따옴표까지 넣는 것은 속성을 홑따옴표로 쓰는 코드가 생겨도 안전하게 하려는 것이다 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 그 노드에 허용된 속성만, 값을 이스케이프해서 */
function attrsOf(node: DocNode): string {
  const allowed = ALLOWED_NODES[node.type];
  if (!allowed?.length || !node.attrs) return '';
  const out: string[] = [];
  for (const key of allowed) {
    const v = node.attrs[key];
    // 구조를 위한 값이 아니라 **편집기 내부 상태**인 것은 내보내지 않는다
    if (v === undefined || v === null || key === 'schemaVersion' || key === 'colwidth') continue;
    out.push(`${key}="${escapeHtml(String(v))}"`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

/**
 * 마크를 안쪽부터 감싼다.
 *
 * **허용 목록 밖의 마크는 무시하되 글자는 남긴다.** 마크는 꾸밈이라 없어도 뜻이 통하지만,
 * 노드는 구조라서 통째로 빼는 것이 맞다 — 둘의 판단이 다른 이유다.
 */
function wrapMarks(text: string, marks: DocMark[] | undefined): string {
  let out = text;
  for (const mark of marks ?? []) {
    if (!(mark.type in ALLOWED_MARKS)) continue;
    if (mark.type === 'link') {
      const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '';
      // 통과하지 못하면 **링크로 만들지 않는다.** 글자는 남는다 (FR-734)
      if (!ALLOWED_LINK_HREF.test(href)) continue;
      // `rel`을 강제로 붙인다 — 내보낸 파일은 우리 헤더가 닿지 않는 곳에서 열린다
      out = `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${out}</a>`;
      continue;
    }
    const tag = MARK_TAGS[mark.type];
    if (tag) out = `<${tag}>${out}</${tag}>`;
  }
  return out;
}

function renderNode(node: DocNode): string {
  // **허용 목록 밖은 통째로 뺀다** (FR-732). 자식도 그리지 않는다
  if (!(node.type in ALLOWED_NODES)) return '';

  if (node.type === 'text') return wrapMarks(escapeHtml(node.text ?? ''), node.marks);
  if (node.type === 'hardBreak') return '<br />';
  if (node.type === 'horizontalRule') return '<hr />';

  const inner = (node.content ?? []).map(renderNode).join('');
  if (node.type === 'heading') {
    const level = Number(node.attrs?.level ?? 1);
    const h = level >= 1 && level <= 6 ? level : 1;
    return `<h${h}>${inner}</h${h}>`;
  }
  const tag = TAGS[node.type];
  if (!tag) return inner;
  return `<${tag}${attrsOf(node)}>${inner}</${tag}>`;
}

/** 문서 본문만. 감싸는 것 없이 블록들만 그린다 */
export function renderDocHtml(doc: DocNode): string {
  return (doc.content ?? []).map(renderNode).join('');
}

/**
 * 인쇄용 CSS. **외부 자원을 하나도 참조하지 않는다** (FR-735).
 *
 * 글꼴을 지정하지 않는 것은 일부러다 — 폰트 파일을 참조하면 그것이 외부 자원이 되고,
 * 인라인으로 넣으면 파일이 수 MB가 된다. 시스템 기본 글꼴이면 인쇄 결과가 충분하다.
 */
const PRINT_CSS = `
:root { color-scheme: light }
body { margin: 2rem auto; max-width: 48rem; line-height: 1.7; color: #111 }
h1, h2, h3, h4 { line-height: 1.3; margin: 1.6em 0 .6em }
p, li { margin: .5em 0 }
pre { background: #f4f4f5; padding: .8em; overflow-x: auto; white-space: pre-wrap }
code { background: #f4f4f5; padding: .1em .3em }
blockquote { border-left: 3px solid #d4d4d8; margin: 1em 0; padding-left: 1em; color: #52525b }
table { border-collapse: collapse; width: 100% }
th, td { border: 1px solid #d4d4d8; padding: .4em .6em; text-align: left }
hr { border: 0; border-top: 1px solid #d4d4d8; margin: 2em 0 }
a { color: #1d4ed8 }
.wf-meta { color: #71717a; font-size: .85em; border-bottom: 1px solid #e4e4e7; padding-bottom: .8em; margin-bottom: 1.6em }
@media print {
  body { margin: 0; max-width: none }
  .wf-meta { border-bottom-color: #999 }
  /* 종이에서는 링크 주소가 안 보이므로 옆에 적는다 */
  a[href^="http"]::after { content: " (" attr(href) ")"; font-size: .85em; color: #555 }
  h1, h2, h3, h4 { break-after: avoid }
  table, pre, blockquote { break-inside: avoid }
}
`.trim();

export type ExportInput = {
  title: string;
  doc: DocNode;
  exportedAt: string;
  /** 어느 스페이스의 문서인지. 없으면 적지 않는다 */
  spaceName?: string;
  /** 어느 버전인지. 없으면 적지 않는다 */
  versionNo?: number;
};

/** 스스로 완결된 HTML 한 파일 (FR-730). 브라우저의 "인쇄 → PDF로 저장"이 PDF를 대신한다 */
export function renderExportDocument(input: ExportInput): string {
  const meta = [
    input.spaceName ? `공간: ${escapeHtml(input.spaceName)}` : '',
    input.versionNo !== undefined ? `버전 ${input.versionNo}` : '',
    `내보낸 시각: ${escapeHtml(input.exportedAt)}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return [
    '<!doctype html>',
    '<html lang="ko">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(input.title)}</title>`,
    `<style>${PRINT_CSS}</style>`,
    '</head>',
    '<body>',
    `<h1>${escapeHtml(input.title)}</h1>`,
    `<p class="wf-meta">${meta}</p>`,
    renderDocHtml(input.doc),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
