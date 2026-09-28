// @vitest-environment happy-dom
import { SPACE_LIST_MAX, type CategoryView, type MeView, type SpaceView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../auth';
import { SEARCH_DELAY_MS } from '../../timing';
import { confirmSuspendText, confirmTakeoverText } from '../../components/SpaceManage';
import { AdminSpacesPage } from './AdminSpacesPage';

/**
 * 컴포넌트 시험 — 관리 콘솔의 스페이스 (P14_설계서_Spaces D.3, FR-1513~1515 · P15_설계서_Grants D.5). **찾기와 상태는 서버에 보낸다**(`q`·`status`) —
 * 화면에서 거르지 않는다. 늦게 온 옛 응답은 버린다. 줄의 조치는 응답의 `access`대로. 분류의 이름 바꾸기·지우기도 응답의 `access`대로이고, 지우기는
 * 몇 개가 분류 없음이 되는지 묻는다. 스페이스 관리 전체·분류 관리를 받은 member도 연다. 서버는 가짜 `fetch`다
 */

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let me: MeView;
let spaces: SpaceView[];
let categories: CategoryView[];
let delay: (url: string) => number = () => 0;
let categoryDelete: { status: number; body: unknown } = { status: 200, body: { ok: true } };
// 이 찾기어를 담은 목록 요청은 실패한다
let failWhen: (url: string) => boolean = () => false;
// 분류 읽기가 실패한다
let categoriesFail = false;
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

const NO = { canRead: true, canWrite: false, canManageMembers: false, canEditInfo: false, canChangeStatus: false, canDelete: false, isOwner: false };
const category = (over: Partial<CategoryView>): CategoryView => ({
  id: 'c1',
  name: '운영',
  createdBy: 'u9',
  createdAt: '2026-09-27T00:00:00.000Z',
  access: { canRename: true, canDelete: true },
  usage: { spaces: 0, otherSpaces: 0 },
  ...over,
});
const space = (over: Partial<SpaceView>): SpaceView => ({
  id: 's',
  key: 'KEY',
  name: 's',
  description: '',
  kind: 'team',
  status: 'active',
  suspendedByOwner: false,
  categoryId: null,
  categoryName: null,
  createdBy: 'u1',
  createdByUsername: 'owner',
  memberCount: 3,
  myRole: null,
  access: { ...NO, canWrite: true, canManageMembers: true, canEditInfo: true, canChangeStatus: true },
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  calls = [];
  delay = () => 0;
  categoryDelete = { status: 200, body: { ok: true } };
  failWhen = () => false;
  categoriesFail = false;
  me = { id: 'a1', username: 'boss', displayName: '관리자', role: 'admin', mustChangePassword: false, grants: [], hasPassword: true };
  spaces = [
    space({ id: 's1', key: 'OPS1', name: '운영팀' }),
    space({ id: 's2', key: 'DEV1', name: '개발팀', status: 'suspended', access: { ...NO, canChangeStatus: true, canDelete: true } }),
  ];
  categories = [category({})];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined });
    const answer = (r: Response) => new Promise<Response>((ok) => setTimeout(() => ok(r), delay(url)));
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (method === 'GET' && url.startsWith('/api/spaces?')) {
      if (failWhen(url)) return answer(json(500, { message: '잠시 뒤 다시 한다' }));
      const p = new URL(url, 'http://t').searchParams;
      const q = p.get('q') ?? '';
      const status = p.get('status');
      return answer(json(200, spaces.filter((s) => (!q || s.name.includes(q) || s.key.includes(q)) && (!status || s.status === status))));
    }
    if (method === 'GET' && url === '/api/categories') return answer(categoriesFail ? json(500, { message: '분류를 읽지 못했다' }) : json(200, categories));
    // 같은 이름이 있으면 서버는 있던 것을 돌려준다(`CategoriesController.create`)
    if (method === 'POST' && url === '/api/categories') {
      const name = (JSON.parse(init!.body as string) as { name: string }).name;
      const found = categories.find((c) => c.name === name);
      if (found) return answer(json(200, found));
      const made = category({ id: `c${categories.length + 1}`, name, createdBy: me.id });
      categories = [...categories, made];
      return answer(json(201, made));
    }
    if (method === 'DELETE' && url.startsWith('/api/categories/')) return answer(json(categoryDelete.status, categoryDelete.body));
    return answer(json(200, {}));
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
        <AdminSpacesPage />
      </AuthProvider>
    </MemoryRouter>,
  );
