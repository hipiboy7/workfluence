// @vitest-environment happy-dom
import type { MeView, UserView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../auth';
import { AdminUsersPage } from './AdminUsersPage';

/**
 * 컴포넌트 시험 — 사용자 관리의 위임 (P11_설계서_Ops D.1·G절, FR-1201·1206 · P15_설계서_Grants D.5, FR-1600·1601), 찾기·거르기·더 보기·정지 (P13 C.5·C.6).
 * 서버는 가짜 `fetch`다 — 목록은 서버처럼 찾고 거르고 나눠 준다
 */

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let me: MeView;
let rows: UserView[];
let listStatus = 200;

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

const user = (over: Partial<UserView>): UserView => ({
  id: 'x',
  username: 'x',
  displayName: 'x',
  email: null,
  role: 'member',
  status: 'active',
  mustChangePassword: false,
  grants: [],
  createdAt: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  calls = [];
  listStatus = 200;
  me = { id: 'r1', username: 'root', displayName: '시스템 관리자', role: 'root', mustChangePassword: false, grants: [], hasPassword: true };
  rows = [user({ id: 'a1', username: 'boss', role: 'admin' }), user({ id: 'm1', username: 'alice' })];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body });
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (method === 'GET' && url.startsWith('/api/users?')) {
      if (listStatus !== 200) return Promise.resolve(json(listStatus, { message: '권한이 없다: user.manage' }));
      const p = new URL(url, 'http://t').searchParams;
      const q = (p.get('q') ?? '').toLowerCase();
      const status = p.get('status');
      const hits = rows.filter((r) => (!q || r.username.includes(q) || r.displayName.toLowerCase().includes(q)) && (!status || r.status === status));
      const offset = Number(p.get('offset') ?? 0);
      const limit = Number(p.get('limit') ?? 100);
      return Promise.resolve(json(200, { items: hits.slice(offset, offset + limit), total: hits.length }));
    }
    if (method === 'POST' && /^\/api\/users\/[^/]+\/(suspend|unsuspend)$/.test(url)) {
      const [, , , id, verb] = url.split('/');
      rows = rows.map((r) => (r.id === id ? { ...r, status: verb === 'suspend' ? 'suspended' : 'active' } : r));
      return Promise.resolve(json(200, rows.find((r) => r.id === id)));
    }
    if (method === 'POST' && /^\/api\/users\/[^/]+\/reset-password$/.test(url)) return Promise.resolve(json(200, { temporaryPassword: 'Tmp-합성-0001' }));
    if (method === 'PUT' && /^\/api\/users\/[^/]+\/grants$/.test(url)) {
      const id = url.split('/')[3];
      rows = rows.map((r) => (r.id === id ? { ...r, grants: (body as { grants: UserView['grants'] }).grants } : r));
      return Promise.resolve(json(200, rows.find((r) => r.id === id)));
    }
    return Promise.reject(new Error(`시험에 없는 요청: ${method} ${url}`));
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
        <AdminUsersPage />
      </AuthProvider>
    </MemoryRouter>,
  );

/** 그 줄의 단추 — 글자로 정확히 찾는다(정지와 정지 해제가 한 화면에 있다) */
const rowButton = (username: string, text: string) =>
  Array.from(screen.getAllByText(username).find((el) => el.tagName === 'TD')!.closest('tr')!.querySelectorAll('button')).find((b) => b.textContent === text);

