import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as Y from 'yjs';

/**
 * 실시간 동시 편집기 (P6_설계서_Collab F절, FR-700·705).
 *
 * **서버가 정한 것과 같은 프로토콜을 쓴다** — 앞 한 바이트가 종류다 (0=문서, 1=사람).
 * `y-websocket`을 쓰지 않는 이유는 서버 쪽과 같다: 우리가 다루는 것이 둘뿐이라
 * 남의 규약을 들이는 것보다 우리 것이 분명하다.
 *
 * **저장은 서버가 한다.** 이 컴포넌트는 저장을 모른다 — 변경을 보내면 서버가 유휴를
 * 보고 버전을 남긴다 (FR-706). 화면에 저장 버튼이 남아 있는 것은 "지금 남겨 달라"를
 * 말하기 위해서다.
 */

const MSG_UPDATE = 0;
const MSG_AWARENESS = 1;

/** 사람마다 다른 색. 이름의 글자 코드로 정해 **같은 사람은 늘 같은 색**이 되게 한다 */
function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 45%)`;
}

export type CollabState = 'connecting' | 'live' | 'offline';

export function CollabEditor({
  pageId,
  me,
  editable = true,
  onPeers,
  onState,
}: {
  pageId: string;
  me: { id: string; displayName: string };
  editable?: boolean;
  onPeers?: (names: string[]) => void;
  onState?: (s: CollabState) => void;
}) {
  const ydoc = useMemo(() => new Y.Doc(), [pageId]);
  const awareness = useMemo(() => new Awareness(ydoc), [ydoc]);
  const socketRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<CollabState>('connecting');

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
      send(MSG_UPDATE, update);
    };
    const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }): void => {
      send(MSG_AWARENESS, encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]));
    };

    ws.onopen = () => {
      setState('live');
      awareness.setLocalStateField('user', { name: me.displayName, color: colorFor(me.displayName) });
      // 내가 가진 것을 먼저 보낸다. 서버가 전체 상태를 돌려주므로 둘이 합쳐진다
      send(MSG_UPDATE, Y.encodeStateAsUpdate(ydoc));
      send(MSG_AWARENESS, encodeAwarenessUpdate(awareness, [ydoc.clientID]));
    };
    ws.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      const data = new Uint8Array(ev.data);
      if (data.length < 1) return;
      const body = data.subarray(1);
      if (data[0] === MSG_UPDATE) Y.applyUpdate(ydoc, body, 'remote');
      else if (data[0] === MSG_AWARENESS) applyAwarenessUpdate(awareness, body, 'remote');
    };
    // **끊기면 그렇다고 말한다.** 조용히 끊기면 사람은 계속 쓰고 있는데 아무에게도
    // 안 가고, 새로고침하면 그 내용이 사라진다 — 가장 나쁜 실패다
    ws.onclose = () => setState('offline');
    ws.onerror = () => setState('offline');

    ydoc.on('update', onDocUpdate);
    awareness.on('update', onAwareness);

    return () => {
      ydoc.off('update', onDocUpdate);
      awareness.off('update', onAwareness);
      removeAwarenessStates(awareness, [ydoc.clientID], 'unmount');
      ws.close();
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
        // **`history`를 끈다.** Yjs가 자기 실행 취소를 들고 있어 둘을 같이 두면
        // 내 취소가 남의 편집까지 되돌린다
        StarterKit.configure({ undoRedo: false }),
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
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
