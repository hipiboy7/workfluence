import { TableKit } from '@tiptap/extension-table';
import { EditorContent, useEditor, type Editor as TiptapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { ALLOWED_LINK_HREF, type DocNode } from '@workfluence/shared';
import { useEffect } from 'react';

/**
 * 편집기 확장 목록. 서버 허용 목록(packages/shared/src/document.ts)과 같아야 한다.
 * StarterKit(v3): 문단·제목·목록·코드블록·인용·구분선·줄바꿈 + bold/italic/strike/underline/code/link.
 * TableKit: table/tableRow/tableCell/tableHeader.
 */
export function editorExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
    }),
    TableKit.configure({ table: { resizable: false } }),
  ];
}

export function DocView({ content }: { content: DocNode }) {
  const editor = useEditor({ extensions: editorExtensions(), content, editable: false, immediatelyRender: true });
  useEffect(() => {
    if (editor && JSON.stringify(editor.getJSON()) !== JSON.stringify(content)) editor.commands.setContent(content);
  }, [editor, content]);
  return <EditorContent editor={editor} className="doc" />;
}

export function Editor({ content, onChange }: { content: DocNode; onChange: (doc: DocNode) => void }) {
  const editor = useEditor({
    extensions: editorExtensions(),
    content,
    immediatelyRender: true,
    onUpdate: ({ editor }) => onChange(editor.getJSON() as DocNode),
  });
  return (
    <div className="editor">
      {editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} className="doc editable" />
    </div>
  );
}

function Toolbar({ editor }: { editor: TiptapEditor }) {
  const btn = (label: string, run: () => void, active = false, title?: string) => (
    <button type="button" className={active ? 'on' : undefined} onMouseDown={(e) => e.preventDefault()} onClick={run} title={title ?? label}>
      {label}
    </button>
  );
  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const href = window.prompt('링크 주소 (http(s):// 또는 /내부경로)', prev ?? 'https://');
    if (href === null) return;
    if (!href.trim()) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    if (!ALLOWED_LINK_HREF.test(href.trim())) {
      window.alert('허용되지 않는 주소 형식이다. http(s)://, /경로, #앵커만 쓸 수 있다.');
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
  };
  return (
    <div className="toolbar" role="toolbar">
      {btn('B', () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'), '굵게')}
      {btn('I', () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'), '기울임')}
      {btn('U', () => editor.chain().focus().toggleUnderline().run(), editor.isActive('underline'), '밑줄')}
      {btn('S', () => editor.chain().focus().toggleStrike().run(), editor.isActive('strike'), '취소선')}
      {btn('<>', () => editor.chain().focus().toggleCode().run(), editor.isActive('code'), '인라인 코드')}
      <span className="sep" />
      {[1, 2, 3].map((level) =>
        btn(`H${level}`, () => editor.chain().focus().toggleHeading({ level: level as 1 | 2 | 3 }).run(), editor.isActive('heading', { level })),
      )}
      {btn('¶', () => editor.chain().focus().setParagraph().run(), editor.isActive('paragraph'), '본문')}
      <span className="sep" />
      {btn('• 목록', () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'))}
      {btn('1. 목록', () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'))}
      {btn('인용', () => editor.chain().focus().toggleBlockquote().run(), editor.isActive('blockquote'))}
      {btn('코드블록', () => editor.chain().focus().toggleCodeBlock().run(), editor.isActive('codeBlock'))}
      {btn('구분선', () => editor.chain().focus().setHorizontalRule().run())}
      {btn('링크', setLink, editor.isActive('link'))}
      <span className="sep" />
      {btn('표', () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), false, '3×3 표 삽입')}
      {editor.isActive('table') && (
        <>
          {btn('행+', () => editor.chain().focus().addRowAfter().run(), false, '아래에 행 추가')}
          {btn('열+', () => editor.chain().focus().addColumnAfter().run(), false, '오른쪽에 열 추가')}
          {btn('행−', () => editor.chain().focus().deleteRow().run(), false, '행 삭제')}
          {btn('열−', () => editor.chain().focus().deleteColumn().run(), false, '열 삭제')}
          {btn('표 삭제', () => editor.chain().focus().deleteTable().run())}
        </>
      )}
      <span className="sep" />
      {btn('↶', () => editor.chain().focus().undo().run(), false, '실행 취소')}
      {btn('↷', () => editor.chain().focus().redo().run(), false, '다시 실행')}
    </div>
  );
}
