import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  BLOCK_CHOICES,
  COMPACT_TOOLBAR,
  FORMAT_ACTIONS,
  FULL_TOOLBAR,
  TABLE_TOOLBAR,
  applyLink,
  currentBlock,
  linkHrefAt,
  removeLink,
  setBlock,
  type BlockType,
  type FormatActionId,
} from './formatActions';
import {
  BulletListIcon,
  CodeBlockIcon,
  CodeIcon,
  FormatGlyph,
  LinkIcon,
  OrderedListIcon,
  QuoteIcon,
  RedoIcon,
  RuleIcon,
  TableIcon,
  UndoIcon,
} from './icons';
import { LinkDialog } from './LinkDialog';
import { useBarHeightVar } from './stickyBars';

/** 단추의 그림 — 표 안의 단추는 글로 보인다(그림으로는 "위에 행"과 "아래에 행"을 가리기 어렵다) */
const ICONS: Partial<Record<FormatActionId, ReactNode>> = {
  bold: <FormatGlyph kind="bold" />,
  italic: <FormatGlyph kind="italic" />,
  underline: <FormatGlyph kind="underline" />,
  strike: <FormatGlyph kind="strike" />,
  code: <CodeIcon />,
  bulletList: <BulletListIcon />,
  orderedList: <OrderedListIcon />,
  blockquote: <QuoteIcon />,
  codeBlock: <CodeBlockIcon />,
  horizontalRule: <RuleIcon />,
  link: <LinkIcon />,
  insertTable: <TableIcon />,
  undo: <UndoIcon />,
  redo: <RedoIcon />,
};

type Snapshot = { active: Partial<Record<FormatActionId, boolean>>; can: Partial<Record<FormatActionId, boolean>>; block: BlockType; inTable: boolean };
type Variant = 'full' | 'compact';

/** 그 줄에 있는 단추 — 표 무리는 따로(표 안일 때만 본다) */
const IDS: Record<Variant, readonly FormatActionId[]> = {
  full: FULL_TOOLBAR.flat().filter((id): id is FormatActionId => id !== 'block-type'),
  compact: COMPACT_TOOLBAR.flat().filter((id): id is FormatActionId => id !== 'block-type'),
};

/**
 * 편집기의 지금 상태 — 편집기가 바뀔 때마다 다시 뽑는다(`useEditorState`). **그 줄에 있는 단추만** 본다 — 실시간 편집에서는 남의 커서가 움직일 때마다
 * 돈다(병합 전 코드 리뷰 10 — 댓글의 짧은 줄도 스물한 개를 모두 보고 있었다)
 */
function snapshot(e: Editor | null, variant: Variant): Snapshot {
  const active: Snapshot['active'] = {};
  const can: Snapshot['can'] = {};
  if (!e) return { active, can, block: 'paragraph', inTable: false };
  const inTable = variant === 'full' && e.isActive('table');
  for (const id of inTable ? [...IDS[variant], ...TABLE_TOOLBAR] : IDS[variant]) {
    const a = FORMAT_ACTIONS[id];
    active[id] = a.active?.(e) ?? false;
    can[id] = e.isEditable && a.can(e);
  }
  return { active, can, block: variant === 'full' ? currentBlock(e) : 'paragraph', inTable };
}

/**
 * **서식 단추 줄** (P19_설계서_Recovery D.1, FR-2020~2025). `variant` — 편집 화면의 **전체 줄**(`full`) · 댓글 칸의 **짧은 줄**(`compact`). 단추 목록과
 * 판정·실행은 `formatActions.ts`(React 밖)가 들고, 여기는 그린다.
 *
 * - `role="toolbar"` — Tab 한 번으로 들어가고 ←·→·Home·End로 옮긴다(한 번에 하나만 Tab 자리, A.1-18). 쓸 수 없는 단추는 비활성이라 건너뛴다
 * - 단추는 누를 때 본문의 선택을 빼앗지 않는다(`mousedown`을 막는다) — 명령이 본문으로 초점을 돌린다
 * - 켜진 서식은 `aria-pressed`, 이름은 한국어, 단축키는 `title`·`aria-keyshortcuts`
 * - 표 안에 있으면 표 무리(행·열 더하기·지우기, 표 지우기)가 줄 끝에 붙는다
 * - **Ctrl+K** — 본문에서 누르면 링크 대화를 연다(편집기에는 그 단축키가 없다)
 */
