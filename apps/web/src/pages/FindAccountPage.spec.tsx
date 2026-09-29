// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FindAccountPage } from './FindAccountPage';

/**
 * 컴포넌트 시험 — 아이디·비밀번호 찾기의 두 카드 (P17 설계서 J.6 카드 틀). **오류와 결과는 각자 카드 안**이다 — 예전에는 오류 칸 하나를 두 폼이
 * 같이 써서 비밀번호 찾기의 오류가 아이디 찾기 위에 떴다. 카드가 곧 폼이다(E2E가 "비밀번호 찾기" 제목을 품은 폼 안에서 찾는다). 서버는 가짜 `fetch`다
 */

let findId: () => Response;
let recover: () => Response;
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  findId = () => json(200, { username: null });
  recover = () => json(200, { ok: true });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      if (url === '/api/auth/find-id') return Promise.resolve(findId());
      if (url === '/api/auth/recover-password') return Promise.resolve(recover());
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

describe('FindAccountPage', () => {
  it('**두 카드가 각자 폼이고 화면의 h1은 하나다** — 아이디 찾기가 먼저, 로그인으로 돌아간다', () => {
    renderPage();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['아이디·비밀번호 찾기']);
    const forms = [card('아이디 찾기'), card('비밀번호 찾기')];
    expect(forms[0]).not.toBe(forms[1]);
    expect(forms[0].compareDocumentPosition(forms[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(forms[0]).getByRole('button').textContent).toBe('찾기');
    expect(within(forms[1]).getByRole('button').textContent).toBe('초기화 요청');
    expect(screen.getByRole('link', { name: '← 로그인으로' }).getAttribute('href')).toBe('/login');
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
    type(pw, '아이디', 'alice');
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
