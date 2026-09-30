// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailHelpPage, HELP_SENT } from './EmailHelpPage';

/**
 * 컴포넌트 시험 — "이메일이 기억이 안나시나요?" (P19 FR-2009, 사용자 원문 4번 — "시스템 관리자에게 확인 요청이 가도록 하는 문구로 안내"). 아이디 + 표시 이름을
 * 보낸다(착수 쟁점 2). 답은 늘 같다 — 맞았는지 말하지 않는다. 서버는 가짜 `fetch`다
 */
const calls: { url: string; body: unknown }[] = [];
let reply: () => Response;
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  calls.length = 0;
  reply = () => json(200, { ok: true });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return String(input) === '/api/auth/email-help' ? Promise.resolve(reply()) : Promise.reject(new Error(`시험에 없는 요청: ${String(input)}`));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <EmailHelpPage />
    </MemoryRouter>,
  );

describe('EmailHelpPage', () => {
  it('**안내 문구** — 시스템 관리자에게 확인 요청이 가고, 본인인지 확인한 뒤 연락한다. 비밀번호 찾기로 돌아간다', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('이메일이 기억나지 않을 때');
    expect(screen.getByText(/시스템 관리자에게 확인을 요청/)).toBeTruthy();
    expect(screen.getByText(/본인인지 확인한 뒤 연락한다/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '← 비밀번호 찾기로' }).getAttribute('href')).toBe('/find-account');
  });

  it('**아이디 + 이름을 보내고 늘 같은 답** — 틀린 요청(429 등)은 까닭을 보인다', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('아이디'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: '앨리스' } });
    fireEvent.click(screen.getByRole('button', { name: '시스템 관리자에게 확인 요청' }));
    await screen.findByText(HELP_SENT);
    expect(calls).toEqual([{ url: '/api/auth/email-help', body: { username: 'alice', displayName: '앨리스' } }]);

    reply = () => json(429, { message: '요청이 너무 잦다. 10분 후 다시 시도한다' });
    fireEvent.click(screen.getByRole('button', { name: '시스템 관리자에게 확인 요청' }));
    expect((await screen.findByRole('alert')).textContent).toBe('요청이 너무 잦다. 10분 후 다시 시도한다');
    expect(screen.queryByText(HELP_SENT)).toBeNull();
  });
});
