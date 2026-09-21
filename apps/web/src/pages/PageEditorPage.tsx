import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { DocNode, PageView } from '@workfluence/shared';
import { ApiError, api } from '../api';
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

  const save = async () => {
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
  if (!page || !doc) return <main className="shell"><p className="muted">불러오는 중…</p></main>;

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
          <Editor value={page.content} onChange={setDoc} />
        </div>
        <p className="muted small">편집을 시작한 버전: v{page.currentVersionNo}</p>
        <button type="button" onClick={() => void save()} disabled={busy || conflict !== null}>
          {busy ? '저장 중…' : '저장'}
        </button>
      </section>
    </main>
  );
}
