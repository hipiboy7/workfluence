import { EditorContent, useEditor } from '@tiptap/react';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { useEffect, useRef, useState } from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { CollabLink, colorFor, type CollabState } from './collabLink';
import { editorExtensions } from './extensions';

export type { CollabState } from './collabLink';

type Props = {
  pageId: string;
  me: { id: string; displayName: string };
  editable?: boolean;
  onPeers?: (names: string[]) => void;
  onState?: (s: CollabState) => void;
  /** 서버가 이 문서의 자동 저장이 멈췄다고(까닭), 또는 풀렸다고(`null`) 알렸다 (P9 FR-1011) */
  onSaveBlocked?: (reason: string | null) => void;
};

/**
 * 실시간 동시 편집기 (P6_설계서_Collab F절, FR-700·705).
 *
 * **연결은 `collabLink.ts`가 한다** — 소켓·문서·사람 표시를 잇는 상태 기계를 React 밖에 두어 브라우저 없이 시험한다
 * (P9 G절). 이 컴포넌트는 그 연결을 열고 닫고, 편집기를 그린다.
 *
 * **저장은 서버가 한다.** 이 컴포넌트는 저장을 모른다 — 변경을 보내면 서버가 유휴를
 * 보고 버전을 남긴다 (FR-706). 화면에 저장 버튼이 남아 있는 것은 "지금 남겨 달라"를
 * 말하기 위해서다.
 *
 * **문서와 사람 표시는 효과가 만들고 효과가 놓는다** (P9 세 번째 코드 리뷰 4). 사람 표시는 3초마다 도는 타이머를 들고 있어, 놓지 않으면
 * 페이지를 옮겨도 타이머와 문서가 남았다(Phase 6부터). `useMemo`로 만들고 정리 효과에서 놓으면 개발 모드(`StrictMode`)가 효과를
 * 두 번 돌릴 때 **놓은 것을 다시 쓴다** — 그래서 효과 안에서 만든다. 만들어지기 전 한 번은 아무것도 그리지 않는다.
 */
export function CollabEditor(props: Props) {
  const [live, setLive] = useState<{ pageId: string; ydoc: Y.Doc; awareness: Awareness } | null>(null);
  useEffect(() => {
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    setLive({ pageId: props.pageId, ydoc, awareness });
    return () => {
      awareness.destroy();
      ydoc.destroy();
    };
  }, [props.pageId]);
  // 페이지가 바뀐 첫 그리기에는 옛 페이지의 문서가 남아 있다 — 그것으로 새 페이지에 붙으면 옛 내용을 새 페이지에 보낸다.
  // 새 문서가 올 때까지 그리지 않는다
  if (!live || live.pageId !== props.pageId || live.ydoc.isDestroyed) return null;
  return <LiveEditor key={live.ydoc.guid} {...props} ydoc={live.ydoc} awareness={live.awareness} />;
}

function LiveEditor({ pageId, me, editable = true, onPeers, onState, onSaveBlocked, ydoc, awareness }: Props & { ydoc: Y.Doc; awareness: Awareness }) {
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
    const link = new CollabLink({
      url: `${proto}//${window.location.host}/api/ws/pages/${pageId}`,
      doc: ydoc,
      awareness,
      user: { name: me.displayName, color: colorFor(me.displayName) },
      onState: setState,
      onSaveBlocked: (r) => onSaveBlockedRef.current?.(r),
    });
    return () => link.close();
  }, [pageId, ydoc, awareness, me.displayName]);

  // 같이 보고 있는 사람 — 나를 뺀 목록. 나는 **사람 표시의 ID**다 — Yjs가 문서의 ID를 바꿔도 이것은 그대로다 (P9 두 번째 자체 점검 6)
  useEffect(() => {
    const report = (): void => {
      const names: string[] = [];
      awareness.getStates().forEach((s, clientId) => {
        if (clientId === awareness.clientID) return;
        const u = (s as { user?: { name?: string } }).user;
        if (u?.name) names.push(u.name);
      });
      onPeers?.(names);
    };
    awareness.on('change', report);
    report();
    return () => awareness.off('change', report);
  }, [awareness, onPeers]);

  const editor = useEditor(
    {
      extensions: [
        // 보기·편집용과 **같은 목록**에 실행 취소만 끈다 — Yjs가 자기 실행 취소를 들고 있다 (P9 D.7)
        ...editorExtensions({ collab: true }),
        Collaboration.configure({ document: ydoc }),
        // **내 이름·색을 캐럿 설정에도 준다** (P9 세 번째 자체 점검 6). 주지 않으면 뷰를 만들 때 `{name:null,color:null}`을 알리고,
        // 연결(`collabLink`)이 그 뒤에 덮는 순서에 기댄다
        CollaborationCaret.configure({ provider: { awareness } as never, user: { name: me.displayName, color: colorFor(me.displayName) } }),
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
