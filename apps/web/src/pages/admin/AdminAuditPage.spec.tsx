// @vitest-environment happy-dom
import type { AuditEventView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../auth';
import { AdminAuditPage } from './AdminAuditPage';

/**
 * 컴포넌트 시험 — 감사로그를 요청 번호로 거른다 (P11_설계서_Ops G절, FR-1212 · 종료 루틴 자체 점검 9), 화면 체계(P17 J.6 관리 다섯 — 행위의 한글 이름·대상·상세·
 * 기록 단계의 접힌 구획). 서버는 가짜 `fetch`다
 */

const RID = 'c4f74de7a73ff592ec5ec63e597de58b';
const TARGET = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
let urls: string[] = [];
/** 거르지 않은 목록 — 시험마다 바꾼다 */
let listed_: AuditEventView[] | null = null;

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
  listed_ = null;
  globalThis.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith('/api/audit?')) {
      const q = new URL(url, 'http://x').searchParams;
      if (q.get('from')) return Promise.resolve(json(200, []));
      return Promise.resolve(
        json(200, q.get('requestId') === RID ? [row({})] : (listed_ ?? [row({}), row({ id: 'e2', action: 'auth.login.success', requestId: null })])),
      );
    }
    // P17 — 화면 맨 위의 감사 기록 단계와 로그인한 사람(시스템 관리자만 단계를 고른다)
    if (url === '/api/settings/policy') return Promise.resolve(json(200, { auditLevel: 3 }));
    if (url === '/api/auth/me') return Promise.resolve(json(200, { id: 'u1', username: 'root', displayName: '관리자', role: 'root', mustChangePassword: false, grants: [], hasPassword: true }));
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
        <AdminAuditPage />
      </AuthProvider>
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

