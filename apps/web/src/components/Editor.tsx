import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect } from 'react';
import { emptyDocument, type DocNode } from '@workfluence/shared';
import { editorExtensions } from './extensions';
import { FormatToolbar } from './FormatToolbar';

/**
 * 본문 편집기 (FR-342).
 *
 * **서버는 ProseMirror JSON만 받는다** (CLAUDE.md 0.2절). HTML을 주고받지 않으므로
 * 화면에서 HTML을 만들 일도, 서버에서 HTML을 걸러낼 일도 없다 — 주고받는 값의 모양이
 * 하나뿐이면 검증도 한 곳에서 끝난다.
 *
 * 쓰는 칸은 **입력란으로 보이고 이름이 있다**(P17 F-010 4·5번) — `role="textbox"`와 `ariaLabel`, 모양은 `styles.css`의 `.editor`. 처음 판은 모양이
 * 없어 빈 칸이 한 줄 높이의 보이지 않는 띠였다 — 댓글을 쓸 수 없었다(T-077)
 *
 * 화면에 **보이는 라벨**이 있으면 `labelledBy`로 그 요소를 가리킨다(P17 J.7) — `label htmlFor`는 입력 요소만 가리킬 수 있어 편집기의 `div`를
 * 가리키면 이름이 붙지 않았다(편집 화면의 "본문"). 둘 다 주면 `labelledBy`가 이긴다 — 보이는 글과 읽히는 이름이 어긋나지 않게
 */
/** 커서를 창 안에 둘 때 창 가장자리에서 띄우는 거리(px) — ProseMirror의 `scrollMargin`·`scrollThreshold` */
export type ScrollMargin = { top: number; right: number; bottom: number; left: number };

/**
 * 편집 화면의 여백 (P17 병합 전 검토 17) — 창 위를 붙어 있는 막대들(위 막대 48px `--topbar-h` + 편집 줄 48px `.edit-bar` + 서식 단추 줄 44px
 * `.format-bar` — P19 A.1-17, `styles.css`)이 가린다. 편집기는 기본으로 창 맨 위에서 5px만 띄워 판정해, 막대 뒤에 숨은 커서를 "보인다"고 보고
 * 스크롤하지 않았다. 막대 셋에 16px을 더한다
 */
export const EDIT_SCROLL_MARGIN: ScrollMargin = { top: 156, right: 0, bottom: 16, left: 0 };

/** 쓰는 칸이면 이름이 있는 여러 줄 입력란 — 읽기만 하는 본문에는 붙이지 않는다 */
const textboxAttributes = (editable: boolean, ariaLabel?: string, labelledBy?: string): Record<string, string> =>
  editable
    ? {
        role: 'textbox',
        'aria-multiline': 'true',
        ...(labelledBy ? { 'aria-labelledby': labelledBy } : ariaLabel ? { 'aria-label': ariaLabel } : {}),
      }
    : {};

/** 바깥 값을 따라가는 변경의 표시 — 편집기가 알리는 변경 가운데 사람이 고친 것만 `onEdit`으로 가린다 */
const SYNC_META = 'wf:sync';

/** 편집기의 속성 — 만들 때와 바뀔 때(`setOptions`는 `editorProps`를 통째로 갈아 끼운다) 같은 모양이어야 여백이 빠지지 않는다 */
const propsOf = (editable: boolean, ariaLabel?: string, labelledBy?: string, scrollMargin?: ScrollMargin) => ({
  attributes: textboxAttributes(editable, ariaLabel, labelledBy),
  ...(scrollMargin ? { scrollMargin, scrollThreshold: scrollMargin } : {}),
});

export function Editor({
  value,
  onChange,
  editable = true,
  ariaLabel,
  labelledBy,
  scrollMargin,
  onEdit,
  toolbar,
}: {
  value: DocNode;
  onChange?: (doc: DocNode) => void;
  /**
   * **사람이 본문을 고쳤을 때만** 부른다 (P17 병합 전 검토 18). `onChange`는 처음 그릴 때와 바깥 값을 따라갈 때도 불린다(편집기가 다듬은 값을
   * 알린다) — 그것으로는 저장하지 않은 편집이 있는지 가릴 수 없다
   */
  onEdit?: () => void;
  editable?: boolean;
  /** 쓰는 칸의 이름 — "댓글 쓰기" */
  ariaLabel?: string;
  /** 쓰는 칸의 이름이 되는 **보이는 라벨**의 id — 편집 화면의 "본문" */
  labelledBy?: string;
  /** 창 위·아래를 가리는 막대가 있으면 그만큼 띄워 커서를 보이게 한다 — 편집 화면의 `EDIT_SCROLL_MARGIN` */
  scrollMargin?: ScrollMargin;
  /** 서식 단추 줄 — 편집 화면은 전체 줄, 댓글 칸은 짧은 줄(P19 FR-2020·2021). 쓰는 칸일 때만 그린다(FR-2027) */
  toolbar?: 'full' | 'compact';
}) {
  const editor = useEditor({
    editorProps: propsOf(editable, ariaLabel, labelledBy, scrollMargin),
    // 실시간 편집기와 **같은 목록**이다 — 서버 허용 목록과의 대조는 `extensions.spec.ts` (P9 D.7)
    extensions: editorExtensions(),
    content: value,
    editable,
    onUpdate: ({ editor: e, transaction }) => {
      onChange?.(e.getJSON() as DocNode);
      // 문서가 바뀌지 않은 알림(편집 가능 여부를 바꿀 때)과 바깥 값을 따라간 변경은 고친 것이 아니다
      if (transaction.docChanged && !transaction.getMeta(SYNC_META)) onEdit?.();
    },
  });

  // 복원·다른 페이지로 이동 등 바깥에서 값이 바뀌면 따라간다 — 사람이 고친 것이 아니라고 표시한다
  useEffect(() => {
    if (editor && !editor.isFocused) editor.chain().setMeta(SYNC_META, true).setContent(value).run();
  }, [editor, value]);

  // 편집 가능 여부와 이름이 바뀌면 따라간다 — 댓글 칸은 **답하기**를 누르면 "답 쓰기"가 된다
  useEffect(() => {
    editor?.setEditable(editable);
    editor?.setOptions({ editorProps: propsOf(editable, ariaLabel, labelledBy, scrollMargin) });
  }, [editor, editable, ariaLabel, labelledBy, scrollMargin]);

  return (
    <>
      {editable && toolbar && <FormatToolbar editor={editor} variant={toolbar} />}
      <EditorContent className={editable ? 'editor' : 'editor readonly'} editor={editor} />
    </>
  );
}

/**
 * 빈 문서 — 새 페이지의 초기값.
 * **shared의 것을 쓴다.** 여기서 직접 만들면 `schemaVersion`이 엉뚱한 자리에 들어간다
 * (실제로 최상위 키로 넣었다가 서버가 못 읽는 상태로 저장됐다).
 */
export const EMPTY_DOC: DocNode = emptyDocument();
