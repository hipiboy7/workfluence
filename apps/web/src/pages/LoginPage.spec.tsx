// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth';
import { LoginPage } from './LoginPage';

/**
 * 컴포넌트 시험 — 로그인 카드 (P17 설계서 J.6 카드 틀 · J.8). 카드 위 제품 이름이 h1, 카드 안 "로그인"이 h2다. **눈 모양 단추가 없다**(J.8 6 —
 * 있으면 "비밀번호"로 칸을 찾는 이름 찾기가 그 단추에도 걸린다). 오류는 카드 안 맨 위, 사내 계정 로그인은 서버가 켰을 때만 링크로. 서버는 가짜 `fetch`다
 */

let oidcEnabled = false;
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  oidcEnabled = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      if (url === '/api/auth/me') return Promise.resolve(json(401, { message: '로그인이 필요하다' }));
      if (url === '/api/auth/config') return Promise.resolve(json(200, { oidcEnabled }));
      if (url === '/api/auth/login') return Promise.resolve(json(401, { message: '아이디 또는 비밀번호가 올바르지 않다' }));
      return Promise.reject(new Error(`시험에 없는 요청: ${url}`));
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
      <AuthProvider>
        <LoginPage />
      </AuthProvider>
    </MemoryRouter>,
  );

describe('LoginPage', () => {
  it('**제품 이름이 h1, 카드 안 "로그인"이 h2이고 눈 모양 단추가 없다** — 아래에 링크 셋', async () => {
    renderPage();
    await screen.findByLabelText('아이디');
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['workfluence']);
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['workfluence', '로그인']);
    expect((screen.getByLabelText('비밀번호') as HTMLInputElement).type).toBe('password');
    // 단추는 로그인 하나 — 눈 모양(보이기) 단추를 두지 않는다
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['로그인']);
    expect(screen.getByRole('button', { name: '로그인' }).className).toBe('primary');
    expect(screen.getByRole('link', { name: '가입 요청' }).getAttribute('href')).toBe('/signup');
    expect(screen.getByRole('link', { name: '아이디·비밀번호 찾기' }).getAttribute('href')).toBe('/find-account');
    expect(screen.getByRole('link', { name: '시스템 관리자 아이디 찾기' }).getAttribute('href')).toBe('/find-account/root');
    expect(screen.queryByRole('link', { name: '사내 계정으로 로그인' })).toBeNull();
  });

  it('**서버가 켰으면 "또는" 아래에 사내 계정으로 로그인 — 서버로 가는 링크다**', async () => {
    oidcEnabled = true;
    renderPage();
    const link = await screen.findByRole('link', { name: '사내 계정으로 로그인' });
    expect(link.getAttribute('href')).toBe('/api/auth/oidc/start');
    expect(link.className).toBe('btn');
    expect(screen.getByText('또는')).toBeTruthy();
  });

  it('**틀리면 카드 안 맨 위에 오류 알림띠(alert)** — 문장은 서버의 것 그대로', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('아이디'), { target: { value: 'nobody' } });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'Wrong-Pass-2026!' } });
    fireEvent.submit(screen.getByRole('button', { name: '로그인' }).closest('form')!);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('아이디 또는 비밀번호가 올바르지 않다');
    const card = screen.getByRole('heading', { name: '로그인' }).parentElement!;
    expect(within(card).getByRole('alert')).toBe(alert);
    // 칸보다 앞 — 제목 바로 아래
    expect(alert.compareDocumentPosition(screen.getByLabelText('아이디')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