const listCalls = () => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/spaces?')).map((c) => c.url);
const table = () => screen.getByRole('table', { name: '모든 스페이스' });
/** 그 스페이스 줄의 단추들 */
const rowButtons = (name: string) =>
  within(within(table()).getByRole('link', { name }).closest('tr')!).queryAllByRole('button').map((b) => b.textContent);
const writes = () => calls.filter((c) => c.method !== 'GET');

describe('AdminSpacesPage — 모든 스페이스', () => {
  it('**모든 스페이스를 상한만큼 받는다** — `scope=all`, `limit`은 공유 상수', async () => {
    renderPage();
    await screen.findByRole('link', { name: '운영팀' });
    expect(listCalls()).toEqual([`/api/spaces?scope=all&limit=${SPACE_LIST_MAX}`]);
    expect(screen.getByRole('link', { name: '개발팀' })).toBeTruthy();
  });

  it('**찾기와 상태는 서버에 보낸다** — 화면에서 거르지 않는다(상한 밖을 찾으려면)', async () => {
    renderPage();
    await screen.findByRole('link', { name: '운영팀' });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '개발' } });
    fireEvent.change(screen.getByLabelText('상태'), { target: { value: 'suspended' } });
    await waitFor(() => expect(listCalls().at(-1)).toBe(`/api/spaces?scope=all&limit=${SPACE_LIST_MAX}&q=%EA%B0%9C%EB%B0%9C&status=suspended`));
    await waitFor(() => expect(screen.queryByRole('link', { name: '운영팀' })).toBeNull());
  });

  it('**늦게 온 옛 응답은 버린다** — 마지막 찾기만 받는다', async () => {
    renderPage();
    await screen.findByRole('link', { name: '운영팀' });
    // 첫 찾기('운영')는 늦게, 둘째('개발')는 곧바로 온다
    delay = (url) => (url.includes('q=%EC%9A%B4%EC%98%81') ? 600 : 0);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '운영' } });
    await waitFor(() => expect(listCalls().some((u) => u.includes('q=%EC%9A%B4%EC%98%81'))).toBe(true));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '개발' } });
    await screen.findByRole('link', { name: '개발팀' });
    await new Promise((r) => setTimeout(r, 800));
    expect(screen.queryByRole('link', { name: '운영팀' })).toBeNull();
  });

  it('**줄의 조치는 access대로** — 활성은 중지(묻는다), 중지된 것은 다시 쓰기·지우기(묻는다)', async () => {
    // happy-dom에는 `confirm`이 없다 — 브라우저처럼 둔다
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    renderPage();
    await screen.findByRole('link', { name: '운영팀' });
    // 표 안만 센다 — 아래 분류 칸에도 지우기가 있다
    expect(rowButtons('운영팀')).toEqual(['중지']);
    expect(rowButtons('개발팀')).toEqual(['다시 쓰기', '지우기']);
    fireEvent.click(within(table()).getByRole('button', { name: '중지' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    fireEvent.click(within(table()).getByRole('button', { name: '다시 쓰기' }));
    fireEvent.click(within(table()).getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(writes()).toHaveLength(3));
    expect(writes()).toEqual([
      { method: 'PATCH', url: '/api/spaces/s1/status', body: { status: 'suspended' } },
      { method: 'PATCH', url: '/api/spaces/s2/status', body: { status: 'active' } },
      { method: 'DELETE', url: '/api/spaces/s2', body: undefined },
    ]);
    expect(confirm).toHaveBeenCalledTimes(2); // 중지·지우기 — 다시 쓰기는 묻지 않는다
    // 중지를 묻는 말은 스페이스 화면의 관리 칸과 같다
    expect(confirm).toHaveBeenNthCalledWith(1, confirmSuspendText('운영팀'));
  });

  it('**줄의 조치는 access대로** — 관리할 수 없는 줄에는 단추가 없다', async () => {
    spaces = [space({ id: 's1', key: 'OPS1', name: '운영팀', access: NO })];
    renderPage();
    await screen.findByRole('link', { name: '운영팀' });
    expect(rowButtons('운영팀')).toEqual([]);
  });

  it('**찾기가 다시 되면 앞선 실패의 알림은 지운다**', async () => {
    failWhen = (url) => !url.includes('q=');
    renderPage();
    // 시험에서는 누구인지 알기 전에 거절 글이 잠깐 보인다(앱에서는 `RequireAuth`가 기다린다) — 까닭의 글로 기다린다
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('잠시 뒤 다시 한다'));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '개발' } });
    await screen.findByRole('link', { name: '개발팀' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('**찾기가 돼도 분류 칸의 실패는 남는다** — 목록의 실패만 지운다(하나로 두면 찾기가 될 때 상관없는 실패까지 지웠다 — 반영분 점검 5)', async () => {
    categoriesFail = true;
    renderPage();
    await screen.findByRole('link', { name: '운영팀' });
    expect(screen.getByRole('alert').textContent).toContain('분류를 읽지 못했다');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '개발' } });
    await screen.findByRole('link', { name: '개발팀' });
    await waitFor(() => expect(screen.queryByRole('link', { name: '운영팀' })).toBeNull());
    expect(screen.getByRole('alert').textContent).toContain('분류를 읽지 못했다');
  });

  it('**늦게 온 옛 찾기의 실패도 버린다** — 마지막 찾기가 됐으면 알리지 않는다', async () => {
    renderPage();
    await screen.findByRole('link', { name: '운영팀' });
    // 첫 찾기('운영')는 늦게 실패하고, 둘째('개발')는 곧바로 된다
    failWhen = (url) => url.includes('q=%EC%9A%B4%EC%98%81');
    delay = (url) => (url.includes('q=%EC%9A%B4%EC%98%81') ? 600 : 0);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '운영' } });
    await waitFor(() => expect(listCalls().some((u) => u.includes('q=%EC%9A%B4%EC%98%81'))).toBe(true));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '개발' } });
    await screen.findByRole('link', { name: '개발팀' });
    await new Promise((r) => setTimeout(r, 800));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it(`**상한(${SPACE_LIST_MAX}개)을 채우면 찾기로 좁히라고 말한다**`, async () => {
    spaces = Array.from({ length: SPACE_LIST_MAX }, (_, i) => space({ id: `s${i}`, key: `K${i}`, name: `스페이스 ${i}` }));
    renderPage();
    expect(await screen.findByText(new RegExp(`${SPACE_LIST_MAX}개까지 보인다`))).toBeTruthy();
  });

  it('관리 권한이 없으면 목록도 분류도 부르지 않는다', async () => {
    me = { ...me, role: 'member' };
    renderPage();
    expect(await screen.findByText('권한이 없다 — 스페이스 관리는 관리자와, 관리자가 스페이스 관리 전체나 분류 관리를 맡긴 사람이 한다.')).toBeTruthy();
    // 이 글은 누구인지 알기 전에도 보인다 — 누구인지 안 뒤, 찾기를 기다리는 시간이 지나도 부르지 않는지 본다
    await waitFor(() => expect(calls.some((c) => c.url === '/api/auth/me')).toBe(true));
    await new Promise((r) => setTimeout(r, SEARCH_DELAY_MS + 200));
    expect(calls.map((c) => c.url)).toEqual(['/api/auth/me']);
  });
});

