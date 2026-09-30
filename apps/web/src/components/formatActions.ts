import type { Editor } from '@tiptap/core';
import { linkAllowed } from './extensions';

/**
 * 서식 단추 줄의 **단추 목록과 판정·실행** (P19_설계서_Recovery D.1, FR-2020~2024). React 밖에 둔다 — 편집기(TipTap)를 직접 만들어 시험한다(3절 — 상태 기계는
 * React 밖). 줄(`FormatToolbar.tsx`)은 이것을 그린다.
 *
 * **단추는 편집기 명령을 부를 뿐이다** — 새 노드·속성·마크를 만들지 않는다. 편집기 스키마와 허용 목록이 같다는 것은 대조 시험(`extensions.spec.ts`)이
 * 증명하고, 명령은 스키마를 어기는 문서를 만들 수 없다(D.3). 표 한계를 넘게 만드는 표 명령은 편집기의 거르기(`BoundedTableValues`)가 하지 않는다.
 * 단축키는 편집기가 이미 가진 것이다 — 링크(Ctrl+K)만 줄이 둔다(대화를 연다).
 */

export type FormatActionId =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'bulletList'
  | 'orderedList'
  | 'blockquote'
  | 'codeBlock'
  | 'horizontalRule'
  | 'link'
  | 'insertTable'
  | 'addRowBefore'
  | 'addRowAfter'
  | 'addColumnBefore'
  | 'addColumnAfter'
  | 'deleteRow'
  | 'deleteColumn'
  | 'deleteTable'
  | 'undo'
  | 'redo';

export type FormatAction = {
  id: FormatActionId;
  /** 단추의 이름 — 보조기기가 읽고 시험이 찾는다 */
  label: string;
  /** 보이는 단축키 글 — `title`에 붙인다 */
  shortcut?: string;
  /** `aria-keyshortcuts` 값 */
  keys?: string;
  /** 눌림이 있는 단추인가(글자 서식·목록·블록) — `aria-pressed` */
  toggle: boolean;
  /** 지금 켜져 있는가 */
  active?: (e: Editor) => boolean;
  /** 지금 누를 수 있는가 — 편집기가 그 명령을 할 수 있는가 */
  can: (e: Editor) => boolean;
  /** 누른다. 초점은 본문으로 돌아간다(`focus()`). 링크는 줄이 대화를 연다 — 여기서는 하지 않는다 */
  run: (e: Editor) => void;
};

const TABLE = { rows: 3, cols: 3, withHeaderRow: true } as const;

/**
 * 링크를 걸 수 있는 자리인지 물을 때 쓰는 주소 — 판정용이다. 편집기는 이 주소로 링크를 만들지 않고 **그 자리의 스키마**(링크를 받는 노드인가)만 본다.
 * 허용되는 주소여야 명령이 주소 때문에 거절하지 않는다(병합 전 자체 점검 11 — 이름 없는 주소 글자를 두지 않는다)
 */
const LINK_PROBE_HREF = 'https://example.internal';

