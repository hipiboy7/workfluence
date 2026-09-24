import { EditorContent, useEditor } from '@tiptap/react';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { COLLAB_CLOSE_REFUSED, COLLAB_MSG, type CollabStatus } from '@workfluence/shared';
import { editorExtensions } from './extensions';

/**
 * 실시간 동시 편집기 (P6_설계서_Collab F절, FR-700·705).
 *
 * **서버가 정한 것과 같은 프로토콜을 쓴다** — 앞 한 바이트가 종류다 (`COLLAB_MSG`: 0=문서, 1=사람, 2=저장 상태).
 * `y-websocket`을 쓰지 않는 이유는 서버 쪽과 같다: 우리가 다루는 것이 몇 가지뿐이라
 * 남의 규약을 들이는 것보다 우리 것이 분명하다.
 *
 * **저장은 서버가 한다.** 이 컴포넌트는 저장을 모른다 — 변경을 보내면 서버가 유휴를
 * 보고 버전을 남긴다 (FR-706). 화면에 저장 버튼이 남아 있는 것은 "지금 남겨 달라"를
 * 말하기 위해서다.
 */

/** 사람마다 다른 색. 이름의 글자 코드로 정해 **같은 사람은 늘 같은 색**이 되게 한다 */
function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 45%)`;
}

/** `refused` — 서버의 관문이 이 화면의 편집을 받지 않고 끊었다 (P9_설계서_Gate D.6). 다시 붙어도 같은 편집은 다시 거절된다 */
export type CollabState = 'connecting' | 'live' | 'offline' | 'refused';

export function CollabEditor({
  pageId,
  me,
  editable = true,
  onPeers,
  onState,
  onSaveBlocked,
}: {
  pageId: string;
  me: { id: string; displayName: string };
  editable?: boolean;
  onPeers?: (names: string[]) => void;
  onState?: (s: CollabState) => void;
  /** 서버가 이 문서의 자동 저장이 멈췄다고(까닭), 또는 풀렸다고(`null`) 알렸다 (P9 FR-1011) */
  onSaveBlocked?: (reason: string | null) => void;
}) {
  const ydoc = useMemo(() => new Y.Doc(), [pageId]);
  const awareness = useMemo(() => new Awareness(ydoc), [ydoc]);
  const socketRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<CollabState>('connecting');
  // 알림 받는 함수가 바뀌어도 다시 붙지 않게 참조로 둔다 — 연결 효과의 의존에 넣으면 부모가 다시 그릴 때마다 끊고 붙는다
  const onSaveBlockedRef = useRef(onSaveBlocked);
  onSaveBlockedRef.current = onSaveBlocked;

  useEffect(() => {
    onState?.(state);
  }, [state, onState]);

  useEffect(() => {
    // **같은 오리진의 WebSocket이다.** 주소를 설정으로 두지 않는다 — 앱과 같은 서버라
    // 값을 따로 두면 그것이 어긋나는 날이 온다 (5절 하드코딩 금지의 예외: 자기 자신)
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/api/ws/pages/${pageId}`);
    ws.binaryType = 'arraybuffer';
    socketRef.current = ws;

    const send = (kind: number, payload: Uint8Array): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const frame = new Uint8Array(payload.length + 1);
      frame[0] = kind;
      frame.set(payload, 1);
      ws.send(frame);
    };

    const onDocUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === 'remote') return; // 받은 것을 되돌려 보내지 않는다
      send(COLLAB_MSG.update, update);
    };
    const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }): void => {
      send(COLLAB_MSG.awareness, encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]));
    };

    ws.onopen = () => {
      setState('live');
      awareness.setLocalStateField('user', { name: me.displayName, color: colorFor(me.displayName) });
      // 내가 가진 것을 먼저 보낸다. 서버가 전체 상태를 돌려주므로 둘이 합쳐진다
      send(COLLAB_MSG.update, Y.encodeStateAsUpdate(ydoc));
      send(COLLAB_MSG.awareness, encodeAwarenessUpdate(awareness, [ydoc.clientID]));
    };
    ws.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      const data = new Uint8Array(ev.data);
      if (data.length < 1) return;
      const body = data.subarray(1);
      if (data[0] === COLLAB_MSG.update) Y.applyUpdate(ydoc, body, 'remote');
      else if (data[0] === COLLAB_MSG.awareness) applyAwarenessUpdate(awareness, body, 'remote');
      else if (data[0] === COLLAB_MSG.status) {
        // 서버가 알린 저장 상태 (FR-1011). 읽지 못하면 무시한다 — 이 알림 때문에 편집이 멈추면 안 된다
        try {
          const status = JSON.parse(new TextDecoder().decode(body)) as CollabStatus;
          onSaveBlockedRef.current?.(typeof status.saveBlocked === 'string' ? status.saveBlocked : null);
        } catch {
          /* 무시 */
        }
      }
    };
    // **끊기면 그렇다고 말한다.** 조용히 끊기면 사람은 계속 쓰고 있는데 아무에게도
    // 안 가고, 새로고침하면 그 내용이 사라진다 — 가장 나쁜 실패다
    // **거절로 끊긴 것은 따로 말한다** (P9 FR-1005). 그냥 끊긴 것과 달리 같은 편집을 다시 보내도 다시 거절된다
    ws.onclose = (ev: CloseEvent) => setState((prev) => (prev === 'refused' || ev.code === COLLAB_CLOSE_REFUSED ? 'refused' : 'offline'));
    ws.onerror = () => setState((prev) => (prev === 'refused' ? prev : 'offline'));

    ydoc.on('update', onDocUpdate);
    awareness.on('update', onAwareness);

    return () => {
      ydoc.off('update', onDocUpdate);
      // **퇴장을 먼저 알리고 그다음에 듣기를 멈춘다.** 순서를 뒤집으면 내가 나간 것이
      // 전파되지 않아 남의 화면에 내 이름과 커서가 30초까지 남는다 (자체 점검 29)
      removeAwarenessStates(awareness, [ydoc.clientID], 'unmount');
      awareness.off('update', onAwareness);
      // **옛 연결의 소식은 더 듣지 않는다.** 다시 붙을 때(이름이 바뀌어 이 효과가 다시 돌 때) 옛 연결이 늦게 닫히며
      // 새 연결이 살아 있는 화면에 "연결이 끊겼다"를 띄웠다 (P9 코드 리뷰 7)
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      onSaveBlockedRef.current?.(null);
    };
  }, [pageId, ydoc, awareness, me.displayName]);

  // 같이 보고 있는 사람 — 나를 뺀 목록
  useEffect(() => {
    const report = (): void => {
      const names: string[] = [];
      awareness.getStates().forEach((s, clientId) => {
        if (clientId === ydoc.clientID) return;
        const u = (s as { user?: { name?: string } }).user;
        if (u?.name) names.push(u.name);
      });
      onPeers?.(names);
    };
    awareness.on('change', report);
    report();
    return () => awareness.off('change', report);
  }, [awareness, ydoc, onPeers]);

  const editor = useEditor(
    {
      extensions: [
        // 보기·편집용과 **같은 목록**에 실행 취소만 끈다 — Yjs가 자기 실행 취소를 들고 있다 (P9 D.7)
        ...editorExtensions({ collab: true }),
        Collaboration.configure({ document: ydoc }),
        CollaborationCaret.configure({ provider: { awareness } as never }),
      ],
      editable,
    },
    [ydoc, awareness],
  );

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  return <EditorContent className={editable ? 'editor' : 'editor readonly'} editor={editor} />;
}
