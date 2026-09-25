// @vitest-environment happy-dom
import type { AuditEventView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuditPage } from './AdminAuditPage';

/** 컴포넌트 시험 — 감사로그를 요청 번호로 거른다 (P11_설계서_Ops G절, FR-1212 · 종료 루틴 자체 점검 9). 서버는 가짜 `fetch`다 */

const RID = 'c4f74de7a73ff592ec5ec63e597de58b';
let urls: string[] = [];

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

const row = (over: Partial<AuditEventView>): AuditEventView => ({
  id: 'e1',
  action: 'user.grants.change',
  actorId: 'r1',
  actorName: '시스템 관리자',
  targetType: 'user',
  targetId: 'a1',
  detail: { before: [], after: ['llm.manage'] },
  ip: null,
  requestId: RID,
  createdAt: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  urls = [];
  globalThis.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith('/api/audit?')) {
      const q = new URL(url, 'http://x').searchParams;
      return Promise.resolve(json(200, q.get('requestId') === RID ? [row({})] : [row({}), row({ id: 'e2', action: 'auth.login.success', requestId: null })]));
    }
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
      <AdminAuditPage />
    </MemoryRouter>,
  );
const withRequestId = () => urls.filter((u) => new URL(u, 'http://x').searchParams.has('requestId'));
/** 목록 표 안에서만 찾는다 — 행위 고르기 칸의 선택지에도 같은 글자가 있다 */
const table = () => within(screen.getByRole('table'));
const listed = async () => waitFor(() => expect(table().getByText('auth.login.success')).toBeTruthy());

describe('AdminAuditPage — 요청 번호로 거르기', () => {
  it('**치는 도중에는 보내지 않고, 거르기를 누르면 앞뒤 공백을 떼고 보낸다** — 목록 끝 칸에 번호가 보인다', async () => {
    renderPage();
    await listed();
    fireEvent.change(screen.getByLabelText('요청 번호'), { target: { value: `  ${RID} ` } });
    expect(withRequestId()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '거르기' }));
    await waitFor(() => expect(withRequestId()).toHaveLength(1));
    expect(new URL(withRequestId()[0], 'http://x').searchParams.get('requestId')).toBe(RID);
    await waitFor(() => expect(table().queryByText('auth.login.success')).toBeNull());
    expect(table().getByText(RID)).toBeTruthy();
  });

  it('**모양이 틀린 번호는 보내지 않는다** — 무엇이 틀렸는지 알린다', async () => {
    renderPage();
    await listed();
    fireEvent.change(screen.getByLabelText('요청 번호'), { target: { value: 'bad id "x"' } });
    fireEvent.click(screen.getByRole('button', { name: '거르기' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/요청 번호의 모양이 아니다/);
    expect(withRequestId()).toEqual([]);
  });

  it('같은 번호로 다시 누르면 다시 읽는다 — 그 사이 남은 행이 있을 수 있다', async () => {
    renderPage();
    await listed();
    fireEvent.change(screen.getByLabelText('요청 번호'), { target: { value: RID } });
    fireEvent.click(screen.getByRole('button', { name: '거르기' }));
    await waitFor(() => expect(withRequestId()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '거르기' }));
    await waitFor(() => expect(withRequestId()).toHaveLength(2));
  });
});
