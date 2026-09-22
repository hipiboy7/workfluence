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
  const [page, setPage] = useState<PageView | null>(null);
  const [doc, setDoc] = useState<DocNode | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setConflict(null);
    setError(null);
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

  const save = async () => {
    // **실시간 편집에서는 서버가 이미 저장하고 있다.** 여기서 또 PATCH를 보내면
    // 화면이 들고 있는 낡은 문서로 덮어써 남의 편집을 지운다 — 보기로 가기만 한다
    if (collab) {
      // **지금 바로 남긴다.** 화면이 그렇게 약속했으므로 그대로 해야 한다 —
      // 유휴를 기다리게 하면 눌러도 아무 일이 없는 것처럼 보인다
      setBusy(true);
      try {
        await api(`/api/pages/${id}/collab/flush`, { method: 'POST', json: { title } });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
        return;
      }
      setBusy(false);
      nav(`/pages/${id}`);
      return;
    }
    if (!page || !doc) return;
    setBusy(true);
    setError(null);
    try {
      await api<PageView>(`/api/pages/${id}`, { method: 'PATCH', json: { title, content: doc, baseVersionNo: page.currentVersionNo } });
      nav(`/pages/${id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const b = e.body as { currentVersionNo: number; baseVersionNo: number; message: string };
        setConflict(b);
      } else {
        setError(e instanceof Error ? e.message : String(e));
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
            <CollabEditor pageId={id} me={{ id: me.id, displayName: me.displayName }} onPeers={onPeers} onState={onState} />
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
            </p>
            <p className="muted small">
              쓰는 대로 자동으로 저장된다. 저장 버튼은 <strong>지금 바로</strong> 남기고 보기로 갈 때 쓴다.
            </p>
          </>
        ) : (
          <p className="muted small">편집을 시작한 버전: v{page.currentVersionNo}</p>
        )}

        <button type="button" onClick={() => void save()} disabled={busy || conflict !== null}>
          {busy ? '저장 중…' : collab ? '저장하고 보기로' : '저장'}
        </button>
      </section>
    </main>
  );
}