describe('AdminSpacesPage — 분류', () => {
  it('**만들고 이름을 바꾼다** — 이름이 그대로면 바꾸기를 누를 수 없다', async () => {
    renderPage();
    const box = (await screen.findByLabelText('분류 운영 이름')) as HTMLInputElement;
    expect((screen.getByRole('button', { name: '이름 바꾸기' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: '운영·지원' } });
    fireEvent.click(screen.getByRole('button', { name: '이름 바꾸기' }));
    fireEvent.change(screen.getByLabelText('새 분류'), { target: { value: '개발' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()).toEqual([
      { method: 'PATCH', url: '/api/categories/c1', body: { name: '운영·지원' } },
      { method: 'POST', url: '/api/categories', body: { name: '개발' } },
    ]);
    expect((await screen.findByRole('status')).textContent).toBe('분류 "개발"을(를) 만들었다.');
    await screen.findByLabelText('분류 개발 이름');
  });

  it('**만들기를 두 번 눌러도 한 번 보낸다** — 앞의 것이 끝날 때까지 받지 않는다(반영분 점검 11)', async () => {
    delay = (url) => (url === '/api/categories' ? 200 : 0);
    renderPage();
    await screen.findByLabelText('분류 운영 이름');
    fireEvent.change(screen.getByLabelText('새 분류'), { target: { value: '개발' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByLabelText('분류 개발 이름');
    expect(writes().filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('**이미 있는 이름이면 "만들었다"고 하지 않는다** — 서버는 있던 것을 돌려준다', async () => {
    renderPage();
    await screen.findByLabelText('분류 운영 이름');
    fireEvent.change(screen.getByLabelText('새 분류'), { target: { value: '운영' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    expect((await screen.findByRole('status')).textContent).toBe('분류 "운영"은(는) 이미 있다.');
    expect(screen.getAllByLabelText(/^분류 .+ 이름$/)).toHaveLength(1);
  });

  it('**지우기는 몇 개가 분류 없음이 되는지 묻는다** — 지우면 그렇게 알리고 목록을 다시 읽는다 (P15 FR-1622·1624)', async () => {
    categories = [category({ usage: { spaces: 2, otherSpaces: 1 } })];
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    renderPage();
    await screen.findByLabelText('분류 운영 이름');
    expect(screen.getByText('공간 2개 (만든 사람의 것이 아닌 공간 1개)')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('list', { name: '분류 목록' })).getByRole('button', { name: '지우기' }));
    // 글자 그대로 본다 — 같은 함수로 만든 말과 견주면 그 함수가 틀려도 참이다(돌연변이 W4가 빠져나갔다)
    expect(confirm).toHaveBeenCalledWith('분류 "운영"을(를) 지운다. 이 분류를 쓰는 공간 2개(휴지통 포함)가 "분류 없음"이 된다. 되살릴 수 없다 — 어느 공간이었는지는 감사로그에 남는다.');
    expect((await screen.findByRole('status')).textContent).toBe('분류 "운영"을(를) 지웠다 — 쓰던 공간 2개는 분류 없음이 됐다.');
    expect(writes()).toEqual([{ method: 'DELETE', url: '/api/categories/c1', body: undefined }]);
  });

  it('서버가 거절하면 그 까닭을 보인다', async () => {
    window.confirm = vi.fn(() => true);
    categoryDelete = { status: 403, body: { message: "남의 공간이 쓰는 분류는 관리자나 '분류 관리'를 받은 사람이 지운다" } };
    renderPage();
    await screen.findByLabelText('분류 운영 이름');
    fireEvent.click(within(screen.getByRole('list', { name: '분류 목록' })).getByRole('button', { name: '지우기' }));
    expect((await screen.findByRole('alert')).textContent).toContain('남의 공간이 쓰는 분류는');
  });

  it('**할 수 없는 분류는 누를 수 없고 까닭이 보인다** — 내가 만들었으면 남의 공간이 써서, 아니면 만든 사람이 아니어서 (FR-1621)', async () => {
    me = { ...me, id: 'm1', role: 'member', grants: ['space.oversee'] };
    categories = [
      category({ id: 'c1', name: '내 것', createdBy: 'm1', access: { canRename: false, canDelete: false }, usage: { spaces: 3, otherSpaces: 1 } }),
      category({ id: 'c2', name: '남의 것', createdBy: 'u9', access: { canRename: false, canDelete: false } }),
    ];
    renderPage();
    const mine = (await screen.findByLabelText('분류 내 것 이름')).closest('li')!;
    const theirs = screen.getByLabelText('분류 남의 것 이름').closest('li')!;
    const del = (li: HTMLElement) => within(li).getByRole('button', { name: '지우기' }) as HTMLButtonElement;
    await waitFor(() => expect(del(mine).title).toBe("남의 공간이 쓰는 분류는 관리자나 '분류 관리'를 받은 사람이 바꾸고 지운다"));
    expect([del(mine).disabled, del(theirs).disabled]).toEqual([true, true]);
    expect(del(theirs).title).toBe('분류는 만든 사람과 관리자가 바꾸고 지운다');
    expect((within(mine).getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('AdminSpacesPage — 넘겨받기·쓰임을 보이는 범위 (P15 병합 전 검토)', () => {
  it('**주인이 건 중지를 넘겨받는다** — 주인이 건 줄에만 단추가 있고, 묻고, 같은 상태를 보낸다', async () => {
    spaces = [
      space({ id: 's1', key: 'OPS1', name: '운영팀', status: 'suspended', suspendedByOwner: true, access: { ...NO, canChangeStatus: true, canDelete: true } }),
      space({ id: 's2', key: 'DEV1', name: '개발팀', status: 'suspended', suspendedByOwner: false, access: { ...NO, canChangeStatus: true, canDelete: true } }),
    ];
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    renderPage();
    await screen.findByRole('link', { name: '운영팀' });
    expect(rowButtons('운영팀')).toEqual(['다시 쓰기', '관리자가 건 중지로 바꾸기', '지우기']);
    expect(rowButtons('개발팀')).toEqual(['다시 쓰기', '지우기']);
    fireEvent.click(within(within(table()).getByRole('link', { name: '운영팀' }).closest('tr')!).getByRole('button', { name: '관리자가 건 중지로 바꾸기' }));
    await waitFor(() => expect(writes()).toEqual([{ method: 'PATCH', url: '/api/spaces/s1/status', body: { status: 'suspended', takeover: true } }]));
    expect(confirm).toHaveBeenCalledWith(confirmTakeoverText('운영팀'));
  });

  it('**거절되면 목록을 다시 읽는다** — 그 사이 누가 바꿨으면 옛 단추가 남아 같은 거절이 되풀이된다. 분류 칸도 같다 (좁은 재검토 10·11)', async () => {
    window.confirm = vi.fn(() => true);
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'PATCH' || method === 'DELETE') {
        calls.push({ method, url: String(input), body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined });
        return Promise.resolve(json(method === 'PATCH' ? 409 : 403, { message: method === 'PATCH' ? '그 사이 누가 상태를 바꿨다 — 다시 본다' : "남의 공간이 쓰는 분류는 관리자나 '분류 관리'를 받은 사람이 지운다" }));
      }
      return base(input as RequestInfo, init);
    }) as unknown as typeof fetch;
    renderPage();
    await screen.findByRole('link', { name: '운영팀' });
    const lists = () => listCalls().length;
    const catReads = () => calls.filter((c) => c.method === 'GET' && c.url === '/api/categories').length;
    const before = lists();
    fireEvent.click(within(table()).getByRole('button', { name: '중지' }));
    expect((await screen.findByRole('alert')).textContent).toContain('그 사이 누가 상태를 바꿨다');
    await waitFor(() => expect(lists()).toBeGreaterThan(before));
    const catBefore = catReads();
    fireEvent.click(within(screen.getByRole('list', { name: '분류 목록' })).getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('남의 공간이 쓰는 분류는'));
    await waitFor(() => expect(catReads()).toBeGreaterThan(catBefore));
  });

  it('**쓰임이 없는 줄은 개수를 말하지 않는다** — 서버는 바꿀 수 있는 사람과 만든 사람에게만 싣는다', async () => {
    me = { ...me, id: 'm1', role: 'member', grants: ['space.oversee'] };
    categories = [category({ id: 'c1', name: '남의 것', createdBy: 'u9', access: { canRename: false, canDelete: false }, usage: null })];
    renderPage();
    const item = (await screen.findByLabelText('분류 남의 것 이름')).closest('li')!;
    expect(item.textContent).not.toMatch(/공간 \d+개/);
  });

  it('**휴지통 안내는 지운 스페이스를 되살릴 수 있는 사람에게만** — 분류 관리만 받은 사람의 휴지통에는 그 칸이 없다 (병합 전 문서 정합성 24)', async () => {
    me = { ...me, id: 'm1', role: 'member', grants: ['category.manage'] };
    renderPage();
    await screen.findByLabelText('분류 운영 이름');
    expect(screen.queryByRole('link', { name: '휴지통' })).toBeNull();
    cleanup();
    me = { ...me, grants: ['space.oversee'] };
    renderPage();
    expect(await screen.findByRole('link', { name: '휴지통' })).toBeTruthy();
  });
});

describe('AdminSpacesPage — 맡긴 권한으로 연다 (P15 D.5)', () => {
  it('**분류 관리만 받은 member** — 분류 칸만 보이고, 모든 스페이스는 부르지 않는다', async () => {
    me = { ...me, id: 'm1', role: 'member', grants: ['category.manage'] };
    renderPage();
    await screen.findByLabelText('분류 운영 이름');
    await new Promise((r) => setTimeout(r, SEARCH_DELAY_MS + 200));
    expect(screen.queryByRole('table', { name: '모든 스페이스' })).toBeNull();
    expect(listCalls()).toEqual([]);
  });

  it('**스페이스 관리 전체를 받은 member** — 모든 스페이스 표가 보인다. 누가 중지했는지도', async () => {
    me = { ...me, id: 'm1', role: 'member', grants: ['space.oversee'] };
    spaces = [
      space({ id: 's1', key: 'OPS1', name: '운영팀', status: 'suspended', suspendedByOwner: true, access: { ...NO, canChangeStatus: true } }),
      space({ id: 's2', key: 'DEV1', name: '개발팀', status: 'suspended', suspendedByOwner: false, access: { ...NO, canChangeStatus: true, canDelete: true } }),
    ];
    renderPage();
    await screen.findByRole('link', { name: '운영팀' });
    const row = (name: string) => within(table()).getByRole('link', { name }).closest('tr')!;
    expect(within(row('운영팀')).getByText('주인이 걸었다')).toBeTruthy();
    expect(within(row('개발팀')).getByText('관리자가 걸었다')).toBeTruthy();
    expect(rowButtons('개발팀')).toEqual(['다시 쓰기', '지우기']);
  });

  it('다른 위임(관리자가 건 중지 풀기)만으로는 열지 못한다', async () => {
    me = { ...me, id: 'm1', role: 'member', grants: ['space.unsuspend'] };
    renderPage();
    expect(await screen.findByText(/권한이 없다 — 스페이스 관리는/)).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/auth/me')).toBe(true));
    await new Promise((r) => setTimeout(r, SEARCH_DELAY_MS + 200));
    expect(calls.map((c) => c.url)).toEqual(['/api/auth/me']);
  });
});
