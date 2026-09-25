import { COLLAB_CLOSE_REFUSED, COLLAB_CLOSE_TOO_LARGE, COLLAB_MSG, type CollabStatus } from '@workfluence/shared';
import { type Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as Y from 'yjs';

/**
 * 실시간 편집의 **연결 하나** — 소켓·문서·사람 표시를 잇는다 (P6_설계서_Collab F절, P9_설계서_Gate D.5·D.9·G절).
 *
 * `CollabEditor.tsx`에서 떼어 냈다. 편집기를 그리는 일과 연결의 상태 기계를 나눠 **상태 기계를 브라우저 없이 시험한다**
 * (`collabLink.spec.ts`, 3절 — 상태·분기가 있는 것은 시험을 둔다). 이 논리에서만 병합 전 검토 두 묶음이 결함 다섯을 찾았다 —
 * 옛 소켓의 늦은 닫힘(첫 코드 리뷰 7), 다시 붙을 때 사라지는 사람 표시(두 번째 코드 리뷰 1), 받은 남의 표시를 되돌려 보내기
 * (두 번째 코드 리뷰 9), 문서 ID와 사람 표시 ID의 혼동(두 번째 자체 점검 6), 끊긴 뒤에 남는 옛 저장 멈춤 배너(두 번째 코드 리뷰 6·
 * 자체 점검 4).
 *
 * 앞 한 바이트가 종류다(`COLLAB_MSG`: 0 문서, 1 사람, 2 저장 상태 — 2는 서버만 보낸다).
 */

/** `refused` — 서버의 관문이 이 화면의 편집을 받지 않고 끊었다 (P9_설계서_Gate D.6). 다시 붙어도 같은 편집은 다시 거절된다 */
export type CollabState = 'connecting' | 'live' | 'offline' | 'refused';

/** 이 연결이 쓰는 만큼의 소켓 — 브라우저의 `WebSocket`, 시험은 가짜 */
export type SocketLike = {
  readonly readyState: number;
  binaryType: BinaryType;
  send(data: Uint8Array): void;
  close(): void;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent<ArrayBuffer>) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
};

/** `WebSocket.OPEN` — 시험의 가짜 소켓은 브라우저 상수를 모른다 */
const SOCKET_OPEN = 1;

/**
 * 사람마다 다른 색. 이름의 글자 코드로 정해 **같은 사람은 늘 같은 색**이 되게 한다.
 * **캐럿이 받는 `#rrggbb`로 만든다** — TipTap `CollaborationCaret`은 이 밖의 색을 투명으로 바꿔 그린다. 전에는 `hsl(…)`을 만들어
 * Phase 6부터 동료의 캐럿이 보이지 않았다 (P9 두 번째 자체 점검 5). 서버도 이 모양만 퍼뜨린다(`presence.ts`)
 */
export function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return hslToHex(h, 0.7, 0.45);
}

/** HSL(색상 0~360, 채도·명도 0~1) → `#rrggbb` */
function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): string => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

export class CollabLink {
  private readonly socket: SocketLike;
  private state: CollabState = 'connecting';
  private closed = false;

