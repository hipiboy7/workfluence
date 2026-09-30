// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIRM_MISMATCH } from './ChangePasswordPage';
import { LINK_BROKEN, RESET_DONE, ResetPasswordPage, tokenFromHash } from './ResetPasswordPage';

/**
 * 컴포넌트 시험 — 메일의 링크로 새 비밀번호 (P19 FR-2006·2013). 값은 주소의 `#t=` 뒤에 오고 **읽자마자 주소에서 지운다**(A.1-6). 새·확인 칸, 다르면 까닭.
 * 정한 뒤 곧바로 들여보내지 않고 로그인으로(A.1-10). 서버는 가짜 `fetch`다
 */
const TOKEN = 'A'.repeat(21) + '-_' + 'z9'.repeat(10);
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
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/auth/password-rules') return Promise.resolve(json(200, { minLength: 8, minCharClasses: 2 }));
      if (url === '/api/auth/reset-password') return Promise.resolve(reply());
      return Promise.reject(new Error(`시험에 없는 요청: ${url}`));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 지금 주소를 그리는 조각 — 값이 주소에서 지워졌는지 본다 */
function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search + loc.hash}</output>;
}

const renderAt = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/reset-password"
          element={
            <>
              <ResetPasswordPage />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('tokenFromHash', () => {
  it('`#t=값`에서 43자 base64url만 꺼낸다', () => {
    expect(tokenFromHash(`#t=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash(`#x=1&t=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash('')).toBeNull();
    expect(tokenFromHash('#t=short')).toBeNull();
    expect(tokenFromHash(`#t=${TOKEN}=`)).toBeNull();
  });
});

describe('ResetPasswordPage', () => {
  it('**값을 읽자마자 주소에서 지운다** — 화면 공유·방문 기록에 남지 않게. 새·확인 칸이 보인다', async () => {
    renderAt(`/reset-password#t=${TOKEN}`);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('새 비밀번호 정하기');
    await vi.waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/reset-password'));
    expect(screen.getByLabelText('새 비밀번호')).toBeTruthy();
    expect(screen.getByLabelText('새 비밀번호 확인')).toBeTruthy();
    expect(screen.queryByLabelText('현재 비밀번호')).toBeNull();
  });

  it('**확인이 다르면 까닭을 보이고 보내지 않는다** — 같으면 값과 새 비밀번호를 보내고 로그인으로 안내한다', async () => {
    renderAt(`/reset-password#t=${TOKEN}`);
    const submit = screen.getByRole('button', { name: '새 비밀번호로 정하기' }) as HTMLButtonElement;
    fill('새 비밀번호', 'New-pw-2026x');
    fill('새 비밀번호 확인', 'New-pw-2026y');
    expect(screen.getByText(CONFIRM_MISMATCH)).toBeTruthy();
    expect(submit.disabled).toBe(true);

    fill('새 비밀번호 확인', 'New-pw-2026x');
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await screen.findByText(RESET_DONE);
    expect(calls.filter((c) => c.url === '/api/auth/reset-password')).toEqual([{ url: '/api/auth/reset-password', body: { token: TOKEN, newPassword: 'New-pw-2026x' } }]);
    expect(screen.getByRole('link', { name: '로그인으로' }).getAttribute('href')).toBe('/login');
  });

  it('**서버가 거절하면 그 문장을 보인다** — 틀린·지난 링크, 약한 비밀번호', async () => {
    reply = () => json(400, { message: '링크가 맞지 않거나 기한이 지났다 — 비밀번호 찾기에서 다시 요청한다' });
    renderAt(`/reset-password#t=${TOKEN}`);
    fill('새 비밀번호', 'New-pw-2026x');
    fill('새 비밀번호 확인', 'New-pw-2026x');
    fireEvent.click(screen.getByRole('button', { name: '새 비밀번호로 정하기' }));
    expect((await screen.findByRole('alert')).textContent).toBe('링크가 맞지 않거나 기한이 지났다 — 비밀번호 찾기에서 다시 요청한다');
    expect(screen.queryByText(RESET_DONE)).toBeNull();
  });

  it('**값이 없거나 모양이 아니면 폼 없이 까닭** — 서버에 가 보지 않고 비밀번호 찾기로 보낸다', () => {
    renderAt('/reset-password#t=broken');
    expect(screen.getByText(LINK_BROKEN)).toBeTruthy();
    expect(screen.queryByLabelText('새 비밀번호')).toBeNull();
    expect(screen.getByRole('link', { name: '비밀번호 찾기로' }).getAttribute('href')).toBe('/find-account');
    expect(calls.some((c) => c.url === '/api/auth/reset-password')).toBe(false);
  });
});
