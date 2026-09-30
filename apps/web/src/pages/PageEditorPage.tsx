import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import * as Y from 'yjs';
import { COLLAB_LIMITS, type DocNode, type PageView, type SpaceView } from '@workfluence/shared';
import { ApiError, api } from '../api';
import { useAuth } from '../auth';
import { CollabEditor, type CollabState } from '../components/CollabEditor';
import { EDIT_SCROLL_MARGIN, Editor } from '../components/Editor';
import { Breadcrumbs, Field, Loading, Notice, Page, PageHeader, StatusBadge, useDocumentTitle, useReadWide } from '../components/ui';
import { SideSlot } from '../layout/AppLayout';
import { SpaceSideNav } from '../layout/SpaceSideNav';

type Conflict = { currentVersionNo: number; baseVersionNo: number; message: string };

const HEADING = '페이지 편집';
const LOAD_FAILED_TITLE = '페이지를 열 수 없다';
/** 본문 칸의 보이는 라벨 — 편집기가 이 id로 이름을 받는다(`label htmlFor`는 편집기의 div를 가리킬 수 없다 — P17 J.7) */
const BODY_LABEL_ID = 'ed-body-label';

/** 실시간 편집에서 제목 입력을 멈추고 이만큼 뒤에 방에 알린다 (P13 FR-1460) */
const TITLE_SEND_DELAY_MS = 1000;

/** base64로 — 저장하고 보기로가 싣는 스냅숏. 한꺼번에 펼치면 큰 값에서 호출 스택을 넘으므로 나눠 옮긴다 */
const toBase64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/**
 * 화면 문서의 **스냅숏**(상태 벡터 + 지운 기록) — 서버가 그만큼 받았는지 본다 (P13 D.7). 상태 벡터만 보내면 지우기만 한 입력을 놓친다(좁은
 * 자체 점검 2). 상한(`COLLAB_LIMITS.maxFlushSnapshotChars`)을 넘으면 싣지 않는다 — 서버는 판정을 건너뛰고, 저장은 막지 않는다
 */
const snapshotOf = (doc: Y.Doc | null): string | undefined => {
  if (!doc || doc.isDestroyed) return undefined;
  const b64 = toBase64(Y.encodeSnapshot(Y.snapshot(doc)));
  return b64.length <= COLLAB_LIMITS.maxFlushSnapshotChars ? b64 : undefined;
};

/**
 * 편집 (FR-342, FR-343).
 *
 * **충돌하면 안내만 하고 덮어쓰기 버튼을 주지 않는다.** 한 번 허용하면 남의 저장을 지우는
 * 것이 정상 동작이 된다. 최신을 불러와 다시 편집하게 한다.
 *
 * 모양은 P17 설계서 J.3.1·J.6(FR-1860)이다 — 한 틀 안에 회색 바탕(`.edit-canvas`)과 위 막대 아래에 붙는 **편집 줄**(← 보기로 · 연결 상태 · 저장
 * 방식), 그 아래 연결 끊김·거절·자동 저장 멈춤·충돌·저장 실패의 알림띠, 흰 종이(`.paper` — 넓게 보기면 `.paper.wide`, 보기 화면과 같은 값) 안에
 * 빵부스러기(스페이스 / 페이지) · h1 · 제목 칸 · 본문 칸. 편집 줄은 스크롤해도 붙어 있어 저장 단추와 연결 상태가 늘 보인다. 왼쪽 칸은 스페이스 문맥
 * (페이지 트리)이다
 */
export function PageEditorPage() {
  const { id = '' } = useParams();
  // **페이지마다 새로 만든다** (P17 병합 전 검토 14) — 같은 경로의 다른 id로 곧바로 옮겨 가면(뒤로 가기 등) 이 화면이 그대로 남아 앞 페이지의
  // 제목·본문·보낸 제목·연결 상태를 들고 있을 수 있었다. 트리의 링크는 보기로 가므로 편집 화면끼리 옮기는 일은 드물어 왼쪽 칸도 함께 새로 만든다
  return <PageEditorScreen key={id} />;
}

