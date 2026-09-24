import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { DocNode, PageView } from '@workfluence/shared';
import { ApiError, api } from '../api';
import { useAuth } from '../auth';
import { CollabEditor, type CollabState } from '../components/CollabEditor';
import { Editor } from '../components/Editor';

type Conflict = { currentVersionNo: number; baseVersionNo: number; message: string };

/**
 * 편집 (FR-342, FR-343).
 *
 * **충돌하면 안내만 하고 덮어쓰기 버튼을 주지 않는다.** 한 번 허용하면 남의 저장을 지우는
 * 것이 정상 동작이 된다. 최신을 불러와 다시 편집하게 한다.
 */
export function PageEditorPage() {
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

  const load = () => {
    setConflict(null);
    setError(null);
    setSaveError(null);
    api<PageView>(`/api/pages/${id}`)
      .then((p) => {
        setPage(p);
        setDoc(p.content);
        setTitle(p.title);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, [id]);
  useEffect(() => {
    api<{ collabEnabled: boolean }>('/api/auth/config')
      .then((c) => setCollab(c.collabEnabled))
      .catch(() => setCollab(false)); // 못 물어보면 단독 편집으로 간다 — 못 쓰는 것보다 낫다
  }, []);
  const onPeers = useCallback((names: string[]) => setPeers(names), []);
  const onState = useCallback((s: CollabState) => setLink(s), []);
  const onSaveBlocked = useCallback((r: string | null) => setSaveBlocked(r), []);

  const save = async () => {
    // **실시간 편집에서는 서버가 이미 저장하고 있다.** 여기서 또 PATCH를 보내면
    // 화면이 들고 있는 낡은 문서로 덮어써 남의 편집을 지운다 — 보기로 가기만 한다
    if (collab) {
      // **지금 바로 남긴다.** 화면이 그렇게 약속했으므로 그대로 해야 한다 —
      // 유휴를 기다리게 하면 눌러도 아무 일이 없는 것처럼 보인다
      setBusy(true);
      setSaveError(null);
      try {
        const r = await api<{ saved: boolean; reason: string }>(`/api/pages/${id}/collab/flush`, { method: 'POST', json: { title } });
        // **저장되지 않았으면 넘어가지 않는다.** 연결이 끊긴 채 누르거나 문서가 검증을
        // 통과하지 못하면 `saved: false`가 오는데, 전에는 그 값을 보지도 않고 보기로
        // 넘어갔다 — 사용자는 저장됐다고 믿고 화면에는 옛 내용이 뜬다 (P6 코드 리뷰 5a).
        // **왜 안 됐는지도 말한다** — "저장이 안 됐다"만으로는 무엇을 고쳐야 할지 모른다
        if (!r.saved) {
          setSaveError(r.reason ? `저장되지 않았다: ${r.reason}` : '저장되지 않았다. 쓰던 내용을 다른 곳에 복사한 뒤 새로고침한다');
          setBusy(false);
          return;
        }
      } catch (e) {
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

  if (error) return <main className="shell"><p className="badge fail" role="alert">{error}</p><Link to="/">← 목록</Link></main>;
  if (!page || !doc || collab === null) return <main className="shell"><p className="muted">불러오는 중…</p></main>;

  return (
    <main className="shell">
      <p className="muted small"><Link to={`/pages/${id}`}>← 보기로</Link></p>
      <h1>페이지 편집</h1>

      {conflict && (
        <section className="card" role="alert">
          <h2 className="badge fail">다른 사람이 먼저 저장했다</h2>
          <p>{conflict.message}</p>
          <p className="muted small">
            내가 편집을 시작한 버전 v{conflict.baseVersionNo} · 현재 서버 버전 v{conflict.currentVersionNo}
          </p>
          {/* 덮어쓰기 버튼을 두지 않는다 (FR-343) */}
          <button type="button" onClick={load}>최신 내용 불러오기</button>
          <p className="muted small">지금 쓴 내용은 사라진다. 필요하면 다른 곳에 복사해 둔 뒤 눌러야 한다.</p>
        </section>
      )}

      <section className="card">
        <label htmlFor="ed-title">제목</label>
        <input id="ed-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <label htmlFor="ed-body">본문</label>
        <div id="ed-body">
          {collab && me ? (
            <CollabEditor pageId={id} me={{ id: me.id, displayName: me.displayName }} onPeers={onPeers} onState={onState} onSaveBlocked={onSaveBlocked} />
          ) : (
            <Editor value={page.content} onChange={setDoc} />
          )}
        </div>

        {collab ? (
          <>
            <p className="muted small" role="status">
              {link === 'live' && (peers.length ? `같이 보는 사람: ${peers.join(', ')}` : '같이 보는 사람 없음')}
              {link === 'connecting' && '연결 중…'}
              {/* **끊긴 것을 반드시 말한다.** 조용히 끊기면 계속 쓰는데 아무에게도 안 가고,
                  새로고침하면 그 내용이 사라진다 — 가장 나쁜 실패다 */}
              {link === 'offline' && (
                <strong className="badge fail">
                  연결이 끊겼다. 지금 쓰는 내용은 저장되지 않는다 — 다른 곳에 복사한 뒤 새로고침한다
                </strong>
              )}
              {/* **거절로 끊긴 것은 따로 말한다** (P9 FR-1005). 다시 붙어도 같은 편집은 다시 거절된다 —
                  무엇이 걸렸는지는 관리자가 감사로그에서 본다 */}
              {link === 'refused' && (
                <strong className="badge fail">
                  서버가 이 편집을 받지 않았다. 쓰던 내용을 다른 곳에 복사한 뒤 새로고침한다 — 계속되면 관리자에게 알린다
                </strong>
              )}
              {/* **자동 저장이 멈춘 것도 말한다** (P9 FR-1011). 편집은 동료에게 계속 보여 저장되는 줄 알기 쉽다 */}
              {saveBlocked !== null && link !== 'refused' && (
                <strong className="badge fail">
                  자동 저장이 멈췄다: {saveBlocked}. 고치기 전에는 버전이 남지 않는다 — 모르겠으면 쓰던 내용을 복사해 두고 관리자에게 알린다
                </strong>
              )}
            </p>
            <p className="muted small">
              쓰는 대로 자동으로 저장된다. 저장 버튼은 <strong>지금 바로</strong> 남기고 보기로 갈 때 쓴다.
            </p>
          </>
        ) : (
          <p className="muted small">편집을 시작한 버전: v{page.currentVersionNo}</p>
        )}

        {/* 끊긴 상태에서 누르면 **저장되지 않는다.** 누를 수 있게 두면 "눌렀으니 됐다"가 된다 */}
        {saveError && (
          <p className="badge fail" role="alert">
            {saveError}
          </p>
        )}
        <button type="button" onClick={() => void save()} disabled={busy || conflict !== null || (collab && (link === 'offline' || link === 'refused'))}>
          {busy ? '저장 중…' : collab ? '저장하고 보기로' : '저장'}
        </button>
      </section>
    </main>
  );
}
