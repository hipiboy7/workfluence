// @vitest-environment happy-dom
import { emptyDocument, type DocNode } from '@workfluence/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TextSelection } from '@tiptap/pm/state';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDIT_SCROLL_MARGIN, Editor } from './Editor';

/** TipTap은 편집기 DOM에 자기 인스턴스를 붙여 둔다 — 시험이 편집기의 속성과 명령에 닿는 길 */
type TiptapBox = HTMLElement & {
  editor: { view: { someProp: (name: string) => unknown }; commands: { insertContent: (text: string) => boolean } };
};

/** 컴포넌트 시험 — 쓰는 칸은 이름이 있는 입력란이다(P17 F-010 4·5번, T-077 · J.7). 읽기만 하는 본문은 입력란이 아니다 */
afterEach(cleanup);

describe('Editor', () => {
  it('**쓰는 칸은 이름이 있는 입력란이다** — "댓글 쓰기"로 찾는다', async () => {
    render(<Editor value={emptyDocument()} ariaLabel="댓글 쓰기" />);
    const box = await screen.findByRole('textbox', { name: '댓글 쓰기' });
    expect(box.getAttribute('contenteditable')).toBe('true');
    expect(box.getAttribute('aria-multiline')).toBe('true');
  });

  it('**보이는 라벨을 가리키면 그 글이 이름이다** — 편집 화면의 "본문"(label htmlFor는 편집기의 div를 가리킬 수 없다 — P17 J.7)', async () => {
    render(
      <>
        <label id="body-label">본문</label>
        <Editor value={emptyDocument()} labelledBy="body-label" ariaLabel="쓰이지 않는 이름" />
      </>,
    );
    const box = await screen.findByRole('textbox', { name: '본문' });
    expect(box.getAttribute('aria-labelledby')).toBe('body-label');
    // 둘 다 주면 보이는 라벨이 이긴다 — 보이는 글과 읽히는 이름이 어긋나지 않게
    expect(box.hasAttribute('aria-label')).toBe(false);
  });

  it('**편집 화면의 여백을 편집기가 쓴다** — 이름이 바뀌어 속성을 다시 넣어도 빠지지 않는다 (병합 전 검토 17)', async () => {
    const { rerender } = render(<Editor value={emptyDocument()} ariaLabel="본문" scrollMargin={EDIT_SCROLL_MARGIN} />);
    const box = (await screen.findByRole('textbox', { name: '본문' })) as TiptapBox;
    expect(box.editor.view.someProp('scrollMargin')).toEqual({ top: 156, right: 0, bottom: 16, left: 0 });
    expect(box.editor.view.someProp('scrollThreshold')).toEqual(EDIT_SCROLL_MARGIN);
    rerender(<Editor value={emptyDocument()} ariaLabel="다른 이름" scrollMargin={EDIT_SCROLL_MARGIN} />);
    const again = (await screen.findByRole('textbox', { name: '다른 이름' })) as TiptapBox;
    expect(again.editor.view.someProp('scrollMargin')).toEqual(EDIT_SCROLL_MARGIN);
  });

  it('**막대가 두 줄로 접히면 여백도 커진다** — 편집기는 막대들의 지금 높이를 읽는다(병합 전 자체 점검 2 · P17 J.12-16)', () => {
    const bars = (['topbar', 'edit-bar', 'format-bar full'] as const).map((cls, i) => {
      const el = document.createElement('div');
      el.className = cls;
      Object.defineProperty(el, 'offsetHeight', { value: [48, 96, 78][i] });
      document.body.appendChild(el);
      return el;
    });
    try {
      expect(EDIT_SCROLL_MARGIN.top).toBe(48 + 96 + 78 + 16);
    } finally {
      for (const el of bars) el.remove();
    }
    // 그려지지 않았으면 한 줄씩으로 친다
    expect(EDIT_SCROLL_MARGIN.top).toBe(156);
  });

  it('**바깥 값을 따라간 것은 되돌리기 이력에 없다** — 처음 연 화면에서 되돌리기가 꺼져 있고, 불러온 최신 내용을 되돌리기가 옛 내용으로 돌리지 않는다(병합 전 코드 리뷰 2)', async () => {
    const v1 = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'v1 처음' }] }] } as unknown as DocNode;
    const v2 = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'v2 동료의 글' }] }] } as unknown as DocNode;
    const { rerender } = render(<Editor value={v1} ariaLabel="본문" toolbar="full" />);
    const box = (await screen.findByRole('textbox', { name: '본문' })) as TiptapBox & { editor: { can: () => { undo: () => boolean }; commands: { undo: () => boolean } } };
    expect(box.editor.can().undo()).toBe(false);
    expect((screen.getByRole('button', { name: '되돌리기' }) as HTMLButtonElement).disabled).toBe(true);
    // 409 뒤 "최신 내용 불러오기" — 바깥에서 값이 바뀐다
    rerender(<Editor value={v2} ariaLabel="본문" toolbar="full" />);
    await waitFor(() => expect(box.textContent).toBe('v2 동료의 글'));
    expect(box.editor.can().undo()).toBe(false);
    await act(async () => {
      box.editor.commands.undo();
    });
    expect(box.textContent).toBe('v2 동료의 글');
  });

  it('**편집기가 알린 값을 부모가 돌려주면 따라가지 않는다** — 단추 줄에 초점이 있을 때(키보드로 단추를 쓴다) 고른 글이 문서 끝으로 튀지 않는다(병합 전 코드 리뷰 3)', async () => {
    const start = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world and more' }] }] } as unknown as DocNode;
    function Box() {
      const [v, setV] = useState<DocNode>(start);
      return <Editor value={v} onChange={setV} ariaLabel="댓글 쓰기" toolbar="compact" />;
    }
    render(<Box />);
    type Live = TiptapBox & { editor: { isFocused: boolean; state: { doc: unknown; selection: { from: number; to: number }; tr: { setSelection: (s: unknown) => unknown } }; view: { dispatch: (tr: unknown) => void } } };
    const box = (await screen.findByRole('textbox', { name: '댓글 쓰기' })) as Live;
    const ed = box.editor;
    await act(async () => {
      ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc as never, 7, 12)));
    });
    const bold = screen.getByRole('button', { name: '굵게' });
    // 초점은 단추에 — 편집기에는 초점이 없다(Shift+Tab으로 줄에 들어왔다)
    act(() => bold.focus());
    await act(async () => {
      fireEvent.click(bold);
    });
    expect(ed.state.selection).toMatchObject({ from: 7, to: 12 });
  });

  it('**사람이 고쳤을 때만 onEdit** — 처음 그릴 때와 바깥 값을 따라갈 때는 onChange만 온다 (병합 전 검토 18)', async () => {
    const onChange = vi.fn();
    const onEdit = vi.fn();
    const first = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '처음' }] }] } as unknown as DocNode;
    const second = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '다시 불러온 글' }] }] } as unknown as DocNode;
    const { rerender } = render(<Editor value={first} ariaLabel="본문" onChange={onChange} onEdit={onEdit} />);
    const box = (await screen.findByRole('textbox', { name: '본문' })) as TiptapBox;
    rerender(<Editor value={second} ariaLabel="본문" onChange={onChange} onEdit={onEdit} />);
    await waitFor(() => expect(box.textContent).toBe('다시 불러온 글'));
    expect(onEdit).not.toHaveBeenCalled();
    await act(async () => {
      box.editor.commands.insertContent('더');
    });
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'doc' }));
  });

  it('읽기만 하는 본문은 입력란이 아니다', async () => {
    const { container } = render(<Editor value={emptyDocument()} editable={false} ariaLabel="본문" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(container.querySelector('.editor.readonly')).not.toBeNull();
  });
});