export function FormatToolbar({ editor, variant }: { editor: Editor | null; variant: Variant }) {
  const state = useEditorState({ editor, selector: ({ editor: e }) => snapshot(e, variant) }) ?? snapshot(null, variant);
  const [linkOpen, setLinkOpen] = useState(false);
  const [focusAt, setFocusAt] = useState(0);
  const barRef = useRef<HTMLDivElement | null>(null);
  // 전체 줄은 창 위에 붙는다 — 그 높이를 편집 화면의 여백이 쓴다(표 안이면 두 줄로 접힌다, `stickyBars.ts`)
  const measure = useBarHeightVar('--format-bar-h', variant === 'full');
  const setBar = useCallback(
    (el: HTMLDivElement | null) => {
      barRef.current = el;
      measure(el);
    },
    [measure],
  );
  // 문단 형식 칸을 **키보드로** 바꾸는 중인가 — 그때는 초점을 본문으로 옮기지 않는다(아래 `blockSelect`)
  const selectByKey = useRef(false);
  const groups = variant === 'full' ? FULL_TOOLBAR : COMPACT_TOOLBAR;

  const openLink = useCallback(() => {
    if (editor?.isEditable && (FORMAT_ACTIONS.link.can(editor) || editor.isActive('link'))) setLinkOpen(true);
  }, [editor]);

  // 본문의 Ctrl+K — 링크 대화
  useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openLink();
      }
    };
    dom.addEventListener('keydown', onKey);
    return () => dom.removeEventListener('keydown', onKey);
  }, [editor, openLink]);

  /** 줄 안의 옮겨 갈 수 있는 것 — 쓸 수 있는 단추와 고르는 칸 */
  const items = () => [...(barRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)') ?? [])];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : null;
    // 고르는 칸 안의 ←·→는 칸의 것이 아니다 — 브라우저는 위·아래로 고른다
    if (to === null) return;
    e.preventDefault();
    const next = list[(to + list.length) % list.length];
    next.focus();
    setFocusAt(list.indexOf(next));
  };

  // 한 번에 하나만 Tab 자리 — 지금 자리(없어졌으면 첫 것)
  useEffect(() => {
    const list = items();
    list.forEach((el, i) => (el.tabIndex = i === Math.min(focusAt, list.length - 1) ? 0 : -1));
  });

  const button = (id: FormatActionId, withIcon: boolean) => {
    const a = FORMAT_ACTIONS[id];
    const icon = withIcon ? ICONS[id] : undefined;
    return (
      <button
        key={id}
        type="button"
        className={icon ? 'fmt-btn icon' : 'fmt-btn'}
        aria-label={a.label}
        title={a.shortcut ? `${a.label} (${a.shortcut})` : a.label}
        aria-keyshortcuts={a.keys}
        aria-pressed={a.toggle ? state.active[id] === true : undefined}
        disabled={!state.can[id]}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (!editor) return;
          if (id === 'link') openLink();
          else a.run(editor);
        }}
      >
        {icon ?? a.label}
      </button>
    );
  };

  const blockSelect = () => {
    const choices = [...BLOCK_CHOICES];
    // 4~6단계는 지금 그 단계일 때만 — `####`로 친 제목도 보인다(D.1)
    if (/^h[4-6]$/.test(state.block)) choices.push({ value: state.block, label: `제목 ${state.block.slice(1)}` });
    return (
      <select
        key="block-type"
        className="fmt-select"
        aria-label="문단 형식"
        title="문단 형식 (본문 Ctrl+Alt+0 · 제목 Ctrl+Alt+1~3)"
        value={state.block}
        disabled={!editor?.isEditable || state.block === 'other'}
        // **키보드로 고를 때는 초점을 옮기지 않는다**(병합 전 자체 점검 10) — Windows의 Chrome·Edge는 닫힌 칸에서 ↑↓가 곧바로 값을 바꾼다. 바뀔 때마다
        // 본문으로 가면 제목 2·3까지 내려갈 수 없다(WCAG 3.2.2). 마우스로 고르면 본문으로 돌아간다(A.1-18)
        onKeyDown={() => (selectByKey.current = true)}
        onPointerDown={() => (selectByKey.current = false)}
        onChange={(e) => editor && setBlock(editor, e.target.value as BlockType, { focus: !selectByKey.current })}
      >
        {state.block === 'other' && <option value="other">—</option>}
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    );
  };

  return (
    <>
      <div ref={setBar} className={`format-bar ${variant}`} role="toolbar" aria-label="서식" aria-orientation="horizontal" onKeyDown={onKeyDown}>
        {groups.map((g, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="fmt-sep" aria-hidden="true" />}
            <span className="fmt-group">{g.map((id) => (id === 'block-type' ? blockSelect() : button(id, true)))}</span>
          </Fragment>
        ))}
        {variant === 'full' && state.inTable && (
          <>
            <span className="fmt-sep" aria-hidden="true" />
            <span className="fmt-group table" role="group" aria-label="표">
              {TABLE_TOOLBAR.map((id) => button(id, false))}
            </span>
          </>
        )}
      </div>
      {linkOpen && editor && (
        <LinkDialog
          initial={linkHrefAt(editor) ?? ''}
          canRemove={editor.isActive('link')}
          onSubmit={(href) => applyLink(editor, href)}
          onRemove={() => removeLink(editor)}
          onClose={() => {
            setLinkOpen(false);
            editor.commands.focus();
          }}
        />
      )}
    </>
  );
}
