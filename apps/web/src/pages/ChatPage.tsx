import { CHAT_LIMITS, isChatNotice, type ChatMessageView, type ChatRoomView, type ChatServerFrame } from '@workfluence/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api } from '../api';
import { useAuth } from '../auth';
import { ChatInvite } from '../components/ChatInvite';
import { ChatNewRoom } from '../components/ChatNewRoom';
import { useConfirm } from '../components/ConfirmDialog';
import { ChatSideNav } from '../components/ChatSideNav';
import { ChatSendError, createChatLink, type ChatLinkState, type ChatSocketLike } from '../components/chatLink';
import { applyMessageToRooms, lastSeqOf, memberTones, mergeMessages, roomTitle } from '../components/chatState';
import { EmptyState, Notice, Page, PageHeader, useDocumentTitle } from '../components/ui';
import { SideSlot } from '../layout/AppLayout';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 연결 주소 — 같은 출처. 세션 쿠키가 따라간다 */
const chatSocketUrl = (): string => `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/chat/ws`;

/** 서버가 준 까닭 코드를 사람의 말로 */
const SEND_PROBLEMS: Record<string, string> = {
  OFFLINE: '연결이 끊겨 보내지 못했다',
  TIMEOUT: '답이 없어 보냈는지 알 수 없다 — 다시 보내도 같은 메시지는 한 번만 들어간다',
  EMPTY: '빈 메시지는 보낼 수 없다',
  TOO_LONG: '메시지가 너무 길다',
  BAD_CHAR: '보낼 수 없는 글자가 들어 있다',
  RATE_LIMITED: '너무 자주 보냈다 — 잠시 뒤에 다시 보낸다',
  ROOM_NOT_FOUND: '이 방에 더 이상 들어 있지 않다',
};

type Failed = { clientMsgId: string; body: string; code: string };

const time = (iso: string): string => new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' });

/**
 * 채팅 (P21_설계서_Chat G절, FR-2400~2407). 왼쪽 칸은 내 방 목록(`ChatSideNav`), 본문은 고른 방의 메시지와 입력칸이다.
 * 연결(`chatLink.ts`)은 이 화면이 열려 있는 동안 하나만 두고, 새 메시지는 연결이 보내 준다 — 끊겼다 돌아오면 방마다 마지막 번호 이후를 REST로 메운다.
 * 메시지는 평문으로 그린다(HTML이 아니다). 보내기가 실패하면 같은 `clientMsgId`로 다시 보낼 수 있다 — 서버가 되풀이를 한 번만 받는다.
 */
