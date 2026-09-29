// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignupPage } from './SignupPage';

/**
 * 컴포넌트 시험 — 가입 요청 카드 (P17 설계서 J.6 카드 틀). 비밀번호 규칙은 칸 아래 도움말로 칸에 이어지고(`aria-describedby`), 눈 모양 단추가 없다.
 * 접수되면 폼 자리에 완료 알림띠(status)가 남는다 — 누른 단추가 사라지므로 보조기기가 결과를 읽게. 서버는 가짜 `fetch`다
 */

let sent: unknown[] = [];
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/auth/password-rules') return Promise.resolve(json(200, { minLength: 12, minCharClasses: 3 }));
      if (url === '/api/auth/signup') {
        sent.push(JSON.parse(String(init?.body)));
        return Promise.resolve(json(201, { ok: true }));
      }
      return Promise.reject(new Error(`시험에 없는 요청: ${url}`));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SignupPage', () => {
  it('**규칙은 비밀번호 칸의 도움말이고 눈 모양 단추가 없다** — 접수되면 완료 알림띠가 폼을 대신한다', async () => {
    render(
      <MemoryRouter>
        <SignupPage />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['가입 요청']);
    const pw = screen.getByLabelText('비밀번호') as HTMLInputElement;
    const rule = '12자 이상, 영문 대·소문자·숫자·특수문자 중 3종 이상, 공백 없이';
    await waitFor(() => expect(document.getElementById(pw.getAttribute('aria-describedby') ?? '')?.textContent).toBe(rule));
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['가입 요청']);

    const form = { username: 'new.user', displayName: '새 사용자', email: 'new.user@example.internal', password: 'New-User-2026!' };
    fireEvent.change(screen.getByLabelText('아이디'), { target: { value: form.username } });
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: form.displayName } });
    fireEvent.change(screen.getByLabelText('email'), { target: { value: form.email } });
    fireEvent.change(pw, { target: { value: form.password } });
    fireEvent.submit(pw.closest('form')!);

    const done = await screen.findByRole('status');
    expect(done.textContent).toMatch(/^가입 요청이 접수됐다\. 관리자가 승인하면 로그인할 수 있다\./);
    expect(sent).toEqual([form]);
    expect(screen.queryByLabelText('비밀번호')).toBeNull();
    expect(screen.getByRole('link', { name: '← 로그인으로' }).getAttribute('href')).toBe('/login');
  });
});
