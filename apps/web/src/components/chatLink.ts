import { CHAT_CLOSE, type ChatServerFrame } from '@workfluence/shared';

/**
 * 채팅 연결 하나의 **상태 기계** (P21_설계서_Chat G절). 소켓·재접속·보내기의 결과를 맡고, 무엇을 그릴지는 모른다 — 그래서 브라우저 없이 시험한다
 * (`chatLink.spec.ts`). 편집 연결(`collabLink.ts`)과 같은 모양이다.
 *
 * - `connecting` 붙는 중 · `live` 받는 중(`hello`를 받은 뒤) · `offline` 끊겼고 곧 다시 붙는다 · `revoked` 세션이 끝났다(다시 붙지 않는다 — 다시 로그인해야 한다) ·
 *   `refused` 서버가 이 화면이 보낸 프레임을 받지 않고 끊었다(다시 붙어도 같다) · `evicted` 같은 사용자의 연결이 상한을 넘어 이 연결이 밀려났다(스스로 다시 붙으면 다른 탭을 밀어내 서로 쫓아내므로 사람이 누를 때만 다시 붙는다)
 * - **다시 붙은 뒤에는 `onResync`를 부른다** — 연결은 새 메시지만 보내 주므로 끊긴 사이 놓친 것은 화면이 방마다 `afterSeq`로 메운다
 * - 보내기는 `clientMsgId`를 붙인다. 끊겨서 결과를 모르면 **같은 값으로 다시 보낸다** — 서버가 되풀이를 한 번만 받는다(A.1-6)
 */

export type ChatLinkState = 'connecting' | 'live' | 'offline' | 'revoked' | 'refused' | 'evicted';

/** 이 연결이 쓰는 만큼의 소켓 — 브라우저의 `WebSocket`, 시험은 가짜 */
export type ChatSocketLike = {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: (() => void) | null;
};

export type ChatLinkDeps = {
  open: () => ChatSocketLike;
  onState: (s: ChatLinkState) => void;
  onFrame: (f: ChatServerFrame) => void;
  /** 끊겼다 다시 붙었다 — 놓친 것을 메운다. 처음 붙을 때는 부르지 않는다 */
  onResync: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  newId?: () => string;
  /** 다시 붙기까지의 기다림(ms) — 늘어나다 마지막 값에서 멈춘다 */
  backoffMs?: number[];
  /** 보낸 뒤 ack를 기다리는 한도(ms) */
  ackTimeoutMs?: number;
};

export type SendResult = { seq: number; roomId: string; createdAt: string; clientMsgId: string };

/** 보내기가 실패한 까닭 — 서버의 `error.code`, 또는 `OFFLINE`(끊겨 있다)·`TIMEOUT`(답이 없다) */
export class ChatSendError extends Error {
  constructor(
    public readonly code: string,
    public readonly clientMsgId: string,
  ) {
    super(code);
    this.name = 'ChatSendError';
  }
}

const DEFAULT_BACKOFF = [1_000, 2_000, 4_000, 8_000, 15_000];

export function createChatLink(deps: ChatLinkDeps): {
  start(): void;
  stop(): void;
  /** 밀려난(`evicted`) 연결을 사람이 다시 잇는다 */
  reconnect(): void;
  send(roomId: string, body: string, clientMsgId?: string): Promise<SendResult>;
  readonly state: ChatLinkState;
} {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const backoff = deps.backoffMs ?? DEFAULT_BACKOFF;
  const ackTimeoutMs = deps.ackTimeoutMs ?? 15_000;
  let counter = 0;
  const newId = deps.newId ?? (() => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `c-${Date.now()}-${++counter}`));

  let state: ChatLinkState = 'connecting';
  let socket: ChatSocketLike | null = null;
  let stopped = false;
  let everLive = false;
  let attempt = 0;
  let retryTimer: unknown = null;
  const pending = new Map<string, { resolve: (r: SendResult) => void; reject: (e: ChatSendError) => void; timer: unknown }>();

  const setState = (s: ChatLinkState): void => {
    if (state === s) return;
    state = s;
    deps.onState(s);
  };

  const failAll = (code: string): void => {
    for (const [id, p] of pending) {
      clearTimer(p.timer);
      p.reject(new ChatSendError(code, id));
    }
    pending.clear();
  };

  const connect = (): void => {
    if (stopped) return;
    setState(everLive ? 'offline' : 'connecting');
    const s = deps.open();
    socket = s;
    s.onmessage = (ev) => {
      if (socket !== s) return; // 옛 소켓의 늦은 메시지 (collabLink와 같은 이유)
      let f: ChatServerFrame;
      try {
        f = JSON.parse(String(ev.data)) as ChatServerFrame;
      } catch {
        return;
      }
      if (f.type === 'hello') {
        attempt = 0;
        const resync = everLive;
        everLive = true;
        setState('live');
        if (resync) deps.onResync();
      } else if (f.type === 'ack' && f.clientMsgId !== null && pending.has(f.clientMsgId)) {
        const p = pending.get(f.clientMsgId)!;
        pending.delete(f.clientMsgId);
        clearTimer(p.timer);
        p.resolve({ seq: f.seq, roomId: f.roomId, createdAt: f.createdAt, clientMsgId: f.clientMsgId });
        return;
      } else if (f.type === 'error' && f.clientMsgId !== undefined && pending.has(f.clientMsgId)) {
        const p = pending.get(f.clientMsgId)!;
        pending.delete(f.clientMsgId);
        clearTimer(p.timer);
        p.reject(new ChatSendError(f.code, f.clientMsgId));
        return;
      }
      deps.onFrame(f);
    };
    s.onclose = (ev) => {
      if (socket !== s) return;
      socket = null;
      failAll('OFFLINE');
      if (stopped) return;
      if (ev.code === CHAT_CLOSE.revoked) return setState('revoked');
      if (ev.code === CHAT_CLOSE.badFrame) return setState('refused');
      if (ev.code === CHAT_CLOSE.evicted) return setState('evicted');
      setState('offline');
      const wait = backoff[Math.min(attempt, backoff.length - 1)]!;
      attempt += 1;
      retryTimer = setTimer(connect, wait);
    };
    s.onerror = () => undefined; // 닫힘이 따라온다
  };

  return {
    start(): void {
      stopped = false;
      connect();
    },
    reconnect(): void {
      if (state !== 'evicted' || socket) return;
      attempt = 0;
      connect();
    },
    stop(): void {
      stopped = true;
      if (retryTimer !== null) clearTimer(retryTimer);
      retryTimer = null;
      const s = socket;
      socket = null;
      failAll('OFFLINE');
      s?.close();
    },
    send(roomId, body, clientMsgId = newId()): Promise<SendResult> {
      return new Promise((resolve, reject) => {
        if (state !== 'live' || !socket) return reject(new ChatSendError('OFFLINE', clientMsgId));
        const timer = setTimer(() => {
          pending.delete(clientMsgId);
          reject(new ChatSendError('TIMEOUT', clientMsgId));
        }, ackTimeoutMs);
        pending.set(clientMsgId, { resolve, reject, timer });
        socket.send(JSON.stringify({ type: 'send', roomId, body, clientMsgId }));
      });
    },
    get state(): ChatLinkState {
      return state;
    },
  };
}
