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
 */
export function Editor({ value, onChange, editable = true }: { value: DocNode; onChange?: (doc: DocNode) => void; editable?: boolean }) {
  const editor = useEditor({
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

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  return <EditorContent className={editable ? 'editor' : 'editor readonly'} editor={editor} />;
}

/**
 * 빈 문서 — 새 페이지의 초기값.
 * **shared의 것을 쓴다.** 여기서 직접 만들면 `schemaVersion`이 엉뚱한 자리에 들어간다
 * (실제로 최상위 키로 넣었다가 서버가 못 읽는 상태로 저장됐다).
 */
export const EMPTY_DOC: DocNode = emptyDocument();
