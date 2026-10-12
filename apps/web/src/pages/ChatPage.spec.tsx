// @vitest-environment happy-dom
import type { ChatMessageView, ChatRoomView, ChatServerFrame } from '@workfluence/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPage } from './ChatPage';

// 렌더링마다 같은 객체여야 한다 — 실제 로그인 상태도 바뀌기 전까지 같은 객체다
const AUTH = { me: { id: 'u1', displayName: '나', role: 'member', grants: [] } };
vi.mock('../auth', () => ({ useAuth: () => AUTH }));
// 틀(AppLayout) 없이 그린다 — 왼쪽 칸은 제자리에 그려진다
vi.mock('../layout/AppLayout', () => ({ SideSlot: ({ children }: { children: React.ReactNode }) => <div className="side-inline">{children}</div> }));

/**
 * 컴포넌트 시험 — 채팅 (P21_설계서_Chat G절·FR-2400~2407). 서버는 가짜 `fetch`와 가짜 `WebSocket`이다. 연결의 규칙(재접속·ack·옛 소켓)은
 * `chatLink.spec.ts`가, 실제 서버와의 흐름은 E2E가 본다 — 여기는 **무엇이 그려지고 무엇을 부르나**를 본다.
 */

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {}
  recv(f: ChatServerFrame) {
    act(() => this.onmessage?.({ data: JSON.stringify(f) }));
  }
  drop(code = 1006) {
    act(() => this.onclose?.({ code }));
  }
}

const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const room = (id: string, over: Partial<ChatRoomView> = {}): ChatRoomView => ({
  id,
  kind: 'direct',
  name: null,
  createdBy: 'u1',
  members: [
    { userId: 'u1', displayName: '나' },
    { userId: 'u2', displayName: '앨리스' },
  ],
  lastSeq: 0,
  lastMessageAt: null,
  lastMessage: null,
  unread: 0,
  ...over,
});
const msg = (roomId: string, seq: number, body: string, senderId = 'u2'): ChatMessageView => ({ id: `${roomId}-${seq}`, roomId, seq, senderId, body, createdAt: '2026-10-12T01:00:00.000Z' });

let rooms: ChatRoomView[];
let messages: Record<string, ChatMessageView[]>;
let calls: { method: string; url: string; body: unknown }[];
const json = (status: number, body: unknown) => ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  rooms = [room(R1, { lastSeq: 2, lastMessage: msg(R1, 2, '두 번째'), unread: 2 }), room(R2, { kind: 'group', name: '팀', members: [{ userId: 'u1', displayName: '나' }, { userId: 'u3', displayName: '밥' }] })];
  messages = { [R1]: [msg(R1, 1, '첫 번째'), msg(R1, 2, '<b>두 번째</b>')], [R2]: [] };
  calls = [];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url === '/api/chat/rooms' && method === 'GET') return Promise.resolve(json(200, { items: rooms }));
    const m = /^\/api\/chat\/rooms\/([^/]+)\/messages\?(.*)$/.exec(url);
    if (m && method === 'GET') {
      const after = new URLSearchParams(m[2]).get('afterSeq');
      return Promise.resolve(json(200, { items: (messages[m[1]!] ?? []).filter((x) => (after === null ? true : x.seq > Number(after))) }));
    }
    if (/\/read$/.test(url) && method === 'PUT') return Promise.resolve(json(200, { lastReadSeq: body.seq }));
    if (url.startsWith('/api/chat/users')) return Promise.resolve(json(200, { items: [{ id: 'u2', displayName: '앨리스' }, { id: 'u3', displayName: '밥' }] }));
    if (url === '/api/chat/rooms' && method === 'POST') return Promise.resolve(json(201, { ...room(R1), created: false }));
    return Promise.resolve(json(404, { message: 'x' }));
  }) as unknown as typeof fetch;
});
afterEach(cleanup);

const open = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:id" element={<ChatPage />} />
      </Routes>
    </MemoryRouter>,
  );
