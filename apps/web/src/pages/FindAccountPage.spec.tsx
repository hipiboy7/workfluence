// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FindAccountPage, SENT_ADMIN, SENT_MAIL } from './FindAccountPage';

/**
 * 컴포넌트 시험 — 아이디·비밀번호 찾기의 두 카드 (P17 설계서 J.6 카드 틀 · P19 FR-2000·2013). **오류와 결과는 각자 카드 안**이다 — 예전에는 오류 칸 하나를
 * 두 폼이 같이 써서 비밀번호 찾기의 오류가 아이디 찾기 위에 떴다. 카드가 곧 폼이다(E2E가 "비밀번호 찾기" 제목을 품은 폼 안에서 찾는다). 서버는 가짜 `fetch`다.
 * 비밀번호 찾기는 두 길 — 메일 재설정을 쓸 수 있을 때만(`/api/auth/config`) 내 email로 링크 받기가 보인다
 */

let findId: () => Response;
let recover: () => Response;
let resetMail: () => Response;
let mailOn: boolean;
const calls: { url: string; body: unknown }[] = [];
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  calls.length = 0;
  mailOn = false;
  findId = () => json(200, { username: null });
  recover = () => json(200, { ok: true });
  resetMail = () => json(200, { ok: true });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/auth/config') return Promise.resolve(json(200, { oidcEnabled: false, collabEnabled: true, resetMailEnabled: mailOn }));
      if (url === '/api/auth/find-id') return Promise.resolve(findId());
      if (url === '/api/auth/recover-password') return Promise.resolve(recover());
      if (url === '/api/auth/reset-mail') return Promise.resolve(resetMail());
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
      <FindAccountPage />
    </MemoryRouter>,
  );

/** 제목을 품은 폼 — E2E와 같은 길로 찾는다 */
const card = (title: string) => screen.getByRole('heading', { name: title }).closest('form')!;
const type = (form: HTMLElement, label: string, value: string) => fireEvent.change(within(form).getByLabelText(label), { target: { value } });
const buttons = (form: HTMLElement) => within(form).getAllByRole('button').map((b) => b.textContent);

describe('FindAccountPage', () => {
  it('**두 카드가 각자 폼이고 화면의 h1은 하나다** — 아이디 찾기가 먼저, 로그인으로 돌아간다', () => {
    renderPage();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['아이디·비밀번호 찾기']);
    const forms = [card('아이디 찾기'), card('비밀번호 찾기')];
    expect(forms[0]).not.toBe(forms[1]);
    expect(forms[0].compareDocumentPosition(forms[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(buttons(forms[0])).toEqual(['찾기']);
    expect(screen.getByRole('link', { name: '← 로그인으로' }).getAttribute('href')).toBe('/login');
  });

  it('**비밀번호 찾기는 이름 + email** (P19 FR-2000) — 아이디 칸이 없고, email 칸 옆에 "이메일이 기억이 안나시나요?"(FR-2009)', () => {
    renderPage();
    const pw = card('비밀번호 찾기');
    expect(within(pw).getByLabelText('이름')).toBeTruthy();
    expect(within(pw).getByLabelText('email')).toBeTruthy();
    expect(within(pw).queryByLabelText('아이디')).toBeNull();
    expect(within(pw).getByRole('link', { name: '이메일이 기억이 안나시나요?' }).getAttribute('href')).toBe('/find-account/email');
  });

  it('**메일 재설정을 쓰지 않으면 관리자에게 초기화 요청 한 길** — 보내면 이름·email을 싣는다', async () => {
    renderPage();
    const pw = card('비밀번호 찾기');
    expect(buttons(pw)).toEqual(['관리자에게 초기화 요청']);
    type(pw, '이름', '앨리스');
    type(pw, 'email', 'alice@example.internal');
    fireEvent.submit(pw);
    await within(pw).findByText(SENT_ADMIN);
    expect(calls.find((c) => c.url === '/api/auth/recover-password')?.body).toEqual({ displayName: '앨리스', email: 'alice@example.internal' });
    expect(calls.some((c) => c.url === '/api/auth/reset-mail')).toBe(false);
  });

  it('**쓸 수 있으면 두 길** — 보내기(Enter)는 내 email로 링크, 옆 단추는 관리자에게. 결과 문장이 길마다 다르다', async () => {
    mailOn = true;
    renderPage();
    const pw = card('비밀번호 찾기');
    await within(pw).findByRole('button', { name: '내 email로 재설정 링크 받기' });
    expect(buttons(pw)).toEqual(['내 email로 재설정 링크 받기', '관리자에게 초기화 요청']);
    expect(within(pw).getByText(/시스템 관리자\(root\)는 메일로 바꾸지 않는다/)).toBeTruthy();
    type(pw, '이름', '앨리스');
    type(pw, 'email', 'alice@example.internal');

    fireEvent.submit(pw);
    await within(pw).findByText(SENT_MAIL);
    expect(calls.find((c) => c.url === '/api/auth/reset-mail')?.body).toEqual({ displayName: '앨리스', email: 'alice@example.internal' });

    fireEvent.click(within(pw).getByRole('button', { name: '관리자에게 초기화 요청' }));
    await within(pw).findByText(SENT_ADMIN);
    expect(within(pw).queryByText(SENT_MAIL)).toBeNull();
  });

  it('**아이디 찾기의 결과는 그 카드 안에** — 맞는 것이 없어도 같은 모양으로 답한다', async () => {
    renderPage();
    const id = card('아이디 찾기');
    type(id, 'email', 'nobody@example.internal');
    type(id, '이름', '없는사람');
    fireEvent.submit(id);
    const said = await within(id).findByText('일치하는 정보로 찾을 수 없다. 관리자에게 문의한다.');
    expect(said.getAttribute('role')).toBe('status');
    expect(within(card('비밀번호 찾기')).queryByRole('status')).toBeNull();
  });

  it('**비밀번호 찾기의 오류는 그 카드 안에만** — 아이디 찾기에는 뜨지 않고, 다시 보내 접수되면 사라진다', async () => {
    recover = () => json(429, { message: '요청이 너무 잦다. 10분 후 다시 시도한다' });
    renderPage();
    const pw = card('비밀번호 찾기');
    type(pw, '이름', '앨리스');
    type(pw, 'email', 'alice@example.internal');
    fireEvent.submit(pw);
    const alert = await within(pw).findByRole('alert');
    expect(alert.textContent).toBe('요청이 너무 잦다. 10분 후 다시 시도한다');
    expect(within(card('아이디 찾기')).queryByRole('alert')).toBeNull();

    recover = () => json(200, { ok: true });
    fireEvent.submit(pw);
    await within(pw).findByText(/^요청을 접수했다\./);
    expect(within(pw).queryByRole('alert')).toBeNull();
    expect(within(card('아이디 찾기')).queryByText(/요청을 접수했다/)).toBeNull();
  });
});
