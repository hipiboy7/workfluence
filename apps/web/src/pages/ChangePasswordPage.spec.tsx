// @vitest-environment happy-dom
import type { MeView } from '@workfluence/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth';
import { ChangePasswordPage } from './ChangePasswordPage';

/**
 * 컴포넌트 시험 — 비밀번호 변경 화면의 두 갈래 (P13 FR-1471·1472). 사내 계정은 비밀번호가 없어 여기서 바꾸지 않는다. 안내문은 운영 설정의
 * 규칙을 따른다(예전에는 고정 문자열이었다). 서버는 가짜 `fetch`다
 */

let me: MeView;
let rules = { minLength: 12, minCharClasses: 3 };
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  me = { id: 'u1', username: 'alice', displayName: '앨리스', role: 'member', mustChangePassword: false, grants: [], hasPassword: true };
  rules = { minLength: 12, minCharClasses: 3 };
  globalThis.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (url === '/api/auth/password-rules') return Promise.resolve(json(200, rules));
    return Promise.reject(new Error(`시험에 없는 요청: ${url}`));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <AuthProvider>
        <ChangePasswordPage />
      </AuthProvider>
    </MemoryRouter>,
  );

describe('ChangePasswordPage', () => {
  it('**안내문은 운영 설정의 규칙을 따른다** — 관리자가 12자·3종으로 올리면 그렇게 보인다', async () => {
    renderPage();
    await screen.findByLabelText('새 비밀번호');
    await waitFor(() => expect(screen.getByText('12자 이상, 영문 대·소문자·숫자·특수문자 중 3종 이상, 공백 없이')).toBeTruthy());
  });

  it('**사내 계정은 폼 대신 IdP에서 바꾸라고 말한다** — 예전에는 눌러야 "사용자를 찾을 수 없다"가 떴다', async () => {
    me = { ...me, hasPassword: false };
    renderPage();
    await screen.findByText(/사내 계정\(IdP\)에서 바꾼다/);
    expect(screen.queryByLabelText('새 비밀번호')).toBeNull();
  });
});