  constructor(
    private readonly opts: {
      url: string;
      doc: Y.Doc;
      awareness: Awareness;
      user: { name: string; color: string };
      onState: (s: CollabState) => void;
      /** 서버가 자동 저장이 멈췄다고(까닭), 또는 풀렸다고(`null`) 알렸다. 연결이 끝나면 `null`이다 (P9 FR-1011) */
      onSaveBlocked: (reason: string | null) => void;
      /** 소켓을 만든다 — 기본은 브라우저의 `WebSocket` */
      connect?: (url: string) => SocketLike;
    },
  ) {
    const socket = (opts.connect ?? ((url: string) => new WebSocket(url) as unknown as SocketLike))(opts.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => this.opened();
    socket.onmessage = (ev) => this.received(new Uint8Array(ev.data));
    // **끊기면 그렇다고 말한다.** 조용히 끊기면 사람은 계속 쓰고 있는데 아무에게도 안 가고, 새로고침하면 그 내용이 사라진다.
    // **거절로 끊긴 것은 따로 말한다** (P9 FR-1005) — 다시 보내도 같은 편집은 다시 거절된다. 끊긴 방의 저장 상태는 더 모른다
    // 너무 큰 프레임으로 닫힌 것(1009)도 거절이다 — 같은 편집을 다시 보내도 다시 닫힌다 (P12 FR-1321)
    socket.onclose = (ev) => {
      this.setState(this.state === 'refused' || ev.code === COLLAB_CLOSE_REFUSED || ev.code === COLLAB_CLOSE_TOO_LARGE ? 'refused' : 'offline');
      opts.onSaveBlocked(null);
    };
    socket.onerror = () => {
      if (this.state !== 'refused') this.setState('offline');
    };
    opts.doc.on('update', this.onDocUpdate);
    opts.awareness.on('update', this.onAwareness);
    opts.onState(this.state);
  }

  /**
   * 정리한다. **퇴장을 먼저 알리고** 그다음에 듣기를 멈춘다 — 순서를 뒤집으면 내가 나간 것이 전파되지 않아 남의 화면에 내 이름과
   * 커서가 30초까지 남는다 (P6 자체 점검 29). **옛 소켓의 소식은 끊는다** — 다시 붙을 때 옛 소켓이 늦게 닫히며 새 연결이 살아 있는
   * 화면에 "연결이 끊겼다"를 띄웠다 (P9 코드 리뷰 7)
   */
  close(): void {
    if (this.closed) return;
    const { doc, awareness } = this.opts;
    doc.off('update', this.onDocUpdate);
    removeAwarenessStates(awareness, [awareness.clientID], 'unmount');
    awareness.off('update', this.onAwareness);
    this.closed = true;
    const socket = this.socket;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
    this.opts.onSaveBlocked(null);
  }

  private setState(s: CollabState): void {
    this.state = s;
    this.opts.onState(s);
  }

  private send(kind: number, payload: Uint8Array): void {
    if (this.socket.readyState !== SOCKET_OPEN) return;
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = kind;
    frame.set(payload, 1);
    this.socket.send(frame);
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === 'remote') return; // 받은 것을 되돌려 보내지 않는다
    this.send(COLLAB_MSG.update, update);
  };

  /**
   * **내 표시만 보낸다** (P9 두 번째 코드 리뷰 9). 받은 남의 표시까지 되돌려 보내면 서버가 읽고 버린다 — 사람이 N이면 누가 표시를
   * 고칠 때마다 N²의 프레임이 오갔다. 내 ID는 **사람 표시의 ID**다 — Yjs가 문서의 ID를 스스로 바꿔도 사람 표시는 만들 때의 ID를
   * 쓴다. 문서의 ID로 보내면 그 ID의 메타가 없어 던졌다 (P9 두 번째 자체 점검 6)
   */
  private readonly onAwareness = ({ added, updated, removed }: AwarenessChange, origin: unknown): void => {
    const me = this.opts.awareness.clientID;
    if (origin === 'remote' || ![...added, ...updated, ...removed].includes(me)) return;
    this.send(COLLAB_MSG.awareness, encodeAwarenessUpdate(this.opts.awareness, [me]));
  };

  private opened(): void {
    this.setState('live');
    const { awareness, doc, user } = this.opts;
    // **나를 먼저 알린다** — 서버는 이 알림을 처리하는 순간 내 ID를 나에게 묶는다(P9 D.4). **다시 붙을 때도** 알린다: 앞 연결을
    // 정리하며 내 표시를 지웠고(null), 그 상태에서는 `setLocalStateField`가 아무것도 하지 않아 새 연결이 빈 표시를 보냈다 — 동료의
    // 화면에서 내 이름과 캐럿이 사라졌다 (P9 두 번째 코드 리뷰 1). 알림은 위의 `update` 듣기가 보낸다
    awareness.setLocalState({ ...(awareness.getLocalState() ?? {}), user });
    // 내가 가진 것을 보낸다. 서버가 전체 상태를 돌려주므로 둘이 합쳐진다
    this.send(COLLAB_MSG.update, Y.encodeStateAsUpdate(doc));
  }

  private received(data: Uint8Array): void {
    if (this.closed || data.length < 1) return;
    const body = data.subarray(1);
    if (data[0] === COLLAB_MSG.update) Y.applyUpdate(this.opts.doc, body, 'remote');
    else if (data[0] === COLLAB_MSG.awareness) applyAwarenessUpdate(this.opts.awareness, body, 'remote');
    else if (data[0] === COLLAB_MSG.status) {
      // 서버가 알린 저장 상태 (FR-1011). 읽지 못하면 무시한다 — 이 알림 때문에 편집이 멈추면 안 된다
      try {
        const status = JSON.parse(new TextDecoder().decode(body)) as CollabStatus;
        this.opts.onSaveBlocked(typeof status.saveBlocked === 'string' ? status.saveBlocked : null);
      } catch {
        /* 무시 */
      }
    }
  }
}