/** 확인 대화에 답한다 (P17 J.5.10) — 브라우저 확인 창 대신 화면의 대화다 */
const reply = async (label: '멈춘다' | '그만두기') => {
  const dialog = await screen.findByRole('dialog', { name: '이 사용자를 정지할까요?' });
  fireEvent.click(within(dialog).getByRole('button', { name: label }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
};

describe('AdminUsersPage — email (P19 FR-2009)', () => {
  it('**이름 아래에 email** — 시스템 관리자가 "이메일이 기억이 안나시나요?" 요청을 받고 본인에게 알려 주는 값이다. 없으면 비운다', async () => {
    rows = [user({ id: 'm1', username: 'alice', displayName: '앨리스', email: 'alice@example.internal' }), user({ id: 'm2', username: 'idp', displayName: '사내' })];
    renderPage();
    const cell = (await screen.findByText('앨리스')).closest('td')!;
    expect(cell.textContent).toBe('앨리스alice@example.internal');
    expect(screen.getByText('사내').closest('td')!.textContent).toBe('사내');
    expect(screen.getByRole('columnheader', { name: '이름 · email' })).toBeTruthy();
  });
});

describe('AdminUsersPage — 위임', () => {
  it('**root는 관리자에게 LLM 연결 관리를 주고 거둔다** — 목록 전체를 보내고 다시 읽는다', async () => {
    renderPage();
    const box = (await screen.findByRole('checkbox', { name: 'boss LLM 연결 관리' })) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    // 화면이 본 목록(`expected`)을 함께 보낸다 — 서버의 목록과 다르면 409다 (P15 병합 전 보안 검토 2)
    expect(calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', url: '/api/users/a1/grants', body: { grants: ['llm.manage'], expected: [] } });
    await waitFor(() => expect((screen.getByRole('checkbox', { name: 'boss LLM 연결 관리' }) as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByRole('checkbox', { name: 'boss LLM 연결 관리' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({ grants: [], expected: ['llm.manage'] }));
  });

  it('**행마다 그 역할이 받는 위임만 있다** — 관리자 줄에 LLM 연결 관리, member 줄에 셋 (P15 D.5)', async () => {
    renderPage();
    await screen.findByRole('checkbox', { name: 'boss LLM 연결 관리' });
    expect(screen.queryByRole('checkbox', { name: 'alice LLM 연결 관리' })).toBeNull();
    for (const label of ['분류 관리', '관리자가 건 중지 풀기', '스페이스 관리 전체']) {
      expect(screen.getByRole('checkbox', { name: `alice ${label}` })).toBeTruthy();
      expect(screen.queryByRole('checkbox', { name: `boss ${label}` })).toBeNull();
    }
  });

  it('**관리자는 member에게 셋을 주고 거둔다** — LLM 연결 관리 칸은 보이기만 한다 (P15 FR-1600·1601)', async () => {
    me = { ...me, id: 'a2', role: 'admin', grants: [] };
    renderPage();
    const box = (await screen.findByRole('checkbox', { name: 'alice 분류 관리' })) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect((screen.getByRole('checkbox', { name: 'boss LLM 연결 관리' }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(box);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', url: '/api/users/m1/grants', body: { grants: ['category.manage'], expected: [] } }),
    );
    await waitFor(() => expect((screen.getByRole('checkbox', { name: 'alice 분류 관리' }) as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByRole('checkbox', { name: 'alice 스페이스 관리 전체' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({ grants: ['category.manage', 'space.oversee'], expected: ['category.manage'] }),
    );
  });

  it('**연달아 켜도 거짓 409가 없다** — 응답으로 그 줄을 곧바로 바꾼 뒤에 칸을 푼다. 둘째는 첫째의 결과를 본 목록을 보낸다 (좁은 재검토 2)', async () => {
    me = { ...me, id: 'a2', role: 'admin', grants: [] };
    renderPage();
    const first = (await screen.findByRole('checkbox', { name: 'alice 분류 관리' })) as HTMLInputElement;
    await waitFor(() => expect(first.disabled).toBe(false));
    fireEvent.click(first);
    const second = screen.getByRole('checkbox', { name: 'alice 스페이스 관리 전체' }) as HTMLInputElement;
    await waitFor(() => expect(second.disabled).toBe(false));
    expect((screen.getByRole('checkbox', { name: 'alice 분류 관리' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(second);
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      { grants: ['category.manage'], expected: [] },
      { grants: ['category.manage', 'space.oversee'], expected: ['category.manage'] },
    ]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('**역할을 바꾸면 거둘 수 없는 위임이 사라지는 선택은 막는다** — LLM 연결 관리를 가진 관리자를 member로 내리는 것은 root만 (좁은 재검토 14)', async () => {
    me = { ...me, id: 'a2', role: 'admin', grants: ['llm.manage'] };
    rows = [user({ id: 'a1', username: 'boss', role: 'admin', grants: ['llm.manage'] }), user({ id: 'm1', username: 'alice', grants: ['category.manage'] })];
    renderPage();
    const bossRole = (await screen.findByRole('combobox', { name: 'boss 역할' })) as HTMLSelectElement;
    await waitFor(() => expect(bossRole.disabled).toBe(false));
    const option = (sel: HTMLSelectElement, v: string) => [...sel.options].find((o) => o.value === v)!;
    expect(option(bossRole, 'member').disabled).toBe(true);
    // 관리자는 셋을 받은 member를 관리자로 올린다 — 셋을 거둘 수 있다
    expect(option(screen.getByRole('combobox', { name: 'alice 역할' }) as HTMLSelectElement, 'admin').disabled).toBe(false);
  });

  it('**보내는 동안 그 줄의 칸을 막고, 거절되면 다시 읽는다** — 빨리 둘을 누르면 둘째가 첫째의 결과를 모르는 목록을 보냈다 (P15 병합 전 코드 리뷰 5·12)', async () => {
    me = { ...me, id: 'a2', role: 'admin', grants: [] };
    let answerPut!: (r: Response) => void;
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        calls.push({ method: 'PUT', url: String(input), body: JSON.parse(String(init?.body)) as unknown });
        return new Promise<Response>((ok) => (answerPut = ok));
      }
      return base(input as RequestInfo, init);
    }) as unknown as typeof fetch;
    renderPage();
    const first = (await screen.findByRole('checkbox', { name: 'alice 분류 관리' })) as HTMLInputElement;
    await waitFor(() => expect(first.disabled).toBe(false));
    fireEvent.click(first);
    const other = screen.getByRole('checkbox', { name: 'alice 스페이스 관리 전체' }) as HTMLInputElement;
    await waitFor(() => expect(other.disabled).toBe(true));
    const listsBefore = calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/users?')).length;
    answerPut(json(409, { message: '그 사이 누가 이 사람의 위임을 바꿨다 — 목록을 다시 본다' }));
    expect((await screen.findByRole('alert')).textContent).toContain('그 사이 누가 이 사람의 위임을 바꿨다');
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/users?')).length).toBeGreaterThan(listsBefore));
    await waitFor(() => expect((screen.getByRole('checkbox', { name: 'alice 스페이스 관리 전체' }) as HTMLInputElement).disabled).toBe(false));
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('**다른 관리자에게는 보이기만 한다** — LLM 연결 관리를 주고 거두는 것은 root만 (A.1-3)', async () => {
    me = { ...me, id: 'a2', role: 'admin', grants: ['llm.manage'] };
    renderPage();
    const box = (await screen.findByRole('checkbox', { name: 'boss LLM 연결 관리' })) as HTMLInputElement;
    await waitFor(() => expect(calls.some((c) => c.url === '/api/auth/me')).toBe(true));
    expect(box.disabled).toBe(true);
    expect(box.title).toMatch(/시스템 관리자만/);
  });

  it('**위임 없는 관리자는 위임받은 관리자를 관리하지 못한다** — 그 행의 조치는 눌리지 않는다. 다른 행은 그대로 (보안 검토 1)', async () => {
    me = { ...me, id: 'a2', role: 'admin', grants: [] };
    rows = [user({ id: 'a1', username: 'boss', role: 'admin', grants: ['llm.manage'] }), user({ id: 'a3', username: 'peer', role: 'admin' }), user({ id: 'm1', username: 'alice' })];
    renderPage();
    await screen.findByRole('checkbox', { name: 'boss LLM 연결 관리' });
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'boss 역할' }) as HTMLSelectElement).disabled).toBe(true));
    const resets = screen.getAllByRole('button', { name: '비밀번호 초기화' }) as HTMLButtonElement[];
    const ends = screen.getAllByRole('button', { name: '세션 강제 종료' }) as HTMLButtonElement[];
    expect(resets.map((b) => b.disabled)).toEqual([true, false, false]);
    expect(ends.map((b) => b.disabled)).toEqual([true, false, false]);
    expect(resets[0].title).toMatch(/권한이 없다/);
    expect((screen.getByRole('combobox', { name: 'peer 역할' }) as HTMLSelectElement).disabled).toBe(false);
    // 까닭은 그 줄에 글로도 보인다 (J.5.2)
    expect(screen.getByText('boss').closest('tr')!.textContent).toContain('이 사용자를 관리할 권한이 없다');
    expect(screen.getByText('peer').closest('tr')!.textContent).not.toContain('관리할 권한이 없다');
  });
});

// 수백 줄을 그린다 — member 줄마다 위임 칸이 셋이 되어(P15) 커버리지 계측과 함께 돌면 5초를 넘었다. 처음에는 한 시험에만 20초를 줬는데 같은 모양의 형제
// 둘이 api 통합 시험과 함께 돈 날 넘었다(T-074) — 이 묶음 전체에 준다. 뜻은 그대로다
describe('AdminUsersPage — 찾기·거르기·더 보기 (P13 C.6, FR-1450~1452)', { timeout: 20_000 }, () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => user({ id: `u${i}`, username: `user${String(i).padStart(3, '0')}` }));

  it('**처음 100명과 전체 수를 보이고, 더 보기로 끝까지 닿는다** — 예전에는 100명에서 조용히 끊겼다', async () => {
    rows = many(250);
    renderPage();
    await screen.findByText('user000');
    expect(screen.getByText('전체 250명 · 100명 보는 중')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }));
    await screen.findByText('user199');
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }));
    await screen.findByText('user249');
    expect(screen.getByText('전체 250명 · 250명 보는 중')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '더 보기' })).toBeNull();
    expect(calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/users?')).map((c) => new URL(c.url, 'http://t').searchParams.get('offset'))).toEqual(['0', '100', '200']);
  });

  it('**찾는 말과 상태는 서버에 보낸다** — 받은 100명 안에서 거르지 않는다', async () => {
    rows = [...many(3), user({ id: 's1', username: 'gone', status: 'suspended' })];
    renderPage();
    await screen.findByText('user000');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'user001' } });
    await waitFor(() => expect(screen.queryByText('user000')).toBeNull());
    expect(screen.getByText('user001')).toBeTruthy();
    expect(calls.some((c) => c.url.includes('q=user001'))).toBe(true);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: '상태' }), { target: { value: 'suspended' } });
    await screen.findByText('gone');
    await waitFor(() => expect(screen.queryByText('user001')).toBeNull());
    expect(calls.some((c) => c.url.includes('status=suspended'))).toBe(true);
  });

  it('**더 보기가 새 찾기와 엉키지 않는다** — 새 찾기가 오는 중에 눌러도 옛 목록 뒤에 새 조건의 조각을 붙이거나 새 찾기를 버리지 않는다 (병합 전 코드 리뷰 10)', async () => {
    rows = many(250);
    const base = globalThis.fetch;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let searching = false;
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('q=user2')) {
        searching = true;
        await held;
      }
      return base(input as RequestInfo, init);
    }) as unknown as typeof fetch;
    renderPage();
    await screen.findByText('user000');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'user2' } });
    await waitFor(() => expect(searching).toBe(true)); // 새 찾기가 오는 중이다
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }));
    await screen.findByText('user100'); // 보이는 목록의 조건(찾는 말 없음)으로 이어 받았다
    release();
    await screen.findByText('전체 50명 · 50명 보는 중');
    expect(screen.queryByText('user000')).toBeNull();
    expect(screen.queryByText('user100')).toBeNull();
    expect(screen.getByText('user249')).toBeTruthy();
  });

  it('**조치 뒤에는 보던 만큼 다시 읽는다** — 처음 100명으로 돌아가 뒤쪽에서 정지한 사람이 화면에서 사라지지 않게 (병합 전 코드 리뷰 10)', async () => {
    rows = many(150);
    renderPage();
    await screen.findByText('user000');
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }));
    await screen.findByText('user149');
    const stop = Array.from(screen.getByText('user120').closest('tr')!.querySelectorAll('button')).find((b) => b.textContent === '정지')!;
    await waitFor(() => expect(stop.disabled).toBe(false));
    fireEvent.click(stop);
    await reply('멈춘다');
    await waitFor(() => expect(Array.from(screen.getByText('user120').closest('tr')!.querySelectorAll('button')).some((b) => b.textContent === '정지 해제')).toBe(true));
    const lastList = calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/users?')).at(-1)!;
    expect(new URL(lastList.url, 'http://t').searchParams.get('limit')).toBe('150');
    expect(screen.getByText('전체 150명 · 150명 보는 중')).toBeTruthy();
  });

  it('상태는 한국어로 보인다 — 배지의 뜻 색은 승인 대기 ○ · 활성 ✓ · 잠김·정지 ⊘ (J.5.8)', async () => {
    rows = [
      user({ id: 'p1', username: 'wait', status: 'pending' }),
      user({ id: 's1', username: 'gone', status: 'suspended' }),
      user({ id: 'a2', username: 'fine' }),
      user({ id: 'l1', username: 'shut', status: 'locked' }),
    ];
    renderPage();
    await screen.findByText('wait');
    const badges = Array.from(document.querySelectorAll('td .badge')).map((b) => [b.textContent, b.className]);
    expect(badges).toEqual([
      ['승인 대기', 'badge wait'],
      ['정지', 'badge fail'],
      ['활성', 'badge ok'],
      ['잠김', 'badge fail'],
    ]);
  });

  it('**찾는 사람이 없으면 표 안에 한 줄로 말한다** — 건수는 거르기 줄 오른쪽 끝에', async () => {
    rows = many(2);
    renderPage();
    await screen.findByText('user000');
    fireEvent.change(screen.getByRole('searchbox', { name: '찾기' }), { target: { value: 'nobody' } });
    await screen.findByText('찾는 조건에 맞는 사람이 없다.');
    expect(screen.getByText('전체 0명 · 0명 보는 중').closest('form')!.getAttribute('role')).toBe('search');
  });
});

