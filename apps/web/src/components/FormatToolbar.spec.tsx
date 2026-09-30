// @vitest-environment happy-dom
import { Editor, type Content } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EMPTY_DOC, Editor as EditorView } from './Editor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FormEvent } from 'react';
import { editorExtensions } from './extensions';
import { FormatToolbar } from './FormatToolbar';
import { LINK_NOT_ALLOWED } from './formatActions';

/**
 * 컴포넌트 시험 — 서식 단추 줄 (P19_설계서_Recovery D.1·D.2, FR-2020~2023·2027). 무엇이 그려지고 누르면 무엇이 되는가. 단추마다의 결과(정본 검증)는
 * `formatActions.spec.ts`가 본다
 */
let editors: Editor[] = [];
afterEach(() => {
  cleanup();
  for (const e of editors) e.destroy();
  editors = [];
});

function open(content: Content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '안녕 위키' }] }] }) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const e = new Editor({ element: el, extensions: editorExtensions(), content });
  editors.push(e);
  return e;
}
const select = (e: Editor, from: number, to: number) => act(() => e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, from, to))));
const bar = () => screen.getByRole('toolbar', { name: '서식' });
const names = () => within(bar()).getAllByRole('button').map((b) => b.getAttribute('aria-label'));

describe('FormatToolbar', () => {
  it('**전체 줄** — 문단 형식 고르기와 단추들, 이름은 한국어, 단축키는 title', () => {
    render(<FormatToolbar editor={open()} variant="full" />);
    expect(within(bar()).getByRole('combobox', { name: '문단 형식' })).toBeTruthy();
    expect(names()).toEqual(['굵게', '기울임', '밑줄', '취소선', '코드', '글머리 목록', '번호 목록', '인용', '코드 블록', '구분선', '링크', '표 넣기', '되돌리기', '다시']);
    const bold = within(bar()).getByRole('button', { name: '굵게' });
    expect(bold.getAttribute('title')).toBe('굵게 (Ctrl+B)');
    expect(bold.getAttribute('aria-keyshortcuts')).toBe('Control+B');
  });

  it('**짧은 줄**(댓글) — 굵게·기울임·코드·목록 둘·링크, 문단 형식은 없다', () => {
    render(<FormatToolbar editor={open()} variant="compact" />);
    expect(names()).toEqual(['굵게', '기울임', '코드', '글머리 목록', '번호 목록', '링크']);
    expect(within(bar()).queryByRole('combobox')).toBeNull();
  });

  it('**누르면 서식이 들고 눌림으로 보인다** — 되돌리기는 고친 뒤에야 누를 수 있다', () => {
    const e = open();
    render(<FormatToolbar editor={e} variant="full" />);
    const undo = within(bar()).getByRole('button', { name: '되돌리기' }) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    select(e, 1, 3);
    const bold = within(bar()).getByRole('button', { name: '굵게' });
    expect(bold.getAttribute('aria-pressed')).toBe('false');
    act(() => fireEvent.click(bold));
    expect(bold.getAttribute('aria-pressed')).toBe('true');
    expect(e.isActive('bold')).toBe(true);
    expect(undo.disabled).toBe(false);
    // 눌림이 없는 단추에는 aria-pressed가 없다
    expect(within(bar()).getByRole('button', { name: '구분선' }).hasAttribute('aria-pressed')).toBe(false);
  });

  it('**키보드로 문단 형식을 바꾸면 초점이 칸에 남는다** — ↑↓가 곧바로 값을 바꾸는 브라우저에서 제목 2·3까지 내려간다(병합 전 자체 점검 10). 마우스는 본문으로', async () => {
    const e = open();
    render(<FormatToolbar editor={e} variant="full" />);
    select(e, 2, 2);
    const choose = within(bar()).getByRole('combobox', { name: '문단 형식' }) as HTMLSelectElement;
    act(() => choose.focus());
    act(() => {
      fireEvent.keyDown(choose, { key: 'ArrowDown' });
      fireEvent.change(choose, { target: { value: 'h1' } });
    });
    expect(e.isActive('heading', { level: 1 })).toBe(true);
    // 편집기는 초점을 한 박자 늦게 옮긴다 — 기다린 뒤에도 칸에 있어야 한다(돌연변이 W6: 곧바로 보면 초점을 옮겨도 초록이었다)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(document.activeElement).toBe(choose);
    act(() => {
      fireEvent.pointerDown(choose);
      fireEvent.change(choose, { target: { value: 'h3' } });
    });
    expect(e.isActive('heading', { level: 3 })).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(e.view.dom));
  });

  it('**문단 형식을 고르면 제목이 되고, 지금 형식을 보인다**', () => {
    const e = open();
    render(<FormatToolbar editor={e} variant="full" />);
    select(e, 2, 2);
    const choose = within(bar()).getByRole('combobox', { name: '문단 형식' }) as HTMLSelectElement;
    expect(choose.value).toBe('paragraph');
    act(() => fireEvent.change(choose, { target: { value: 'h2' } }));
    expect(e.isActive('heading', { level: 2 })).toBe(true);
    expect(choose.value).toBe('h2');
  });

  it('**표 안에 있을 때만 표 무리가 붙는다** — 표 넣기는 그때 누를 수 없다', () => {
    const e = open();
    render(<FormatToolbar editor={e} variant="full" />);
    expect(within(bar()).queryByRole('group', { name: '표' })).toBeNull();
    act(() => fireEvent.click(within(bar()).getByRole('button', { name: '표 넣기' })));
    const table = within(bar()).getByRole('group', { name: '표' });
    expect(within(table).getAllByRole('button').map((b) => b.textContent)).toEqual(['위에 행', '아래에 행', '왼쪽에 열', '오른쪽에 열', '행 지우기', '열 지우기', '표 지우기']);
    expect((within(bar()).getByRole('button', { name: '표 넣기' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => fireEvent.click(within(table).getByRole('button', { name: '표 지우기' })));
    expect(within(bar()).queryByRole('group', { name: '표' })).toBeNull();
  });

  it('**Tab 자리는 하나, ←·→·Home·End로 옮긴다** — 쓸 수 없는 단추는 건너뛴다(A.1-18)', () => {
    render(<FormatToolbar editor={open()} variant="compact" />);
    const buttons = within(bar()).getAllByRole('button');
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    buttons[0].focus();
    fireEvent.keyDown(bar(), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(bar(), { key: 'End' });
    expect(document.activeElement).toBe(buttons.at(-1));
    fireEvent.keyDown(bar(), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(bar(), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(buttons.at(-1));
    expect(buttons.filter((b) => b.tabIndex === 0)).toEqual([buttons.at(-1)]);
  });

  it('**링크 — 대화로 주소를 받고, 안 되는 주소는 까닭을 보이고 닫지 않는다**', () => {
    const e = open();
    render(<FormatToolbar editor={e} variant="full" />);
    select(e, 1, 3);
    act(() => fireEvent.click(within(bar()).getByRole('button', { name: '링크' })));
    const dialog = screen.getByRole('dialog', { name: '링크' });
    const box = within(dialog).getByLabelText('주소');
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'mailto:a@example.internal' } });
    act(() => fireEvent.click(within(dialog).getByRole('button', { name: '링크 넣기' })));
    expect(within(dialog).getByText(LINK_NOT_ALLOWED)).toBeTruthy();
    fireEvent.change(box, { target: { value: 'https://example.internal/문서' } });
    act(() => fireEvent.click(within(dialog).getByRole('button', { name: '링크 넣기' })));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(e.getAttributes('link').href).toBe('https://example.internal/문서');
  });

  it('**링크 위에서 열면 지금 주소가 있고 링크를 뺀다** · 본문의 Ctrl+K로도 연다', () => {
    const e = open({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '위키', marks: [{ type: 'link', attrs: { href: 'https://a.example.internal' } }] }] }] });
    render(<FormatToolbar editor={e} variant="full" />);
    select(e, 2, 2);
    act(() => {
      fireEvent.keyDown(e.view.dom, { key: 'k', ctrlKey: true });
    });
    const dialog = screen.getByRole('dialog', { name: '링크' });
    expect((within(dialog).getByLabelText('주소') as HTMLInputElement).value).toBe('https://a.example.internal');
    act(() => fireEvent.click(within(dialog).getByRole('button', { name: '링크 빼기' })));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(e.isActive('link')).toBe(false);
  });

  it('**폼 안의 편집기(댓글 칸)에서 링크를 넣어도 바깥 폼은 제출되지 않는다** — 대화는 폼 밖(body)에 그리고 제출을 올려 보내지 않는다(병합 전 코드 리뷰 1 · 자체 점검 1)', async () => {
    const outer = vi.fn((ev: FormEvent) => ev.preventDefault());
    const hello = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }] } as unknown as typeof EMPTY_DOC;
    render(
      <form aria-label="댓글 폼" onSubmit={outer}>
        <EditorView value={hello} ariaLabel="댓글 쓰기" toolbar="compact" />
      </form>,
    );
    const box = (await screen.findByRole('textbox', { name: '댓글 쓰기' })) as HTMLElement & { editor: Editor };
    const e = box.editor;
    select(e, 7, 12);
    for (const how of ['click', 'submit'] as const) {
      act(() => fireEvent.click(within(bar()).getByRole('button', { name: '링크' })));
      const dialog = screen.getByRole('dialog', { name: '링크' });
      // 폼 안의 폼이 아니다
      expect(screen.getByRole('form', { name: '댓글 폼' }).contains(dialog)).toBe(false);
      fireEvent.change(within(dialog).getByLabelText('주소'), { target: { value: `https://example.internal/${how}` } });
      if (how === 'click') act(() => fireEvent.click(within(dialog).getByRole('button', { name: '링크 넣기' })));
      else act(() => fireEvent.submit(dialog.querySelector('form')!));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(e.getAttributes('link').href).toBe(`https://example.internal/${how}`);
    }
    expect(outer).not.toHaveBeenCalled();
  });

  it('**그만두기는 아무것도 하지 않는다**', () => {
    const e = open();
    render(<FormatToolbar editor={e} variant="full" />);
    select(e, 1, 3);
    act(() => fireEvent.click(within(bar()).getByRole('button', { name: '링크' })));
    const dialog = screen.getByRole('dialog', { name: '링크' });
    fireEvent.change(within(dialog).getByLabelText('주소'), { target: { value: 'https://example.internal' } });
    act(() => fireEvent.click(within(dialog).getByRole('button', { name: '그만두기' })));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(e.isActive('link')).toBe(false);
  });
});

describe('편집기 부품의 줄 (FR-2027)', () => {
  it('**쓰는 칸에만 줄이 있다** — 읽기만 하는 본문에는 없다, 줄은 본문 칸 바로 위', () => {
    const { container, rerender } = render(<EditorView value={EMPTY_DOC} toolbar="full" />);
    const toolbar = screen.getByRole('toolbar', { name: '서식' });
    expect(toolbar.nextElementSibling?.classList.contains('editor')).toBe(true);
    rerender(<EditorView value={EMPTY_DOC} toolbar="full" editable={false} />);
    expect(container.querySelector('[role="toolbar"]')).toBeNull();
  });
});
