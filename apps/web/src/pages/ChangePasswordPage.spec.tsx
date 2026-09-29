// @vitest-environment happy-dom
import type { MeView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth';
import { CONFIRM_MISMATCH, ChangePasswordPage, SAME_AS_CURRENT } from './ChangePasswordPage';

/**
 * 컴포넌트 시험 — 비밀번호 변경 화면의 두 갈래 (P13 FR-1471·1472). 사내 계정은 비밀번호가 없어 여기서 바꾸지 않는다. 안내문은 운영 설정의
 * 규칙을 따른다(예전에는 고정 문자열이었다). 서버는 가짜 `fetch`다. P17(F-010 1·9번) — 세 칸·같음과 불일치·눈 모양·뒤로와 홈.
 * P17 J.3.7 — 스스로 바꿀 때는 한 틀의 폼 화면(머리 h1, 폼 아래 뒤로·홈으로), 바꿔야 하는 동안은 카드(주의 알림띠, 로그아웃만)
 */

let sent: unknown[] = [];

let me: MeView;
let rules = { minLength: 12, minCharClasses: 3 };
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  me = { id: 'u1', username: 'alice', displayName: '앨리스', role: 'member', mustChangePassword: false, grants: [], hasPassword: true };
  rules = { minLength: 12, minCharClasses: 3 };
  sent = [];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/change-password') {
      sent.push(JSON.parse(String(init?.body)));
      return Promise.resolve(json(200, {}));
    }
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

  const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
  const type = (label: string, v: string) => fireEvent.change(field(label), { target: { value: v } });
  const submitButton = () => screen.getByRole('button', { name: '변경' }) as HTMLButtonElement;

  it('**세 칸이 나뉘어 있고 처음에는 모두 가려져 있다** — 현재·새·새 비밀번호 확인, 단추는 감은 눈(보이기)', async () => {
    renderPage();
    await screen.findByLabelText('새 비밀번호 확인');
    for (const label of ['현재 비밀번호', '새 비밀번호', '새 비밀번호 확인']) {
      expect(field(label).type).toBe('password');
      expect(screen.getByRole('button', { name: `${label} 보이기` }).getAttribute('aria-pressed')).toBe('false');
    }
    expect(submitButton().disabled).toBe(true);
  });

  it('**눈을 누르면 글자로 보이고 다시 누르면 가린다** — 그 칸만', async () => {
    renderPage();
    await screen.findByLabelText('새 비밀번호');
    fireEvent.click(screen.getByRole('button', { name: '새 비밀번호 보이기' }));
    expect(field('새 비밀번호').type).toBe('text');
    expect(field('현재 비밀번호').type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: '새 비밀번호 가리기' }));
    expect(field('새 비밀번호').type).toBe('password');
  });

  it('**새 비밀번호가 현재와 같으면 까닭을 보이고 보내지 않는다**', async () => {
    renderPage();
    await screen.findByLabelText('새 비밀번호');
    type('현재 비밀번호', 'Same-Pass-2026!');
    type('새 비밀번호', 'Same-Pass-2026!');
    type('새 비밀번호 확인', 'Same-Pass-2026!');
    expect(screen.getByText(SAME_AS_CURRENT)).toBeTruthy();
    expect(SAME_AS_CURRENT).toBe('새 비밀번호가 현재 비밀번호와 같다 — 다른 비밀번호를 쓴다');
    expect(submitButton().disabled).toBe(true);
    // 까닭은 칸 아래의 오류로 칸에 이어진다 — 보조기기가 칸에서 규칙과 까닭을 함께 읽는다(J.5.3)
    const input = field('새 비밀번호');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = () => (input.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent);
    await waitFor(() => expect(described()).toEqual(['12자 이상, 영문 대·소문자·숫자·특수문자 중 3종 이상, 공백 없이', SAME_AS_CURRENT]));
    expect(screen.getByText(SAME_AS_CURRENT).getAttribute('role')).toBe('alert');
  });

  it('**확인이 새 비밀번호와 다르면 불일치를 보이고 보내지 않는다** — 맞추면 사라지고 보낸다(확인 칸은 보내지 않는다)', async () => {
    renderPage();
    await screen.findByLabelText('새 비밀번호');
    type('현재 비밀번호', 'Old-Pass-2026!');
    type('새 비밀번호', 'New-Pass-2026!');
    type('새 비밀번호 확인', 'New-Pass-2025!');
    expect(screen.getByText(CONFIRM_MISMATCH)).toBeTruthy();
    expect(CONFIRM_MISMATCH).toBe('새 비밀번호와 확인이 다르다');
    expect(submitButton().disabled).toBe(true);
    type('새 비밀번호 확인', 'New-Pass-2026!');
    expect(screen.queryByText(CONFIRM_MISMATCH)).toBeNull();
    fireEvent.click(submitButton());
    await waitFor(() => expect(sent).toEqual([{ currentPassword: 'Old-Pass-2026!', newPassword: 'New-Pass-2026!' }]));
  });

  it('**폼 아래에 변경·뒤로·홈으로가 있다** — 바꿔야 하는 상태면 나갈 곳이 없어 로그아웃만 둔다', async () => {
    renderPage();
    await screen.findByLabelText('새 비밀번호');
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['비밀번호 변경']);
    // 주 단추가 먼저, 나가는 단추는 그 뒤 — 모두 폼 맨 아래 한 줄(J.5.4)
    const row = submitButton().parentElement!;
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['변경', '← 뒤로', '홈으로']);
    expect(submitButton().className).toBe('primary');
    expect(screen.getByRole('button', { name: '← 뒤로' }).getAttribute('type')).toBe('button');
    expect(screen.getByRole('button', { name: '홈으로' }).getAttribute('type')).toBe('button');
    // 로그아웃은 위 막대에 있다 — 이 화면에 되풀이하지 않는다
    expect(screen.queryByRole('button', { name: '로그아웃' })).toBeNull();
    expect(screen.queryByText('비밀번호를 변경해야 계속할 수 있다.')).toBeNull();
    cleanup();
    me = { ...me, mustChangePassword: true };
    renderPage();
    const warning = await screen.findByText('비밀번호를 변경해야 계속할 수 있다.');
    expect(warning.className).toBe('notice warning');
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['비밀번호 변경']);
    expect(screen.queryByRole('button', { name: '← 뒤로' })).toBeNull();
    expect(screen.queryByRole('button', { name: '홈으로' })).toBeNull();
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeTruthy();
    expect(screen.getByLabelText('새 비밀번호 확인')).toBeTruthy();
  });
});