describe('AdminUsersPage — 정지 (P13 C.5, FR-1441)', () => {
  it('**묻고 정지한다** — 확인 대화가 누구를 멈추는지와 끊기는 것을 말하고, 그 행은 정지 해제로 바뀐다 (J.5.10)', async () => {
    renderPage();
    await screen.findByText('alice');
    const stop = rowButton('alice', '정지')!;
    // 정지는 위험 단추다 (J.5.2)
    expect(stop.className).toBe('danger sm');
    await waitFor(() => expect(stop.disabled).toBe(false));
    fireEvent.click(stop);
    const dialog = await screen.findByRole('dialog', { name: '이 사용자를 정지할까요?' });
    expect(dialog.textContent).toContain('x(alice)님을 정지한다. 세션과 편집 연결이 그 자리에서 끊긴다.');
    // 잘못 누른 Enter가 정지가 되지 않게 — 처음 초점은 그만두기, 확정은 위험 단추이고 줄의 "정지"를 품지 않는다
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '그만두기' }));
    expect(within(dialog).getByRole('button', { name: '멈춘다' }).className).toBe('danger solid');
    expect(within(dialog).queryByRole('button', { name: /정지/ })).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/suspend'))).toBe(false);
    await reply('멈춘다');
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/users/m1/suspend')).toBe(true));
    await waitFor(() => expect(rowButton('alice', '정지 해제')).toBeTruthy());
    expect(screen.getByRole('status').textContent).toBe('x님을 정지했다.');
  });

  it('묻는 말에 그만두면 보내지 않는다', async () => {
    renderPage();
    await screen.findByText('alice');
    const stop = rowButton('alice', '정지')!;
    await waitFor(() => expect(stop.disabled).toBe(false));
    fireEvent.click(stop);
    await reply('그만두기');
    expect(calls.some((c) => c.url.endsWith('/suspend'))).toBe(false);
    expect(rowButton('alice', '정지')).toBeTruthy();
  });

  it('**자기 자신은 정지하지 못한다** — 그 행의 정지는 눌리지 않는다', async () => {
    rows = [user({ id: 'r1', username: 'root', role: 'root' }), user({ id: 'm1', username: 'alice' })];
    renderPage();
    await screen.findByText('alice');
    await waitFor(() => expect(calls.some((c) => c.url === '/api/auth/me')).toBe(true));
    const mine = rowButton('root', '정지')!;
    await waitFor(() => expect(mine.title).toMatch(/자기 자신/));
    expect(mine.disabled).toBe(true);
    // 누를 수 없는 까닭은 글로도 보인다 (J.5.2) — 그 줄에만
    expect(screen.getAllByText('root').find((el) => el.tagName === 'TD')!.closest('tr')!.textContent).toContain('자기 자신은 정지할 수 없다');
    expect(screen.getByText('alice').closest('tr')!.textContent).not.toContain('자기 자신은 정지할 수 없다');
  });
});

