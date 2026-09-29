// @vitest-environment happy-dom
import { emptyDocument } from '@workfluence/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from './Editor';

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

  it('읽기만 하는 본문은 입력란이 아니다', async () => {
    const { container } = render(<Editor value={emptyDocument()} editable={false} ariaLabel="본문" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(container.querySelector('.editor.readonly')).not.toBeNull();
  });
});