const sock = () => FakeWebSocket.instances.at(-1)!;
/** 대화 칸 — 왼쪽 목록의 미리보기와 같은 글이 겹쳐 보이지 않게 */
const pane = () => within(screen.getByRole('region', { name: '대화' }));
const hello = () => sock().recv({ type: 'hello', userId: 'u1', roomIds: [R1, R2] });

describe('방 목록 (FR-2400)', () => {
  it('내 방이 이름과 함께 보이고 안 읽은 수가 붙는다 — 1:1은 상대 이름, 여럿은 방 이름', async () => {
    open('/chat');
    const nav = await screen.findByRole('navigation', { name: '채팅 방 목록' });
    expect(await within(nav).findByText('앨리스')).toBeTruthy();
    expect(within(nav).getByText('팀')).toBeTruthy();
    expect(within(nav).getByLabelText('안 읽은 메시지 2개')).toBeTruthy();
    expect(screen.getByText('방을 고른다')).toBeTruthy();
  });
});

describe('대화 (FR-2403·2405)', () => {
  it('고른 방의 메시지를 번호 순으로 평문으로 그리고 읽음을 알린다 — HTML은 해석하지 않는다', async () => {
    open(`/chat/${R1}`);
    expect(await screen.findByText('첫 번째')).toBeTruthy();
    expect(screen.getByText('<b>두 번째</b>')).toBeTruthy(); // 태그가 글자로 보인다
    await waitFor(() => expect(calls).toContainEqual({ method: 'PUT', url: `/api/chat/rooms/${R1}/read`, body: { seq: 2 } }));
    const nav = screen.getByRole('navigation', { name: '채팅 방 목록' });
    await waitFor(() => expect(within(nav).queryByLabelText(/안 읽은 메시지/)).toBeNull());
  });

  it('연결이 붙기 전에는 보내지 못하고, 붙으면 보낸다 — 입력칸을 비운다', async () => {
    open(`/chat/${R1}`);
    const box = (await screen.findByLabelText('메시지')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '안녕하세요' } });
    expect((screen.getByRole('button', { name: '보내기' }) as HTMLButtonElement).disabled).toBe(true);
    hello();
    await waitFor(() => expect((screen.getByRole('button', { name: '보내기' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(sock().sent).toHaveLength(1);
    expect(JSON.parse(sock().sent[0]!)).toMatchObject({ type: 'send', roomId: R1, body: '안녕하세요' });
    expect(box.value).toBe('');
  });

  it('Enter로 보내고 Shift+Enter는 줄바꿈이다', async () => {
    open(`/chat/${R1}`);
    const box = await screen.findByLabelText('메시지');
    hello();
    fireEvent.change(box, { target: { value: '줄' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(sock().sent).toHaveLength(0);
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sock().sent).toHaveLength(1));
  });

  it('새 메시지 프레임이 오면 그 자리에서 보이고, 다른 방의 것은 그 방의 안 읽은 수를 올린다', async () => {
    open(`/chat/${R1}`);
    await screen.findByText('첫 번째');
    hello();
    sock().recv({ type: 'message', roomId: R1, seq: 3, senderId: 'u2', body: '방금 온 것', createdAt: '2026-10-12T01:05:00.000Z' });
    await waitFor(() => expect(pane().getByText('방금 온 것')).toBeTruthy());
    sock().recv({ type: 'message', roomId: R2, seq: 1, senderId: 'u3', body: '팀 소식', createdAt: '2026-10-12T01:06:00.000Z' });
    const nav = screen.getByRole('navigation', { name: '채팅 방 목록' });
    await waitFor(() => expect(within(nav).getByLabelText('안 읽은 메시지 1개')).toBeTruthy());
  });

  it('같은 번호가 두 번 와도 한 번만 그린다', async () => {
    open(`/chat/${R1}`);
    await screen.findByText('첫 번째');
    hello();
    const f: ChatServerFrame = { type: 'message', roomId: R1, seq: 3, senderId: 'u2', body: '중복', createdAt: '2026-10-12T01:05:00.000Z' };
    sock().recv(f);
    sock().recv(f);
    await waitFor(() => expect(pane().getAllByText('중복')).toHaveLength(1));
  });
});

describe('끊김·실패 (G절)', () => {
  it('끊기면 알리고, 다시 붙으면 놓친 메시지를 메운다', async () => {
    open(`/chat/${R1}`);
    await screen.findByText('첫 번째');
    hello();
    const first = sock();
    first.drop();
    expect(await screen.findByText(/연결이 끊겼다/)).toBeTruthy();
    messages[R1] = [...messages[R1]!, msg(R1, 3, '끊긴 사이에 온 것')];
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 3_000 });
    hello();
    expect(await screen.findByText('끊긴 사이에 온 것')).toBeTruthy();
    expect(calls.some((c) => c.url === `/api/chat/rooms/${R1}/messages?afterSeq=2`)).toBe(true);
  });

  it('세션이 끝나(4401) 닫히면 다시 로그인하라고 말하고 다시 붙지 않는다', async () => {
    open(`/chat/${R1}`);
    await screen.findByText('첫 번째');
    hello();
    sock().drop(4401);
    expect(await screen.findByText(/로그인이 끝나/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 1_200));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('서버가 그 메시지를 거절하면 까닭을 보이고, 되풀이할 수 있는 실패는 같은 값으로 다시 보낸다', async () => {
    open(`/chat/${R1}`);
    const box = await screen.findByLabelText('메시지');
    hello();
    fireEvent.change(box, { target: { value: '보낼 말' } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    const sent = JSON.parse(sock().sent[0]!);
    sock().recv({ type: 'error', code: 'RATE_LIMITED', roomId: R1, clientMsgId: sent.clientMsgId });
    expect(await screen.findByText(/너무 자주 보냈다/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '다시 보내기' }));
    expect(JSON.parse(sock().sent[1]!)).toMatchObject({ body: '보낼 말', clientMsgId: sent.clientMsgId });
    sock().recv({ type: 'ack', clientMsgId: sent.clientMsgId, roomId: R1, seq: 3, createdAt: 't' });
    await waitFor(() => expect(screen.queryByText(/너무 자주 보냈다/)).toBeNull());
  });

  it('본문 문제는 다시 보내기를 주지 않는다 — 고쳐서 새로 보낸다', async () => {
    open(`/chat/${R1}`);
    const box = await screen.findByLabelText('메시지');
    hello();
    fireEvent.change(box, { target: { value: '긴 글' } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    sock().recv({ type: 'error', code: 'TOO_LONG', roomId: R1, clientMsgId: JSON.parse(sock().sent[0]!).clientMsgId });
    expect(await screen.findByText(/메시지가 너무 길다/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '다시 보내기' })).toBeNull();
  });
});

describe('새 대화 (FR-2401·2402)', () => {
  it('1:1 — 사람을 고르면 방을 만들고(이미 있으면 그 방) 그 방으로 간다', async () => {
    open('/chat');
    fireEvent.click(await screen.findByRole('button', { name: /새 대화/ }));
    fireEvent.click(await screen.findByRole('button', { name: '앨리스' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', url: '/api/chat/rooms', body: { kind: 'direct', userId: 'u2' } }));
  });

  it('여럿 — 이름과 사람들을 골라 만든다', async () => {
    open('/chat');
    fireEvent.click(await screen.findByRole('button', { name: /새 대화/ }));
    fireEvent.click(screen.getByLabelText('여럿'));
    const create = screen.getByRole('button', { name: '방 만들기' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('방 이름'), { target: { value: '프로젝트' } });
    fireEvent.click(await screen.findByLabelText('앨리스'));
    fireEvent.click(screen.getByLabelText('밥'));
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', url: '/api/chat/rooms', body: { kind: 'group', name: '프로젝트', userIds: ['u2', 'u3'] } }));
  });
});
