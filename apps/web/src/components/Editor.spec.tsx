// @vitest-environment happy-dom
import { emptyDocument, type DocNode } from '@workfluence/shared';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
