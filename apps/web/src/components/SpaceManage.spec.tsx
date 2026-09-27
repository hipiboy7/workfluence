// @vitest-environment happy-dom
import type { SpaceView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpaceManage } from './SpaceManage';

/**
 * 컴포넌트 시험 — 스페이스 화면의 관리 칸 (P14_설계서_Spaces D.3, FR-1510·1511). 보이는 조건은 응답의 `access`다 — 화면은 규칙을 다시 만들지
 * 않는다. 중지와 지우기는 한 번 더 묻는다. 서버는 가짜 `fetch`다
 */

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

const NO = { canRead: true, canWrite: false, canManageMembers: false, canChangeStatus: false, canDelete: false, isOwner: false };
const space = (over: Partial<SpaceView> = {}): SpaceView => ({
  id: 's1',
  key: 'ABCD',
  name: '운영팀',
  description: '운영 문서',
  kind: 'team',
  status: 'active',
  categoryId: null,
  categoryName: null,
  createdBy: 'u1',
  createdByUsername: 'owner',
  memberCount: 2,
  myRole: 'owner',
  access: { ...NO, canWrite: true, canManageMembers: true, canChangeStatus: true, isOwner: true },
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  calls = [];
  answer = { status: 200, body: {} };
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined });
    if (method === 'GET' && url === '/api/categories') return Promise.resolve(json(200, [{ id: 'c1', name: '운영', createdAt: '2026-09-27T00:00:00.000Z' }]));
    return Promise.resolve(json(answer.status, answer.body));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const writes = () => calls.filter((c) => c.method !== 'GET');

describe('SpaceManage — 보이는 조건은 access', () => {
  it('관리할 수도 지울 수도 없으면 칸이 없다', () => {
    const { container } = render(<SpaceManage space={space({ access: NO })} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('**이름·설명·분류를 저장한다** — 분류를 고르지 않으면 `null`', async () => {
    const onChanged = vi.fn();
    render(<SpaceManage space={space()} onChanged={onChanged} onDeleted={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: '운영팀 (새 이름)' } });
    await screen.findByRole('option', { name: '운영' });
    fireEvent.change(screen.getByLabelText('분류'), { target: { value: 'c1' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(writes()).toEqual([{ method: 'PATCH', url: '/api/spaces/s1', body: { name: '운영팀 (새 이름)', description: '운영 문서', categoryId: 'c1' } }]);
  });

  it('분류를 고르지 않으면 `null`로 보낸다 — 빈 글자는 분류 id가 아니다', async () => {
    const onChanged = vi.fn();
    render(<SpaceManage space={space({ categoryId: 'c1', categoryName: '운영' })} onChanged={onChanged} onDeleted={vi.fn()} />);
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
    render(<SpaceManage space={space()} onChanged={onChanged} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '중지' }));
    expect(writes()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '중지' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(writes()).toEqual([{ method: 'PATCH', url: '/api/spaces/s1/status', body: { status: 'suspended' } }]);
  });

  it('**중지된 스페이스** — 이름·설명·분류는 막히고 다시 쓰기는 묻지 않고 보낸다', async () => {
    const onChanged = vi.fn();
    render(<SpaceManage space={space({ status: 'suspended', access: { ...NO, canChangeStatus: true, isOwner: true } })} onChanged={onChanged} onDeleted={vi.fn()} />);
    expect((screen.getByLabelText('이름') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '저장' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '다시 쓰기' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(writes()).toEqual([{ method: 'PATCH', url: '/api/spaces/s1/status', body: { status: 'active' } }]);
  });

  it('**지우기는 `canDelete`일 때만, 한 번 더 묻고** 지우면 목록으로 간다', async () => {
    window.confirm = vi.fn(() => true);
    const onDeleted = vi.fn();
    const { unmount } = render(<SpaceManage space={space()} onChanged={vi.fn()} onDeleted={onDeleted} />);
    expect(screen.queryByRole('button', { name: '지우기' })).toBeNull();
    expect(screen.getByText(/지우기는 Crew가 본인뿐인 주인/)).toBeTruthy();
    unmount();
    render(<SpaceManage space={space({ access: { ...NO, canChangeStatus: true, canDelete: true, isOwner: true } })} onChanged={vi.fn()} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(writes()).toEqual([{ method: 'DELETE', url: '/api/spaces/s1', body: undefined }]);
  });

  it('서버가 거절하면 그 까닭을 보인다', async () => {
    answer = { status: 403, body: { message: '스페이스 정보를 바꿀 권한이 없다' } };
    const onChanged = vi.fn();
    render(<SpaceManage space={space()} onChanged={onChanged} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect((await screen.findByRole('alert')).textContent).toContain('스페이스 정보를 바꿀 권한이 없다');
    expect(onChanged).not.toHaveBeenCalled();
  });
});