export function ChatPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { me } = useAuth();
  const meId = me?.id ?? '';
  const [rooms, setRooms] = useState<ChatRoomView[] | null>(null);
  const [roomsFailed, setRoomsFailed] = useState(false);
  const [messages, setMessages] = useState<Record<string, ChatMessageView[]>>({});
  const [hasMore, setHasMore] = useState<Record<string, boolean>>({});
  const [linkState, setLinkState] = useState<ChatLinkState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [failed, setFailed] = useState<Record<string, Failed[]>>({});
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [confirm, dialog] = useConfirm();
  const linkRef = useRef<ReturnType<typeof createChatLink> | null>(null);
  const viewing = id ?? null;
  const viewingRef = useRef<string | null>(viewing);
  viewingRef.current = viewing;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  /** 처음 메시지를 받아 온 방 — 받기 전에 온 실시간 메시지로 목록이 생겨도 "받았다"로 치지 않는다(코드 리뷰 2) */
  const loadedRef = useRef(new Set<string>());
  const listEnd = useRef<HTMLLIElement | null>(null);

  const room = useMemo(() => rooms?.find((r) => r.id === viewing) ?? null, [rooms, viewing]);
  useDocumentTitle(room ? roomTitle(room, meId) : '채팅');

  const loadRooms = useCallback(
    () =>
      api<{ items: ChatRoomView[] }>('/api/chat/rooms')
        .then((r) => {
          setRooms(r.items);
          setRoomsFailed(false);
        })
        .catch((e: unknown) => {
          setRoomsFailed(true);
          setError(errText(e));
        }),
    [],
  );

  /**
   * 방의 메시지를 읽는다 — `afterSeq`가 있으면 그 뒤(놓친 것), 없으면 가장 새 것부터. **`afterSeq`는 한 번에 다 오지 않으면 이어서 받는다**(서버는 한 번에 최대 200개 —
   * 그 이상 놓쳤을 때 빈 구간이 영구히 남지 않게, 코드 리뷰 1). 실시간으로 먼저 온 메시지와는 번호로 합친다
   */
  const loadMessages = useCallback(async (roomId: string, q: { afterSeq?: number; beforeSeq?: number } = {}) => {
    const PAGE: number = CHAT_LIMITS.pageMax;
    let after = q.afterSeq;
    for (;;) {
      const qs = new URLSearchParams();
      if (after !== undefined) {
        qs.set('afterSeq', String(after));
        qs.set('limit', String(PAGE));
      }
      if (q.beforeSeq !== undefined) qs.set('beforeSeq', String(q.beforeSeq));
      const r = await api<{ items: ChatMessageView[] }>(`/api/chat/rooms/${roomId}/messages?${qs.toString()}`);
      setMessages((cur) => ({ ...cur, [roomId]: mergeMessages(cur[roomId] ?? [], r.items) }));
      // 한 번에 받는 수(기본 50)를 다 채웠으면 더 옛것이 있을 수 있다
      if (after === undefined) setHasMore((cur) => ({ ...cur, [roomId]: r.items.length >= CHAT_LIMITS.pageDefault }));
      if (after === undefined || r.items.length < PAGE) break;
      after = r.items[r.items.length - 1]!.seq;
    }
    loadedRef.current.add(roomId);
  }, []);

  // 방 목록은 연결과 상관없이 먼저 받는다 — 연결이 늦거나 막혀도 목록과 지난 메시지는 보인다
  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  // 연결 — 이 화면이 열려 있는 동안 하나
  useEffect(() => {
    if (!me) return;
    const link = createChatLink({
      open: () => new WebSocket(chatSocketUrl()) as unknown as ChatSocketLike,
      onState: setLinkState,
      onFrame: (f: ChatServerFrame) => {
        if (f.type === 'message') {
          const m: ChatMessageView = { id: `${f.roomId}:${f.seq}`, roomId: f.roomId, seq: f.seq, senderId: f.senderId, body: f.body, kind: f.kind, createdAt: f.createdAt };
          // 받기 전인 방의 메시지도 버리지 않고 쌓아 둔다 — 처음 받아 온 것과 번호로 합쳐진다(코드 리뷰 2)
          setMessages((cur) => ({ ...cur, [f.roomId]: mergeMessages(cur[f.roomId] ?? [], [m]) }));
          setRooms((cur) => (cur ? applyMessageToRooms(cur, m, meId, viewingRef.current) : cur));
        } else if (f.type === 'room') {
          void loadRooms();
        }
      },
      // 끊겼다 돌아왔다 — 방 목록을 다시 받고 열려 있는 방은 놓친 것을 메운다
      onResync: () => {
        void loadRooms();
        for (const roomId of loadedRef.current) void loadMessages(roomId, { afterSeq: lastSeqOf(messagesRef.current[roomId] ?? []) }).catch(() => undefined);
      },
    });
    linkRef.current = link;
    link.start();
    return () => {
      link.stop();
      linkRef.current = null;
    };
  }, [me, meId, loadRooms, loadMessages]);

  // 방을 열면 메시지를 받는다
  useEffect(() => {
    if (!viewing || loadedRef.current.has(viewing)) return;
    loadMessages(viewing).catch((e: unknown) => setError(errText(e)));
  }, [viewing, loadMessages]);

  // 보고 있는 방의 마지막 번호까지 읽음 표시 — 안 읽은 수는 곧바로 0으로 둔다
  const list = viewing ? messages[viewing] : undefined;
  const lastSeq = lastSeqOf(list ?? []);
  useEffect(() => {
    if (!viewing || lastSeq === 0) return;
    setRooms((cur) => (cur ? cur.map((r) => (r.id === viewing && r.unread > 0 ? { ...r, unread: 0 } : r)) : cur));
    void api(`/api/chat/rooms/${viewing}/read`, { method: 'PUT', json: { seq: lastSeq } }).catch(() => undefined);
  }, [viewing, lastSeq]);

  // 새 메시지가 오면 맨 아래로
  useEffect(() => {
    listEnd.current?.scrollIntoView?.({ block: 'end' });
  }, [viewing, lastSeq]);

  const tones = useMemo(() => (room ? memberTones(room) : new Map<string, number>()), [room]);
  const toneClass = (userId: string): string => (tones.has(userId) ? ` tone-${tones.get(userId)}` : '');
  const nameOf = (userId: string): string => room?.members.find((m) => m.userId === userId)?.displayName ?? '(나간 사람)';

  const send = (body: string, clientMsgId?: string) => {
    const link = linkRef.current;
    if (!viewing || !link) return;
    const roomId = viewing;
    setError(null);
    link
      .send(roomId, body, clientMsgId)
      .then((r) => setFailed((cur) => ({ ...cur, [roomId]: (cur[roomId] ?? []).filter((f) => f.clientMsgId !== r.clientMsgId) })))
      .catch((e: unknown) => {
        if (!(e instanceof ChatSendError)) return setError(errText(e));
        const f: Failed = { clientMsgId: e.clientMsgId, body, code: e.code };
        setFailed((cur) => ({ ...cur, [roomId]: [...(cur[roomId] ?? []).filter((x) => x.clientMsgId !== f.clientMsgId), f] }));
      });
  };

  const submit = () => {
    const body = draft;
    if (!body.trim()) return;
    setDraft('');
    send(body);
  };

  const leave = async () => {
    if (!room) return;
    const ok = await confirm({ title: '이 방에서 나갈까요?', body: `"${roomTitle(room, meId)}" 방에서 나간다. 나간 뒤에는 이 방의 메시지를 읽지도 보내지도 못한다.`, confirmLabel: '나간다' });
    if (!ok) return;
    api(`/api/chat/rooms/${room.id}/members/me`, { method: 'DELETE' })
      .then(() => {
        setMessages((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => k !== room.id)));
        void loadRooms();
        nav('/chat');
      })
      .catch((e: unknown) => setError(errText(e)));
  };

  const live = linkState === 'live';
  const roomFailed = viewing ? (failed[viewing] ?? []) : [];

  return (
    <Page width="wide" className="chat">
      <SideSlot>
        <ChatSideNav rooms={rooms} failed={roomsFailed} meId={meId} currentId={viewing} onNew={() => setAdding(true)} />
      </SideSlot>
      {dialog}
      <PageHeader
        title={room ? roomTitle(room, meId) : '채팅'}
        description={room?.kind === 'group' ? `참여자 ${room.members.length}명 — ${room.members.map((m) => m.displayName).join(', ')}` : undefined}
        actions={
          room?.kind === 'group' && (
            <>
              <button type="button" className="subtle" onClick={() => setInviting(true)}>
                사람 초대
              </button>
              <button type="button" className="subtle danger" onClick={() => void leave()}>
                방에서 나가기
              </button>
            </>
          )
        }
      />
      {linkState === 'offline' && <Notice kind="warning">연결이 끊겼다 — 다시 붙는 중이다. 붙으면 놓친 메시지를 받는다.</Notice>}
      {linkState === 'revoked' && <Notice kind="error">로그인이 끝나 채팅 연결이 닫혔다 — 다시 로그인한 뒤 이 화면을 연다.</Notice>}
      {linkState === 'evicted' && (
        <Notice kind="warning">
          같은 계정의 채팅 연결이 너무 많아 이 화면의 연결이 닫혔다 — 다른 탭을 닫은 뒤{' '}
          <button type="button" className="subtle sm" onClick={() => linkRef.current?.reconnect()}>
            다시 연결
          </button>
          한다.
        </Notice>
      )}
      {linkState === 'refused' && <Notice kind="error">서버가 이 화면의 요청을 받지 않고 연결을 닫았다 — 화면을 새로 고쳐 본다.</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {adding && (
        <ChatNewRoom
          onCancel={() => setAdding(false)}
          onCreated={(r) => {
            setAdding(false);
            void loadRooms();
            nav(`/chat/${r.id}`);
          }}
        />
      )}
      {inviting && room && (
        <ChatInvite
          room={room}
          onCancel={() => setInviting(false)}
          onInvited={(r) => {
            setInviting(false);
            setRooms((cur) => (cur ? cur.map((x) => (x.id === r.id ? { ...x, members: r.members } : x)) : cur));
          }}
        />
      )}
      {!viewing ? (
        <EmptyState title="방을 고른다" description="왼쪽에서 방을 고르거나 새 대화를 시작한다." />
      ) : rooms && !room ? (
        <EmptyState title="이 방을 찾을 수 없다" description="들어 있지 않거나 없는 방이다." />
      ) : (
        <section className="chat-pane" aria-label="대화">
          {hasMore[viewing] && (
            <button type="button" className="subtle chat-more" onClick={() => void loadMessages(viewing, { beforeSeq: (list ?? [])[0]?.seq }).catch((e: unknown) => setError(errText(e)))}>
              이전 메시지 더 보기
            </button>
          )}
          <ul className="chat-messages" aria-live="polite">
            {(list ?? []).map((m) => (
              isChatNotice(m.kind) ? (
                <li key={m.seq} className="chat-notice">
                  {m.body}
                </li>
              ) : (
              <li key={m.seq} className={`${m.senderId === meId ? 'chat-msg mine' : 'chat-msg'}${toneClass(m.senderId)}`}>
                <p className="chat-meta">
                  <strong>{m.senderId === meId ? '나' : nameOf(m.senderId)}</strong> <span className="muted">{time(m.createdAt)}</span>
                </p>
                <p className="chat-text">{m.body}</p>
              </li>
              )
            ))}
            {roomFailed.map((f) => (
              <li key={f.clientMsgId} className={`chat-msg mine failed${toneClass(meId)}`}>
                <p className="chat-text">{f.body}</p>
                <p className="chat-meta" role="alert">
                  보내지 못했다 — {SEND_PROBLEMS[f.code] ?? f.code}{' '}
                  {f.code !== 'EMPTY' && f.code !== 'TOO_LONG' && f.code !== 'BAD_CHAR' && f.code !== 'ROOM_NOT_FOUND' && (
                    <button type="button" className="subtle sm" disabled={!live} onClick={() => send(f.body, f.clientMsgId)}>
                      다시 보내기
                    </button>
                  )}
                  <button type="button" className="subtle sm" onClick={() => setFailed((cur) => ({ ...cur, [viewing]: (cur[viewing] ?? []).filter((x) => x.clientMsgId !== f.clientMsgId) }))}>
                    버리기
                  </button>
                </p>
              </li>
            ))}
            <li ref={listEnd} aria-hidden="true" />
          </ul>
          <form
            className="chat-compose"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label className="sr-only" htmlFor="chat-draft">
              메시지
            </label>
            <textarea
              id="chat-draft"
              rows={2}
              value={draft}
              placeholder="메시지를 쓴다 (Enter 보내기 · Shift+Enter 줄바꿈)"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // 한글 조합 중의 Enter는 보내지 않는다
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <button type="submit" disabled={!live || !draft.trim()}>
              보내기
            </button>
          </form>
        </section>
      )}
    </Page>
  );
}
