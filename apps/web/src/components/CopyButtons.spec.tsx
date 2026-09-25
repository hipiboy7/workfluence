// @vitest-environment happy-dom
import { pageMarkdown, pageText, type DocNode } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyButtons } from './CopyButtons';

/**
 * 컴포넌트 시험 (보류 28 — happy-dom + Testing Library, P10_설계서_Llm J절). **이 파일만** DOM 환경에서 돈다(첫 줄 주석).
 * 변환 규칙은 공유 패키지 시험이 보고, 여기는 "무엇을 클립보드에 넣고 무엇을 말하나"를 본다 (FR-1140).
 */

const doc: DocNode = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '본문 *별*' }] }] };

function stubClipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CopyButtons', () => {
  it('"텍스트 복사"는 제목 + 평문을 넣고 그렇게 말한다', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);
    render(<CopyButtons title="회의록" content={doc} />);
    fireEvent.click(screen.getByRole('button', { name: '텍스트 복사' }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', ' 텍스트를 복사했다');
    expect(writeText).toHaveBeenCalledWith(pageText('회의록', doc));
  });

  it('"마크다운 복사"는 마크다운을 넣는다 — 본문의 `*`는 이스케이프된다', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);
    render(<CopyButtons title="회의록" content={doc} />);
    fireEvent.click(screen.getByRole('button', { name: '마크다운 복사' }));
    await screen.findByRole('status');
    expect(writeText).toHaveBeenCalledWith(pageMarkdown('회의록', doc));
    expect(writeText.mock.calls[0]).toEqual(['# 회의록\n\n본문 \\*별\\*']);
  });

  it('**클립보드가 막히면 조용히 넘어가지 않고 말한다**', async () => {
    stubClipboard(() => Promise.reject(new Error('NotAllowedError')));
    render(<CopyButtons title="t" content={doc} />);
    fireEvent.click(screen.getByRole('button', { name: '텍스트 복사' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/복사하지 못했다/);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('클립보드 API가 없는 곳(안전하지 않은 출처)에서는 옛 방식으로 한 번 더 한다', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    render(<CopyButtons title="t" content={doc} />);
    fireEvent.click(screen.getByRole('button', { name: '텍스트 복사' }));
    await screen.findByRole('status');
    expect(exec).toHaveBeenCalledWith('copy');
    // 잠깐 붙인 입력칸은 치운다
    expect(document.querySelector('textarea')).toBeNull();
    exec.mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: '마크다운 복사' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/복사하지 못했다/);
  });
});