function PageEditorScreen() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { me } = useAuth();
  // 실시간 편집이 켜져 있는지는 **서버가 말해 준다** (FR-711). 화면이 짐작하면
  // 꺼진 서버에 WebSocket을 열려다 실패하고 사용자는 이유를 알 수 없다
  const [collab, setCollab] = useState<boolean | null>(null);
  const [peers, setPeers] = useState<string[]>([]);
  const [link, setLink] = useState<CollabState>('connecting');
  // 서버가 알린 **자동 저장이 멈춘 까닭** (P9 FR-1011). 풀리면 `null`
  const [saveBlocked, setSaveBlocked] = useState<string | null>(null);
  const [page, setPage] = useState<PageView | null>(null);
  const [doc, setDoc] = useState<DocNode | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  // **저장 실패는 편집기 옆에 말한다** — 불러오기 실패(`error`)처럼 화면 전체를 갈아 치우면 편집기가 사라져 "쓰던 내용을 복사해
  // 두라"를 따를 수 없었다 (P9 두 번째 자체 점검 2)
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [busy, setBusy] = useState(false);
  // 실시간 편집을 끈 화면에서 사람이 본문을 고쳤는가 — 떠나기 전에 묻는다(아래)
  const [bodyEdited, setBodyEdited] = useState(false);
  // 빵부스러기의 스페이스 이름 — 읽지 못해도 편집은 된다(빵부스러기만 빠진다)
  const [space, setSpace] = useState<SpaceView | null>(null);
  const [wide, toggleWide] = useReadWide();
  useDocumentTitle(error ? LOAD_FAILED_TITLE : HEADING);
  // 본문 칸의 라벨을 누르면 편집기로 간다 — 입력 요소의 라벨이 하는 일을 대신한다
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const load = () => {
    setConflict(null);
    setError(null);
    setSaveError(null);
    setBodyEdited(false);
    api<PageView>(`/api/pages/${id}`)
      .then((p) => {
        setPage(p);
        setDoc(p.content);
        setTitle(p.title);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, [id]);
  const spaceId = page?.spaceId;
  useEffect(() => {
    if (!spaceId) return;
    let alive = true;
    api<SpaceView>(`/api/spaces/${spaceId}`)
      .then((s) => {
        if (alive) setSpace(s);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [spaceId]);
  useEffect(() => {
    api<{ collabEnabled: boolean }>('/api/auth/config')
      .then((c) => setCollab(c.collabEnabled))
      .catch(() => setCollab(false)); // 못 물어보면 단독 편집으로 간다 — 못 쓰는 것보다 낫다
  }, []);
  // **실시간 편집에서는 제목도 방에 알린다** (P13 FR-1460) — 입력을 멈추고 잠시 뒤. 예전에는 "저장하고 보기로"를 눌러야만 서버에 가서,
  // 제목만 고치고 창을 닫으면 사라졌다. 처음 불러온 제목은 보내지 않는다. **방이 받았다고 답해야 보낸 것으로 친다** — 받지 못했으면(방이 없다·
  // 실패) "저장하고 보기로"가 제목을 싣는다 (병합 전 자체 점검 2)
  const sentTitle = useRef<string | null>(null);
  // 입력을 멈추기를 기다리는 제목 — 떠날 때 보낸다(아래)
  const pendingTitle = useRef<string | null>(null);
  // 그 제목을 보낼 타이머 — "저장하고 보기로"가 제목을 실으면 끈다. 끄지 않으면 저장이 1초를 넘길 때 같은 제목이 한 번 더 가서 그 사이 동료가
  // 바꾼 제목을 되돌린다 (좁은 자체 점검 4)
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendTitle = useCallback(
    (t: string, keepalive = false) => {
      pendingTitle.current = null;
      void api<{ applied: boolean }>(`/api/pages/${id}/collab/title`, { method: 'POST', json: { title: t }, keepalive })
        .then((r) => {
          if (r?.applied) sentTitle.current = t;
        })
        .catch(() => undefined);
    },
    [id],
  );
  useEffect(() => {
    if (!collab || !page) return;
    const t = title.trim();
    if (!t || t === (sentTitle.current ?? page.title)) {
      pendingTitle.current = null;
      return;
    }
    pendingTitle.current = t;
    const timer = setTimeout(() => sendTitle(t), TITLE_SEND_DELAY_MS);
    titleTimer.current = timer;
    return () => clearTimeout(timer);
  }, [collab, page, title, sendTitle]);
  // **떠나기 전에 보낸다** (병합 전 코드 리뷰 4) — 입력을 멈추고 1초가 되기 전에 "← 보기로"를 누르거나 창을 닫으면 보내지 않았다. 창을 닫을
  // 때도 가도록 `keepalive`로 보낸다
  useEffect(() => {
    const flushPending = () => {
      const t = pendingTitle.current;
      if (t) sendTitle(t, true);
    };
    window.addEventListener('pagehide', flushPending);
    return () => {
      window.removeEventListener('pagehide', flushPending);
      flushPending();
    };
  }, [sendTitle]);
  // 실시간 편집기의 문서 — 저장하고 보기로가 스냅숏을 싣는다 (P13 D.7)
  const ydoc = useRef<Y.Doc | null>(null);
  const onDoc = useCallback((d: Y.Doc | null) => {
    ydoc.current = d;
  }, []);
  const onPeers = useCallback((names: string[]) => setPeers(names), []);
  const onState = useCallback((s: CollabState) => setLink(s), []);
  const onSaveBlocked = useCallback((r: string | null) => setSaveBlocked(r), []);

  // **실시간 편집을 끈 화면은 저장하지 않은 편집이 있으면 창을 닫거나 새로 고치기 전에 묻는다** (P17 병합 전 검토 18). 실시간 편집은 서버가 쓰는 대로
  // 저장하므로 묻지 않는다. 본문은 편집기가 사람이 고쳤다고 알릴 때만 친다(`onEdit` — 처음 그릴 때 편집기가 다듬어 알리는 값은 고친 것이 아니다).
  // 앱 안의 링크(왼쪽 칸의 트리·위 막대)로 떠나는 것은 막지 못한다 — 그것을 막는 `useBlocker`는 데이터 라우터(`createBrowserRouter`)에서만 되고
  // 이 앱은 `BrowserRouter`다(`App.tsx`). 라우터를 바꾸는 것은 모든 경로를 다시 짜는 일이라 이번에 하지 않는다
  const unsaved = collab === false && page !== null && (title !== page.title || bodyEdited);
  useEffect(() => {
    if (!unsaved) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chrome·Edge 119 전은 이 값이 있어야 묻는다
      e.returnValue = true;
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [unsaved]);

  const save = async () => {
    // **실시간 편집에서는 서버가 이미 저장하고 있다.** 여기서 또 PATCH를 보내면
    // 화면이 들고 있는 낡은 문서로 덮어써 남의 편집을 지운다 — 보기로 가기만 한다
    if (collab) {
      // **지금 바로 남긴다.** 화면이 그렇게 약속했으므로 그대로 해야 한다 —
      // 유휴를 기다리게 하면 눌러도 아무 일이 없는 것처럼 보인다
      setBusy(true);
      setSaveError(null);
      // **제목은 이 화면에서 고친 것이 아직 방에 가지 않았을 때만 보낸다** (P13 FR-1463, 병합 전 검토). 동료가 먼저 바꾼 제목은 이 화면의
      // 제목 칸에 옛 제목으로 남아 있다(제목 칸은 동료의 화면에 곧바로 바뀌지 않는다 — 설계서 A.1-8). 늘 보내면 누르는 순간 새 제목을 옛 제목으로
      // 되돌렸고, 처음 불러온 제목과 견주면 한 번 고쳐 이미 보낸 뒤에도 늘 보냈다 — **마지막으로 방이 받은 제목과 견준다**
      const t = title.trim();
      const edited = page !== null && t !== (sentTitle.current ?? page.title);
      if (edited) {
        // 이 요청이 싣는다 — 기다리던 제목과 그 타이머를 거둔다
        pendingTitle.current = null;
        if (titleTimer.current) clearTimeout(titleTimer.current);
      }
      // **화면의 스냅숏을 싣는다** — 서버가 그만큼(넣은 것도 지운 것도) 받지 못했으면 저장했다고 답하지 않는다(끊긴 줄 모르는 연결)
      const snapshot = snapshotOf(ydoc.current);
      // 저장되지 않았으면 싣고 간 제목을 다시 기다리게 둔다 — 서버는 그 제목을 적용하기 전에 답한다. 떠날 때 보낸다(위)
      const keepTitle = () => {
        if (edited) pendingTitle.current = t;
      };
      try {
        const r = await api<{ saved: boolean; reason: string }>(`/api/pages/${id}/collab/flush`, {
          method: 'POST',
          json: { ...(edited ? { title: t } : {}), ...(snapshot ? { snapshot } : {}) },
        });
        if (r.saved && edited) sentTitle.current = t;
        // **저장되지 않았으면 넘어가지 않는다.** 연결이 끊긴 채 누르거나 문서가 검증을
        // 통과하지 못하면 `saved: false`가 오는데, 전에는 그 값을 보지도 않고 보기로
        // 넘어갔다 — 사용자는 저장됐다고 믿고 화면에는 옛 내용이 뜬다 (P6 코드 리뷰 5a).
        // **왜 안 됐는지도 말한다** — "저장이 안 됐다"만으로는 무엇을 고쳐야 할지 모른다
        if (!r.saved) {
          keepTitle();
          setSaveError(r.reason ? `저장되지 않았다: ${r.reason}` : '저장되지 않았다. 쓰던 내용을 다른 곳에 복사한 뒤 새로고침한다');
          setBusy(false);
          return;
        }
      } catch (e) {
        keepTitle();
        setSaveError(e instanceof Error ? e.message : String(e));
        setBusy(false);
        return;
      }
      setBusy(false);
      nav(`/pages/${id}`);
      return;
    }
    if (!page || !doc) return;
    setBusy(true);
    setSaveError(null);
    try {
      await api<PageView>(`/api/pages/${id}`, { method: 'PATCH', json: { title, content: doc, baseVersionNo: page.currentVersionNo } });
      nav(`/pages/${id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const b = e.body as { currentVersionNo: number; baseVersionNo: number; message: string };
        setConflict(b);
      } else {
        setSaveError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Page width="read">
        <PageHeader title={LOAD_FAILED_TITLE} />
        <Notice kind="error">{error}</Notice>
      </Page>
    );
  }
  if (!page || !doc || collab === null) {
    return (
      <>
        <SideSlot>{page ? <SpaceSideNav spaceId={page.spaceId} currentPageId={id} /> : <Loading />}</SideSlot>
        <Loading />
      </>
    );
  }

  // 앞 페이지의 스페이스가 남아 있으면 쓰지 않는다 — 다른 스페이스의 페이지로 옮긴 사이 이름이 섞이지 않게
  const here = space && space.id === page.spaceId ? space : null;
  const offline = collab && (link === 'offline' || link === 'refused');
  const blocked = collab && saveBlocked !== null && link !== 'refused';

  return (
    <>
      <SideSlot>
        <SpaceSideNav spaceId={page.spaceId} currentPageId={id} />
      </SideSlot>
      <div className="edit-canvas">
        <div className="edit-bar">
          <Link to={`/pages/${id}`}>← 보기로</Link>
          {collab ? (
            <>
              <span className="muted" role="status">
                {link === 'live' && (peers.length ? `같이 보는 사람: ${peers.join(', ')}` : '같이 보는 사람 없음')}
                {link === 'connecting' && '연결 중…'}
              </span>
              {/* 끊긴 것은 붙어 있는 이 줄에도 보인다 — 긴 문서를 내려가며 쓰면 아래의 알림띠가 화면 밖에 있다. 까닭의 문장은 알림띠가 말한다 */}
              {offline && <StatusBadge kind="bad">연결 끊김</StatusBadge>}
              {blocked && <StatusBadge kind="paused">자동 저장 멈춤</StatusBadge>}
            </>
          ) : (
            <span className="muted">편집을 시작한 버전: v{page.currentVersionNo}</span>
          )}
          <span className="grow" />
          <button type="button" className="subtle" aria-pressed={wide} onClick={toggleWide}>
            넓게 보기
          </button>
          {collab && <span className="muted">쓰는 대로 자동으로 저장된다</span>}
          {/* 끊긴 상태에서 누르면 **저장되지 않는다.** 누를 수 있게 두면 "눌렀으니 됐다"가 된다 */}
          <button
            type="button"
            className="primary"
            title={collab ? '지금 바로 버전을 남기고 보기로 간다' : undefined}
            onClick={() => void save()}
            disabled={busy || conflict !== null || offline}
          >
            {busy ? '저장 중…' : collab ? '저장하고 보기로' : '저장'}
          </button>
        </div>

        {conflict && (
          <Notice kind="error" role="alert">
            <p>
              <strong>다른 사람이 먼저 저장했다</strong>
            </p>
            <p>{conflict.message}</p>
            <p className="small">
              내가 편집을 시작한 버전 v{conflict.baseVersionNo} · 현재 서버 버전 v{conflict.currentVersionNo}
            </p>
            <p className="small">지금 쓴 내용은 사라진다. 필요하면 다른 곳에 복사해 둔 뒤 눌러야 한다.</p>
            {/* 덮어쓰기 버튼을 두지 않는다 (FR-343) */}
            <div className="actions">
              <button type="button" onClick={load}>
                최신 내용 불러오기
              </button>
            </div>
          </Notice>
        )}
        {/* **끊긴 것을 반드시 말한다.** 조용히 끊기면 계속 쓰는데 아무에게도 안 가고,
            새로고침하면 그 내용이 사라진다 — 가장 나쁜 실패다. 세 알림은 전에 연결 상태(`status`) 안에 있던 문장 그대로다 */}
        {collab && link === 'offline' && (
          <Notice kind="error" role="status">
            연결이 끊겼다. 지금 쓰는 내용은 저장되지 않는다 — 다른 곳에 복사한 뒤 새로고침한다
          </Notice>
        )}
        {/* **거절로 끊긴 것은 따로 말한다** (P9 FR-1005). 다시 붙어도 같은 편집은 다시 거절된다 —
            무엇이 걸렸는지는 관리자가 감사로그에서 본다 */}
        {collab && link === 'refused' && (
          <Notice kind="error" role="status">
            서버가 이 편집을 받지 않았다. 쓰던 내용을 다른 곳에 복사한 뒤 새로고침한다 — 계속되면 관리자에게 알린다
          </Notice>
        )}
        {/* **자동 저장이 멈춘 것도 말한다** (P9 FR-1011). 편집은 동료에게 계속 보여 저장되는 줄 알기 쉽다 */}
        {blocked && (
          <Notice kind="error" role="status">
            자동 저장이 멈췄다: {saveBlocked}. 풀리기 전에는 버전이 남지 않는다 — 모르겠으면 쓰던 내용을 복사해 두고 관리자에게 알린다
          </Notice>
        )}
        {saveError && <Notice kind="error">{saveError}</Notice>}

        <div className={wide ? 'paper wide' : 'paper'}>
          {here && <Breadcrumbs items={[{ label: here.name, to: `/spaces/${page.spaceId}` }, { label: page.title }]} />}
          <h1>{HEADING}</h1>
          <Field id="ed-title" label="제목" required>
            <input id="ed-title" className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <div className="field">
            {/* 편집기는 입력 요소가 아니라 `htmlFor`로 묶이지 않는다 — 편집기가 이 라벨을 `aria-labelledby`로 가리키고, 누르면 편집기로 간다 */}
            <label id={BODY_LABEL_ID} onClick={() => bodyRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus()}>
              본문
            </label>
            {/* 서식 단추 줄은 본문 칸 바로 위 — 편집기 부품이 그린다(P19 F-013, `toolbar="full"`). 편집 줄 아래에 붙는다(A.1-17) */}
            <div ref={bodyRef}>
              {collab && me ? (
                <CollabEditor
                  pageId={id}
                  me={{ id: me.id, displayName: me.displayName }}
                  onPeers={onPeers}
                  onState={onState}
                  onSaveBlocked={onSaveBlocked}
                  onDoc={onDoc}
                  labelledBy={BODY_LABEL_ID}
                  scrollMargin={EDIT_SCROLL_MARGIN}
                  toolbar="full"
                />
              ) : (
                <Editor
                  value={page.content}
                  onChange={setDoc}
                  onEdit={() => setBodyEdited(true)}
                  labelledBy={BODY_LABEL_ID}
                  scrollMargin={EDIT_SCROLL_MARGIN}
                  toolbar="full"
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
