// @vitest-environment happy-dom
import type { CategoryView, SpaceView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmDeleteCategoryText } from './CategoryList';
import { SpaceManage, confirmSuspendText, confirmTakeoverText } from './SpaceManage';

/**
 * 컴포넌트 시험 — 스페이스 화면의 관리 칸 (P14_설계서_Spaces D.3, FR-1510·1511 · P15_설계서_Grants D.5). 보이는 조건은 응답의 `access`다 — 화면은
 * 규칙을 다시 만들지 않는다. 중지와 지우기는 한 번 더 묻는다. 새 분류는 고른 상태가 되고 저장해야 붙는다. 서버는 가짜 `fetch`다
 */

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

const NO = { canRead: true, canWrite: false, canManageMembers: false, canEditInfo: false, canChangeStatus: false, canDelete: false, isOwner: false, crewFrozen: false };
const category = (over: Partial<CategoryView>): CategoryView => ({
  id: 'c1',
  name: '운영',
  createdBy: 'u9',
  createdAt: '2026-09-27T00:00:00.000Z',
  access: { canRename: false, canDelete: false },
  usage: { spaces: 0, otherSpaces: 0 },
  ...over,
});
let categories: CategoryView[] = [];
const space = (over: Partial<SpaceView> = {}): SpaceView => ({
  id: 's1',
  key: 'ABCD',
  name: '운영팀',
  description: '운영 문서',
  kind: 'team',
  status: 'active',
  suspendedByOwner: false,
  categoryId: null,
  categoryName: null,
  createdBy: 'u1',
  createdByUsername: 'owner',
  memberCount: 2,
  myRole: 'owner',
  access: { ...NO, canWrite: true, canManageMembers: true, canEditInfo: true, canChangeStatus: true, isOwner: true },
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  calls = [];
  answer = { status: 200, body: {} };
  categories = [category({})];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body });
    if (method === 'GET' && url === '/api/categories') return Promise.resolve(json(200, categories));
    // 같은 이름이면 서버는 있던 것을 돌려준다(`CategoriesController.create`)
    if (method === 'POST' && url === '/api/categories') {
      const { name } = body as { name: string };
      const found = categories.find((c) => c.name === name);
      if (found) return Promise.resolve(json(200, found));
      const made = category({ id: `c${categories.length + 1}`, name, createdBy: 'u1', access: { canRename: true, canDelete: true } });
      categories = [...categories, made];
      return Promise.resolve(json(201, made));
    }
    return Promise.resolve(json(answer.status, answer.body));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const writes = () => calls.filter((c) => c.method !== 'GET');