describe('AdminAuditPage — 화면 체계 (P17 J.6 관리 다섯)', () => {
  it('**행위는 "한글 + 코드"로 보이고, 고르기 칸의 글은 "한글 (코드)"·값은 코드다** (J.9-9)', async () => {
    renderPage();
    await listed();
    const cell = table().getByText('auth.login.success').closest('td')!;
    expect(cell.textContent).toBe('로그인 성공 auth.login.success');
    expect(cell.querySelector('code')!.textContent).toBe('auth.login.success');
    // 표의 둘째 칸이 행위다 — 열 순서를 바꾸지 않는다
    expect(cell.cellIndex).toBe(1);
    const option = within(screen.getByLabelText('행위')).getByRole('option', { name: '로그인 성공 (auth.login.success)' }) as HTMLOptionElement;
    expect(option.value).toBe('auth.login.success');
    // 표는 기록 목록 하나다 — 기록 단계는 표가 아니라 접힌 구획이다
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(screen.getByRole('group', { name: '감사 기록 단계' }).tagName).toBe('DETAILS');
  });

  it('**대상은 종류(한글)와 그 대상 자신의 이름, 아래에 전체 식별자** · 긴 상세는 요약을 펼쳐 본다 (병합 전 검토 6·16·23)', async () => {
    listed_ = [
      row({ id: 'n1', action: 'user.grants.change', targetId: TARGET, detail: { username: 'boss', before: [], after: ['llm.manage'] } }),
      row({ id: 'n2', action: 'category.update', targetType: 'category', targetId: TARGET, detail: { before: '운영', after: `운영 문서 ${'가'.repeat(100)}` } }),
      row({ id: 'n3', action: 'trash.purge', actorName: null, targetType: 'system', targetId: null, detail: null, requestId: null }),
    ];
    renderPage();
    await waitFor(() => expect(table().getByText('trash.purge')).toBeTruthy());
    const cells = (action: string) => table().getByText(action).closest('tr')!.querySelectorAll('td');
    const lines = (td: Element) => [...td.children].map((el) => el.textContent);
    // 사용자면 상세의 아이디가 이름이다. 식별자는 **자르지 않고** 작은 고정폭 글로 늘 보인다 — 로그의 id로 화면에서 찾는다
    expect(lines(cells('user.grants.change')[3])).toEqual(['사용자 · boss', TARGET]);
    expect(cells('user.grants.change')[3].children[1].className).toBe('mono small break-any');
    // 그 대상의 이름을 싣지 않은 상세(바꾸기 전·뒤)는 종류와 식별자만
    expect(lines(cells('category.update')[3])).toEqual(['분류', TARGET]);
    // 짧은 상세는 한 줄 그대로 — 글 값은 따옴표째다. 긴 상세는 잘린 요약 + 펼치면 전체 JSON
    expect(cells('user.grants.change')[4].textContent).toBe('username: "boss" · before: [] · after: ["llm.manage"]');
    const long = cells('category.update')[4];
    expect(long.querySelector('summary')!.textContent).toMatch(/…$/);
    expect(JSON.parse(long.querySelector('pre code')!.textContent!)).toEqual(listed_[1].detail);
    // 요청 밖의 정리 — 주체·대상·상세·번호가 없다
    expect([...cells('trash.purge')].slice(2).map((td) => td.textContent)).toEqual(['-', '-', '-', '-']);
  });

  it('**상세의 이름이 대상이 아니면 대상으로 보이지 않는다** — Crew 추가의 `username`은 넣은 사람이지 스페이스가 아니다 (병합 전 검토 6)', async () => {
    const SPACE = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
    listed_ = [row({ id: 'm1', action: 'space.member.add', targetType: 'space', targetId: SPACE, detail: { username: 'bob', role: 'editor' } })];
    renderPage();
    await waitFor(() => expect(table().getByText('space.member.add')).toBeTruthy());
    const td = table().getByText('space.member.add').closest('tr')!.querySelectorAll('td');
    expect([...td[3].children].map((el) => el.textContent)).toEqual(['스페이스', SPACE]);
    // 넣은 사람은 상세 칸에 있다
    expect(td[4].textContent).toBe('username: "bob" · role: "editor"');
  });

  it('**행위자가 지은 이름이 구분자를 흉내 내도 다른 키·대상으로 읽히지 않는다** — 종류와 식별자가 곁에 있고 상세의 글은 따옴표째 (병합 전 검토 23)', async () => {
    const OTHER = '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f';
    const title = `a · spaceId: ${OTHER}`;
    listed_ = [row({ id: 'd1', action: 'page.delete', targetType: 'page', targetId: TARGET, detail: { title } })];
    renderPage();
    await waitFor(() => expect(table().getByText('page.delete')).toBeTruthy());
    const td = table().getByText('page.delete').closest('tr')!.querySelectorAll('td');
    expect([...td[3].children].map((el) => el.textContent)).toEqual([`페이지 · ${title}`, TARGET]);
    expect(td[4].textContent).toBe(`title: "a · spaceId: ${OTHER}"`);
  });

  it('모르는 대상 종류는 그 글 그대로, 이름 없이 — 객체의 기본 속성 이름도 종류로 읽지 않는다', async () => {
    listed_ = [
      row({ id: 'u1', action: 'user.grants.change', targetType: 'future.kind', targetId: 'k-1', detail: { name: '지은 이름' } }),
      row({ id: 'u2', action: 'auth.login.failure', targetType: 'constructor', targetId: 'k-2', detail: { name: '지은 이름' } }),
    ];
    renderPage();
    await waitFor(() => expect(table().getByText('k-1')).toBeTruthy());
    expect([...table().getByText('k-1').closest('td')!.children].map((el) => el.textContent)).toEqual(['future.kind', 'k-1']);
    expect([...table().getByText('k-2').closest('td')!.children].map((el) => el.textContent)).toEqual(['constructor', 'k-2']);
  });

  it('**거른 결과가 0건이면 몸통에 줄을 두지 않고 표 아래에 빈 상태를 말한다** — 건수는 거르기 줄 끝', async () => {
    renderPage();
    await listed();
    expect(screen.getByText(/^2건 \(최대/).closest('form')!.getAttribute('role')).toBe('search');
    fireEvent.change(screen.getByLabelText('시작'), { target: { value: '2099-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: '거르기' }));
    await screen.findByText('조건에 맞는 기록이 없다.');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(screen.getByText(/^0건 \(최대/)).toBeTruthy();
  });
});