export const FORMAT_ACTIONS: Readonly<Record<FormatActionId, FormatAction>> = {
  bold: { id: 'bold', label: '굵게', shortcut: 'Ctrl+B', keys: 'Control+B', toggle: true, active: (e) => e.isActive('bold'), can: (e) => e.can().toggleBold(), run: (e) => e.chain().focus().toggleBold().run() },
  italic: {
    id: 'italic',
    label: '기울임',
    shortcut: 'Ctrl+I',
    keys: 'Control+I',
    toggle: true,
    active: (e) => e.isActive('italic'),
    can: (e) => e.can().toggleItalic(),
    run: (e) => e.chain().focus().toggleItalic().run(),
  },
  underline: {
    id: 'underline',
    label: '밑줄',
    shortcut: 'Ctrl+U',
    keys: 'Control+U',
    toggle: true,
    active: (e) => e.isActive('underline'),
    can: (e) => e.can().toggleUnderline(),
    run: (e) => e.chain().focus().toggleUnderline().run(),
  },
  strike: {
    id: 'strike',
    label: '취소선',
    shortcut: 'Ctrl+Shift+S',
    keys: 'Control+Shift+S',
    toggle: true,
    active: (e) => e.isActive('strike'),
    can: (e) => e.can().toggleStrike(),
    run: (e) => e.chain().focus().toggleStrike().run(),
  },
  code: { id: 'code', label: '코드', shortcut: 'Ctrl+E', keys: 'Control+E', toggle: true, active: (e) => e.isActive('code'), can: (e) => e.can().toggleCode(), run: (e) => e.chain().focus().toggleCode().run() },
  bulletList: {
    id: 'bulletList',
    label: '글머리 목록',
    shortcut: 'Ctrl+Shift+8',
    keys: 'Control+Shift+8',
    toggle: true,
    active: (e) => e.isActive('bulletList'),
    can: (e) => e.can().toggleBulletList(),
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  orderedList: {
    id: 'orderedList',
    label: '번호 목록',
    shortcut: 'Ctrl+Shift+7',
    keys: 'Control+Shift+7',
    toggle: true,
    active: (e) => e.isActive('orderedList'),
    can: (e) => e.can().toggleOrderedList(),
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  blockquote: {
    id: 'blockquote',
    label: '인용',
    shortcut: 'Ctrl+Shift+B',
    keys: 'Control+Shift+B',
    toggle: true,
    active: (e) => e.isActive('blockquote'),
    can: (e) => e.can().toggleBlockquote(),
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  codeBlock: {
    id: 'codeBlock',
    label: '코드 블록',
    shortcut: 'Ctrl+Alt+C',
    keys: 'Control+Alt+C',
    toggle: true,
    active: (e) => e.isActive('codeBlock'),
    can: (e) => e.can().toggleCodeBlock(),
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
  horizontalRule: { id: 'horizontalRule', label: '구분선', toggle: false, can: (e) => e.can().setHorizontalRule(), run: (e) => e.chain().focus().setHorizontalRule().run() },
  link: {
    id: 'link',
    label: '링크',
    shortcut: 'Ctrl+K',
    keys: 'Control+K',
    toggle: true,
    active: (e) => e.isActive('link'),
    // 코드 안(인라인 코드·코드 블록)에는 링크를 걸 수 없다 — 스키마가 막는다(`MARKS_IN`)
    can: (e) => e.isActive('link') || e.can().setLink({ href: LINK_PROBE_HREF }),
    run: () => undefined,
  },
  insertTable: { id: 'insertTable', label: '표 넣기', toggle: false, can: (e) => !e.isActive('table') && e.can().insertTable(TABLE), run: (e) => e.chain().focus().insertTable(TABLE).run() },
  addRowBefore: { id: 'addRowBefore', label: '위에 행', toggle: false, can: (e) => e.can().addRowBefore(), run: (e) => e.chain().focus().addRowBefore().run() },
  addRowAfter: { id: 'addRowAfter', label: '아래에 행', toggle: false, can: (e) => e.can().addRowAfter(), run: (e) => e.chain().focus().addRowAfter().run() },
  addColumnBefore: { id: 'addColumnBefore', label: '왼쪽에 열', toggle: false, can: (e) => e.can().addColumnBefore(), run: (e) => e.chain().focus().addColumnBefore().run() },
  addColumnAfter: { id: 'addColumnAfter', label: '오른쪽에 열', toggle: false, can: (e) => e.can().addColumnAfter(), run: (e) => e.chain().focus().addColumnAfter().run() },
  deleteRow: { id: 'deleteRow', label: '행 지우기', toggle: false, can: (e) => e.can().deleteRow(), run: (e) => e.chain().focus().deleteRow().run() },
  deleteColumn: { id: 'deleteColumn', label: '열 지우기', toggle: false, can: (e) => e.can().deleteColumn(), run: (e) => e.chain().focus().deleteColumn().run() },
  deleteTable: { id: 'deleteTable', label: '표 지우기', toggle: false, can: (e) => e.can().deleteTable(), run: (e) => e.chain().focus().deleteTable().run() },
  // 실시간 편집이면 Yjs의 되돌리기(내 편집만)다 — 편집기의 이력은 꺼져 있고 같은 이름의 명령을 협업 확장이 준다(P9 D.7, A.1-20)
  undo: { id: 'undo', label: '되돌리기', shortcut: 'Ctrl+Z', keys: 'Control+Z', toggle: false, can: (e) => e.can().undo(), run: (e) => e.chain().focus().undo().run() },
  redo: { id: 'redo', label: '다시', shortcut: 'Ctrl+Y', keys: 'Control+Y', toggle: false, can: (e) => e.can().redo(), run: (e) => e.chain().focus().redo().run() },
};

/** 줄의 무리 — 무리 사이에 구분선을 그린다. `'block-type'`은 문단 형식을 고르는 칸의 자리다 */
export type ToolbarGroup = readonly (FormatActionId | 'block-type')[];

/** 전체 줄 — 편집 화면 (FR-2020, 착수 쟁점 4) */
export const FULL_TOOLBAR: readonly ToolbarGroup[] = [
  ['block-type'],
  ['bold', 'italic', 'underline', 'strike', 'code'],
  ['bulletList', 'orderedList'],
  ['blockquote', 'codeBlock', 'horizontalRule'],
  ['link', 'insertTable'],
  ['undo', 'redo'],
];

/** 짧은 줄 — 댓글 칸 (FR-2021, 착수 쟁점 3 "굵게·기울임·목록·링크·코드") */
export const COMPACT_TOOLBAR: readonly ToolbarGroup[] = [['bold', 'italic', 'code'], ['bulletList', 'orderedList'], ['link']];

/** 표 안에 있을 때만 보이는 무리 (FR-2024) — 칸 합치기·나누기는 두지 않는다(착수 쟁점 4) */
export const TABLE_TOOLBAR: readonly FormatActionId[] = ['addRowBefore', 'addRowAfter', 'addColumnBefore', 'addColumnAfter', 'deleteRow', 'deleteColumn', 'deleteTable'];

// ---- 문단 형식 ----

/** 고르는 칸의 값 — 본문·제목 단계. 제목·본문이 아닌 블록(코드 블록 등) 안이면 `other` */
export type BlockType = 'paragraph' | `h${1 | 2 | 3 | 4 | 5 | 6}` | 'other';

/** 늘 보이는 선택지 — 제목은 1~3까지(D.1). 4~6은 지금 그 단계일 때만 더한다 */
export const BLOCK_CHOICES: readonly { value: BlockType; label: string }[] = [
  { value: 'paragraph', label: '본문' },
  { value: 'h1', label: '제목 1' },
  { value: 'h2', label: '제목 2' },
  { value: 'h3', label: '제목 3' },
];

export function currentBlock(e: Editor): BlockType {
  for (const level of [1, 2, 3, 4, 5, 6] as const) if (e.isActive('heading', { level })) return `h${level}`;
  if (e.isActive('codeBlock')) return 'other';
  return e.isActive('paragraph') ? 'paragraph' : 'other';
}

/**
 * 그 블록으로 바꾼다. **목록 항목 안에서 제목을 고르면 그 줄이 목록 밖으로 나온다** — 편집기가 막는 것이 아니라 꺼낸다(`setHeading`이 `clearNodes`로 목록을
 * 푼다). 목록 항목의 첫 줄은 문단이어야 해서다(P12 `FIRST_CHILD`, 사용자 가이드 4.1절). `focus: false`면 초점을 본문으로 옮기지 않는다(키보드로 고르는 칸)
 */
export function setBlock(e: Editor, value: BlockType, { focus = true }: { focus?: boolean } = {}): boolean {
  if (value === 'other') return false;
  const chain = focus ? e.chain().focus() : e.chain();
  if (value === 'paragraph') return chain.setParagraph().run();
  const level = Number(value.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6;
  return chain.setHeading({ level }).run();
}

// ---- 링크 (D.2) ----

/** 지금 커서가 있는 링크의 주소 — 링크 위가 아니면 `null` */
export function linkHrefAt(e: Editor): string | null {
  if (!e.isActive('link')) return null;
  const href = e.getAttributes('link').href as unknown;
  return typeof href === 'string' ? href : null;
}

/** 링크가 되지 않는 주소일 때의 까닭 — 서버·편집기와 같은 판정이다(`linkAllowed`, 7절 — 앵커 `#…`도 받는다, 병합 전 자체 점검 11) */
export const LINK_NOT_ALLOWED = 'http(s)로 시작하는 주소, /로 시작하는 위키 안 주소, #으로 시작하는 문서 안 자리만 링크가 된다';

/**
 * 링크를 건다 — 주소는 앞뒤 빈칸을 떼고 `linkAllowed`로 본다. 안 되면 까닭(`LINK_NOT_ALLOWED`)을 돌려주고 아무것도 하지 않는다.
 * 링크 위면 그 링크 전체의 주소를 바꾸고, 고른 글이 있으면 그 글에 걸고, 없으면 주소를 글로 넣고 건다
 */
export function applyLink(e: Editor, raw: string): string | null {
  const href = raw.trim();
  if (!href || !linkAllowed(href)) return LINK_NOT_ALLOWED;
  if (e.isActive('link')) {
    e.chain().focus().extendMarkRange('link').setLink({ href }).run();
  } else if (e.state.selection.empty) {
    // 넣은 뒤 **이어 치는 글은 링크가 아니다** — 링크 마크는 끝에서 이어진다(inclusive). 빼지 않으면 "주소 를 보라"가 한 링크가 되고, 링크 빼기가 주소의
    // 링크까지 뺐다(병합 전 코드 리뷰 추가 1)
    e.chain().focus().insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).unsetMark('link').run();
  } else {
    e.chain().focus().setLink({ href }).run();
  }
  return null;
}

/** 링크를 뺀다 — 커서가 있는 링크 전체 */
export function removeLink(e: Editor): void {
  e.chain().focus().extendMarkRange('link').unsetLink().run();
}