describe('AdminUsersPage — 화면 체계 (P17 J.6 관리 다섯)', () => {
  it('**역할 고르기의 글은 "한글 (코드)"이고 값은 코드 그대로다** (J.9-9)', async () => {
    renderPage();
    const role = (await screen.findByRole('combobox', { name: 'alice 역할' })) as HTMLSelectElement;
    expect([...role.options].map((o) => [o.value, o.textContent])).toEqual([
      ['root', '시스템 관리자 (root)'],
      ['admin', '관리자 (admin)'],
      ['member', '일반 사용자 (member)'],
    ]);
    expect(role.value).toBe('member');
  });

  it('**비밀번호 초기화는 한 번 묻는다** — 세션이 끊기고 임시 값이 한 번 보인다는 것과 본인 확인. 그만두면 보내지 않는다 (병합 전 검토 22)', async () => {
    renderPage();
    await screen.findByText('alice');
    const reset = rowButton('alice', '비밀번호 초기화')!;
    await waitFor(() => expect(reset.disabled).toBe(false));
    fireEvent.click(reset);
    const dialog = await screen.findByRole('dialog', { name: '이 사용자의 비밀번호를 초기화할까요?' });
    expect(dialog.textContent).toContain('x(alice)님의 비밀번호를 임시 값으로 바꾼다. 세션과 편집 연결이 그 자리에서 끊기고, 임시 비밀번호는 이 화면에 한 번만 보인다.');
    expect(dialog.textContent).toContain('본인이 요청했는지 먼저 확인한다');
    // 확정 단추는 줄의 단추 이름을 품지 않는다 — 시험이 둘을 헷갈리지 않게(J.5.10)
    expect(within(dialog).getByRole('button', { name: '새로 만든다' }).className).toBe('danger solid');
    expect(within(dialog).queryByRole('button', { name: /초기화/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '그만두기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.filter((c) => c.url.endsWith('/reset-password'))).toEqual([]);
    expect(screen.queryByText('임시 비밀번호')).toBeNull();
  });

  it('**임시 비밀번호는 한 번 보이고 닫으면 사라진다** — 초기화는 위험 단추다', async () => {
    renderPage();
    await screen.findByText('alice');
    const reset = rowButton('alice', '비밀번호 초기화')!;
    expect(reset.className).toBe('danger sm');
    await waitFor(() => expect(reset.disabled).toBe(false));
    fireEvent.click(reset);
    const dialog = await screen.findByRole('dialog', { name: '이 사용자의 비밀번호를 초기화할까요?' });
    fireEvent.click(within(dialog).getByRole('button', { name: '새로 만든다' }));
    const note = (await screen.findByText('임시 비밀번호')).closest('.notice')!;
    expect(note.getAttribute('role')).toBe('note');
    expect(note.textContent).toContain('alice');
    expect(note.querySelector('pre code')!.textContent).toBe('Tmp-합성-0001');
    expect(within(note as HTMLElement).getByText('이 값은 다시 볼 수 없다. 지금 전달한다.')).toBeTruthy();
    fireEvent.click(within(note as HTMLElement).getByRole('button', { name: '닫기' }));
    expect(screen.queryByText('임시 비밀번호')).toBeNull();
  });

  it('**권한이 없으면 같은 틀에 알림띠만** — 거르기 줄과 표를 그리지 않는다', async () => {
    listStatus = 403;
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toContain('권한이 없다');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('사용자 관리');
    expect(screen.queryByRole('search')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('불러오는 중…')).toBeNull();
  });
});
