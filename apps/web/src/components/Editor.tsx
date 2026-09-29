import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect } from 'react';
import { emptyDocument, type DocNode } from '@workfluence/shared';
import { editorExtensions } from './extensions';

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
/** 쓰는 칸이면 이름이 있는 여러 줄 입력란 — 읽기만 하는 본문에는 붙이지 않는다 */
const textboxAttributes = (editable: boolean, ariaLabel?: string, labelledBy?: string): Record<string, string> =>
  editable
    ? {
        role: 'textbox',
        'aria-multiline': 'true',
        ...(labelledBy ? { 'aria-labelledby': labelledBy } : ariaLabel ? { 'aria-label': ariaLabel } : {}),
      }
    : {};

export function Editor({
  value,
  onChange,
  editable = true,
  ariaLabel,
  labelledBy,
}: {
  value: DocNode;
  onChange?: (doc: DocNode) => void;
  editable?: boolean;
  /** 쓰는 칸의 이름 — "댓글 쓰기" */
  ariaLabel?: string;
  /** 쓰는 칸의 이름이 되는 **보이는 라벨**의 id — 편집 화면의 "본문" */
  labelledBy?: string;
}) {
  const editor = useEditor({
    editorProps: { attributes: textboxAttributes(editable, ariaLabel, labelledBy) },
    // 실시간 편집기와 **같은 목록**이다 — 서버 허용 목록과의 대조는 `extensions.spec.ts` (P9 D.7)
    extensions: editorExtensions(),
    content: value,
    editable,
    onUpdate: ({ editor: e }) => onChange?.(e.getJSON() as DocNode),
  });

  // 복원·다른 페이지로 이동 등 바깥에서 값이 바뀌면 따라간다
  useEffect(() => {
    if (editor && !editor.isFocused) editor.commands.setContent(value);
  }, [editor, value]);

  // 편집 가능 여부와 이름이 바뀌면 따라간다 — 댓글 칸은 **답하기**를 누르면 "답 쓰기"가 된다
  useEffect(() => {
    editor?.setEditable(editable);
    editor?.setOptions({ editorProps: { attributes: textboxAttributes(editable, ariaLabel, labelledBy) } });
  }, [editor, editable, ariaLabel, labelledBy]);

  return <EditorContent className={editable ? 'editor' : 'editor readonly'} editor={editor} />;
}

/**
 * 빈 문서 — 새 페이지의 초기값.
 * **shared의 것을 쓴다.** 여기서 직접 만들면 `schemaVersion`이 엉뚱한 자리에 들어간다
 * (실제로 최상위 키로 넣었다가 서버가 못 읽는 상태로 저장됐다).
 */
export const EMPTY_DOC: DocNode = emptyDocument();