describe('SpaceManage — 보이는 조건은 access', () => {
  it('관리할 수도 지울 수도 없으면 칸이 없다 — 분류도 읽지 않는다', async () => {
    const { container } = render(<SpaceManage meId="u1" space={space({ access: NO })} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    expect(container.textContent).toBe('');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([]);
  });

  it('**부모가 같은 값으로 다시 읽어도 치던 것은 남는다** — 서버의 값이 바뀌었을 때만 칸을 맞춘다', async () => {
    const { rerender } = render(<SpaceManage meId="u1" space={space()} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: '치는 중' } });
    fireEvent.change(screen.getByLabelText('설명'), { target: { value: '적는 중' } });
    // Crew를 바꾸면 스페이스 화면이 스페이스를 다시 읽는다 — 값은 같고 객체만 새것이다
    rerender(<SpaceManage meId="u1" space={space()} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    expect((screen.getByLabelText('이름') as HTMLInputElement).value).toBe('치는 중');
    expect((screen.getByLabelText('설명') as HTMLTextAreaElement).value).toBe('적는 중');
    // 서버의 값이 바뀌면(누가 이름을 바꿨다) 그것을 보인다
    rerender(<SpaceManage meId="u1" space={space({ name: '운영지원팀' })} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    expect((screen.getByLabelText('이름') as HTMLInputElement).value).toBe('운영지원팀');
    await screen.findByRole('option', { name: '운영' });
  });

  it('**이름·설명·분류를 저장한다** — 분류를 고르지 않으면 `null`', async () => {
    const onChanged = vi.fn();
    render(<SpaceManage meId="u1" space={space()} onChanged={onChanged} onDeleted={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: '운영팀 (새 이름)' } });
    await screen.findByRole('option', { name: '운영' });
    fireEvent.change(screen.getByLabelText('분류'), { target: { value: 'c1' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(writes()).toEqual([{ method: 'PATCH', url: '/api/spaces/s1', body: { name: '운영팀 (새 이름)', description: '운영 문서', categoryId: 'c1' } }]);
  });

  it('분류를 고르지 않으면 `null`로 보낸다 — 빈 글자는 분류 id가 아니다', async () => {
    const onChanged = vi.fn();
    render(<SpaceManage meId="u1" space={space({ categoryId: 'c1', categoryName: '운영' })} onChanged={onChanged} onDeleted={vi.fn()} />);
    await screen.findByRole('option', { name: '운영' });
    fireEvent.change(screen.getByLabelText('분류'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(writes()[0].body).toEqual({ name: '운영팀', description: '운영 문서', categoryId: null });
  });

  it('**중지는 한 번 더 묻는다** — 아니라고 하면 보내지 않는다', async () => {
    // happy-dom에는 `confirm`이 없다 — 브라우저처럼 둔다
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    window.confirm = confirm;
    const onChanged = vi.fn();
    render(<SpaceManage meId="u1" space={space()} onChanged={onChanged} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '중지' }));
    expect(writes()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '중지' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledTimes(2);
    // 열어 둔 편집 창이 곧바로가 아니라 몇 분 안에 끊긴다고 말한다(주기 재판정)
    expect(confirm).toHaveBeenCalledWith(confirmSuspendText('운영팀'));
    expect(confirmSuspendText('운영팀')).toContain('열어 둔 편집 창은 몇 분 안에 끊긴다');
    expect(writes()).toEqual([{ method: 'PATCH', url: '/api/spaces/s1/status', body: { status: 'suspended' } }]);
  });

  it('**중지된 스페이스** — 이름·설명·분류는 막히고 다시 쓰기는 묻지 않고 보낸다', async () => {
    const onChanged = vi.fn();
    render(
      <SpaceManage
        meId="u1"
        space={space({ status: 'suspended', suspendedByOwner: true, access: { ...NO, canEditInfo: true, canChangeStatus: true, isOwner: true } })}
        onChanged={onChanged}
        onDeleted={vi.fn()}
      />,
    );
    expect(screen.getByRole('note').textContent).toBe('주인이 중지한 스페이스다.');
    expect((screen.getByLabelText('이름') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '저장' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '다시 쓰기' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(writes()).toEqual([{ method: 'PATCH', url: '/api/spaces/s1/status', body: { status: 'active' } }]);
  });

  it('**지우기는 `canDelete`일 때만, 한 번 더 묻고** 지우면 목록으로 간다', async () => {
    window.confirm = vi.fn(() => true);
    const onDeleted = vi.fn();
    const { unmount } = render(<SpaceManage meId="u1" space={space()} onChanged={vi.fn()} onDeleted={onDeleted} />);
    expect(screen.queryByRole('button', { name: '지우기' })).toBeNull();
    expect(screen.getByText(/지우기는 활성 스페이스에서 Crew가 본인뿐인 주인/)).toBeTruthy();
    unmount();
    render(<SpaceManage meId="u1" space={space({ access: { ...NO, canEditInfo: true, canChangeStatus: true, canDelete: true, isOwner: true } })} onChanged={vi.fn()} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(writes()).toEqual([{ method: 'DELETE', url: '/api/spaces/s1', body: undefined }]);
  });

  it('서버가 거절하면 그 까닭을 보인다', async () => {
    answer = { status: 403, body: { message: '스페이스 정보를 바꿀 권한이 없다' } };
    const onChanged = vi.fn();
    render(<SpaceManage meId="u1" space={space()} onChanged={onChanged} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect((await screen.findByRole('alert')).textContent).toContain('스페이스 정보를 바꿀 권한이 없다');
    // 성공이라 하지 않는다. 지금 상태는 다시 읽는다 — 그 사이 권한이 바뀌었을 수 있다 (P15 병합 전 코드 리뷰 12)
    expect(screen.queryByRole('status')).toBeNull();
    expect(onChanged).toHaveBeenCalled();
  });
});

describe('SpaceManage — 관리자가 건 중지 (P15 C.2, FR-1612)', () => {
  it('**풀지 못하는 주인에게도 칸이 보이고 까닭을 말한다** — 다시 쓰기 단추는 없다', async () => {
    render(
      <SpaceManage
        meId="u1"
        space={space({ status: 'suspended', suspendedByOwner: false, access: { ...NO, canEditInfo: true, isOwner: true } })}
        onChanged={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    const note = screen.getByRole('note').textContent ?? '';
    expect(note).toContain('관리자가 중지한 스페이스다.');
    expect(note).toContain('주인도 다시 쓰기로 풀지 못한다');
    expect(note).toContain('관리자가 건 중지 풀기');
    expect(screen.queryByRole('button', { name: '다시 쓰기' })).toBeNull();
    expect((screen.getByLabelText('이름') as HTMLInputElement).disabled).toBe(true);
  });

  it('**풀 수 있으면 까닭 대신 단추** — 관리자가 건 중지라도 권한을 받은 주인', async () => {
    render(
      <SpaceManage
        meId="u1"
        space={space({ status: 'suspended', suspendedByOwner: false, access: { ...NO, canEditInfo: true, canChangeStatus: true, isOwner: true } })}
        onChanged={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    expect(screen.getByRole('note').textContent).toBe('관리자가 중지한 스페이스다.');
    expect(screen.getByRole('button', { name: '다시 쓰기' })).toBeTruthy();
  });

  it('**스페이스 관리 전체만 가진 사람** — 이름·분류 칸 없이 중지만 (P15 A.1-1)', async () => {
    render(<SpaceManage meId="u1" space={space({ access: { ...NO, canChangeStatus: true } })} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    expect(screen.queryByLabelText('이름')).toBeNull();
    expect(screen.getByRole('button', { name: '중지' })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    // 분류를 바꿀 수 없으니 분류도 읽지 않는다
    expect(calls.filter((c) => c.url === '/api/categories')).toEqual([]);
  });
});

describe('SpaceManage — 새 분류·분류 관리 (P15 C.3, FR-1620~1624)', () => {
  it('**새 분류를 만들면 고른 상태가 되고, 저장을 눌러야 붙는다** (A.1-8)', async () => {
    const onChanged = vi.fn();
    render(<SpaceManage meId="u1" space={space()} onChanged={onChanged} onDeleted={vi.fn()} />);
    await screen.findByRole('option', { name: '운영' });
    fireEvent.change(screen.getByLabelText('새 분류'), { target: { value: '재무' } });
    fireEvent.click(screen.getByRole('button', { name: '분류 만들기' }));
    await waitFor(() => expect((screen.getByLabelText('분류') as HTMLSelectElement).value).toBe('c2'));
    expect((await screen.findByRole('status')).textContent).toBe('분류 "재무"을(를) 만들어 골랐다 — 저장을 누르면 붙는다.');
    expect(writes()).toEqual([{ method: 'POST', url: '/api/categories', body: { name: '재무' } }]);
    expect(onChanged).not.toHaveBeenCalled();
    const reads = calls.filter((c) => c.url === '/api/categories' && c.method === 'GET').length;
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(writes().at(-1)).toEqual({ method: 'PATCH', url: '/api/spaces/s1', body: { name: '운영팀', description: '운영 문서', categoryId: 'c2' } });
    // 저장하면 쓰임이 바뀐다 — 분류를 다시 읽어 분류 관리의 개수와 지우기 확인이 맞게 (병합 전 코드 리뷰 2)
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/categories' && c.method === 'GET').length).toBe(reads + 1));
  });

  it('**같은 이름이 있으면 있던 것을 고른다** — "만들었다"고 하지 않는다', async () => {
    render(<SpaceManage meId="u1" space={space()} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    await screen.findByRole('option', { name: '운영' });
    fireEvent.change(screen.getByLabelText('새 분류'), { target: { value: '운영' } });
    // 새 분류 칸의 Enter는 저장이 아니라 만들기다
    fireEvent.keyDown(screen.getByLabelText('새 분류'), { key: 'Enter' });
    await waitFor(() => expect((screen.getByLabelText('분류') as HTMLSelectElement).value).toBe('c1'));
    expect((await screen.findByRole('status')).textContent).toBe('있던 분류 "운영"을(를) 골랐다 — 저장을 누르면 붙는다.');
    expect(writes().map((c) => c.method)).toEqual(['POST']);
  });

  it('**분류 관리에는 내가 만들어 바꿀 수 있는 것만** — 관리자가 바꿀 수 있는 남의 분류는 늘어놓지 않는다. 지우기는 몇 개가 분류 없음이 되는지 묻고, 지운 뒤 스페이스를 다시 읽는다 (FR-1621·1624)', async () => {
    categories = [
      category({ access: { canRename: true, canDelete: true } }),
      category({ id: 'c2', name: '내 분류', createdBy: 'u1', access: { canRename: true, canDelete: true }, usage: { spaces: 2, otherSpaces: 0 } }),
      category({ id: 'c3', name: '남이 쓰는 내 분류', createdBy: 'u1', usage: { spaces: 2, otherSpaces: 1 } }),
    ];
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    const onChanged = vi.fn();
    render(<SpaceManage meId="u1" space={space()} onChanged={onChanged} onDeleted={vi.fn()} />);
    await screen.findByLabelText('분류 내 분류 이름');
    expect(screen.queryByLabelText('분류 운영 이름')).toBeNull();
    expect(screen.queryByLabelText('분류 남이 쓰는 내 분류 이름')).toBeNull();
    fireEvent.click(within(screen.getByRole('list', { name: '분류 목록' })).getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledWith(confirmDeleteCategoryText(categories[1]));
    expect(confirmDeleteCategoryText(categories[1])).toContain('이 분류를 쓰는 공간 2개(휴지통 포함)가 "분류 없음"이 된다');
    expect(writes()).toEqual([{ method: 'DELETE', url: '/api/categories/c2', body: undefined }]);
  });

  it('바꿀 수 있는 분류가 없으면 그렇게 말한다 — 분류를 읽은 **뒤에** 본다(읽기 전에도 빈 글이라 늘 참이었다 — 병합 전 코드 리뷰 7)', async () => {
    categories = [category({ access: { canRename: true, canDelete: true } }), category({ id: 'c2', name: '남이 쓰는 내 분류', createdBy: 'u1' })];
    render(<SpaceManage meId="u1" space={space()} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    await screen.findByRole('option', { name: '남이 쓰는 내 분류' });
    expect(screen.getByText(/내가 만들어 이름을 바꾸거나 지울 수 있는 분류가 없다/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: '분류 목록' })).toBeNull();
  });

  it('**고른 채 저장하지 않은 분류가 지워지면 고르지 않은 것으로** — 그대로 저장하면 "없는 분류다"였다. 치던 이름은 분류가 바뀌어도 남는다 (병합 전 코드 리뷰 8)', async () => {
    categories = [category({}), category({ id: 'c2', name: '곧 지움', createdBy: 'u1', access: { canRename: true, canDelete: true } })];
    window.confirm = vi.fn(() => true);
    const { rerender } = render(<SpaceManage meId="u1" space={space({ categoryId: 'c1', categoryName: '운영' })} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    await screen.findByRole('option', { name: '곧 지움' });
    fireEvent.change(screen.getByLabelText('분류'), { target: { value: 'c2' } });
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: '치는 중' } });
    // 분류 관리에서 그 분류를 지운다 — 다시 읽으면 목록에서 빠진다
    categories = [category({})];
    fireEvent.click(within(screen.getByRole('list', { name: '분류 목록' })).getByRole('button', { name: '지우기' }));
    await waitFor(() => expect((screen.getByLabelText('분류') as HTMLSelectElement).value).toBe(''));
    // 서버의 분류만 바뀌었다(다른 사람이 이 공간의 분류를 지웠다) — 이름 칸은 그대로다
    rerender(<SpaceManage meId="u1" space={space({ categoryId: null, categoryName: null })} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    expect((screen.getByLabelText('이름') as HTMLInputElement).value).toBe('치는 중');
  });
});

describe('SpaceManage — 넘겨받기·거절 뒤 (P15 병합 전 검토)', () => {
  it('**관리자는 주인이 건 중지를 넘겨받는다** — 묻고, 같은 상태를 보낸다. 주인에게는 단추가 없다', async () => {
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    const onChanged = vi.fn();
    const byOwner = { status: 'suspended' as const, suspendedByOwner: true };
    const { unmount } = render(
      <SpaceManage meId="a1" space={space({ ...byOwner, access: { ...NO, canEditInfo: true, canChangeStatus: true, canDelete: true } })} onChanged={onChanged} onDeleted={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '관리자가 건 중지로 바꾸기' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledWith(confirmTakeoverText('운영팀'));
    // 화면이 본 상태(주인이 건 중지)를 싣는다 — 그 사이 주인이 풀었으면 서버가 409다
    expect(writes()).toEqual([{ method: 'PATCH', url: '/api/spaces/s1/status', body: { status: 'suspended', takeover: true } }]);
    unmount();
    // 주인 — 제가 건 중지다. 관리자가 건 중지 — 넘겨받을 것이 없다
    render(<SpaceManage meId="u1" space={space({ ...byOwner, access: { ...NO, canEditInfo: true, canChangeStatus: true, isOwner: true } })} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '관리자가 건 중지로 바꾸기' })).toBeNull();
    cleanup();
    render(<SpaceManage meId="a1" space={space({ status: 'suspended', suspendedByOwner: false, access: { ...NO, canEditInfo: true, canChangeStatus: true } })} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '관리자가 건 중지로 바꾸기' })).toBeNull();
  });

  it('**풀지 못하는 주인의 안내는 "관리자가 다시 쓰게 하면"** — "먼저 다시 쓸 수 있게 한다"는 풀 수 있는 사람에게만', async () => {
    render(<SpaceManage meId="u1" space={space({ status: 'suspended', suspendedByOwner: false, access: { ...NO, canEditInfo: true, isOwner: true } })} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    expect(screen.getByText('중지된 스페이스는 이름·설명·분류를 바꿀 수 없다. 관리자가 다시 쓰게 하면 바꿀 수 있다.')).toBeTruthy();
    expect(screen.queryByText(/먼저 다시 쓸 수 있게 한다/)).toBeNull();
  });

  it('**거절되면 지금 상태를 다시 읽는다** — 그 사이 누가 바꿨으면 옛 단추가 남아 다시 눌러도 같은 거절이다 (병합 전 코드 리뷰 12)', async () => {
    window.confirm = vi.fn(() => true);
    answer = { status: 409, body: { message: '그 사이 누가 상태를 바꿨다 — 다시 본다' } };
    const onChanged = vi.fn();
    render(<SpaceManage meId="u1" space={space()} onChanged={onChanged} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '중지' }));
    expect((await screen.findByRole('alert')).textContent).toContain('그 사이 누가 상태를 바꿨다');
    expect(onChanged).toHaveBeenCalled();
  });
});

describe('SpaceManage — 분류 읽기의 순번·거절 뒤 (P15 좁은 재검토 1·4)', () => {
  it('**늦게 온 옛 분류 목록은 버린다** — 저장 뒤 다시 읽는 사이 새 분류를 만들어도 고른 것이 "분류 없음"으로 돌아가지 않는다', async () => {
    const base = globalThis.fetch;
    let lateList!: (r: Response) => void;
    let gets = 0;
    globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'GET' && url === '/api/categories' && ++gets === 2) {
        // 저장 뒤의 다시 읽기 — 늦게 온다(새 분류를 모르는 옛 목록)
        calls.push({ method: 'GET', url, body: undefined });
        return new Promise<Response>((ok) => (lateList = ok));
      }
      return base(input as RequestInfo, init);
    }) as unknown as typeof fetch;
    const onChanged = vi.fn();
    render(<SpaceManage meId="u1" space={space()} onChanged={onChanged} onDeleted={vi.fn()} />);
    await screen.findByRole('option', { name: '운영' });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('새 분류'), { target: { value: '재무' } });
    fireEvent.click(screen.getByRole('button', { name: '분류 만들기' }));
    await waitFor(() => expect((screen.getByLabelText('분류') as HTMLSelectElement).value).toBe('c2'));
    lateList(json(200, [category({})]));
    await new Promise((r) => setTimeout(r, 30));
    expect((screen.getByLabelText('분류') as HTMLSelectElement).value).toBe('c2');
    expect(screen.getByRole('option', { name: '재무' })).toBeTruthy();
  });

  it('**저장이 거절돼도 분류를 다시 읽는다** — 고른 분류를 남이 지웠으면(400 "없는 분류다") 선택이 풀려 다시 눌러도 같은 거절이 되지 않는다', async () => {
    categories = [category({}), category({ id: 'c2', name: '곧 지움' })];
    render(<SpaceManage meId="u1" space={space()} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    await screen.findByRole('option', { name: '곧 지움' });
    fireEvent.change(screen.getByLabelText('분류'), { target: { value: 'c2' } });
    categories = [category({})];
    answer = { status: 400, body: { message: '없는 분류다' } };
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect((await screen.findByRole('alert')).textContent).toContain('없는 분류다');
    await waitFor(() => expect((screen.getByLabelText('분류') as HTMLSelectElement).value).toBe(''));
  });
});

