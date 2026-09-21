import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { PageSummary, SpaceMemberView, SpaceView } from '@workfluence/shared';
import { api } from '../api';
import { EMPTY_DOC } from '../components/Editor';

/** 스페이스 화면 (FR-341): 페이지 트리 + Crew 패널 */
export function SpacePage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [space, setSpace] = useState<SpaceView | null>(null);
  const [tree, setTree] = useState<PageSummary[]>([]);
  const [crew, setCrew] = useState<SpaceMemberView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [username, setUsername] = useState('');

  const load = useCallback(() => {
    setError(null);
    api<SpaceView>(`/api/spaces/${id}`)
      .then(async (s) => {
        setSpace(s);
        setTree(await api<PageSummary[]>(`/api/pages?spaceId=${id}`));
        if (s.kind === 'team') setCrew(await api<SpaceMemberView[]>(`/api/spaces/${id}/members`));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const addPage = async (e: FormEvent) => {
    e.preventDefault();
    await act(async () => {
      const p = await api<PageSummary>('/api/pages', { method: 'POST', json: { spaceId: id, title, content: EMPTY_DOC } });
      setTitle('');
      nav(`/pages/${p.id}/edit`);
    });
  };

  if (error && !space) return <main className="shell"><p className="badge fail" role="alert">{error}</p><Link to="/">← 목록</Link></main>;
  if (!space) return <main className="shell"><p className="muted">불러오는 중…</p></main>;

  // 트리를 부모-자식으로 접는다. 깊이는 서버가 10으로 제한한다
  const children = (parentId: string | null) => tree.filter((p) => p.parentId === parentId);
  const render = (parentId: string | null, depth: number): React.ReactNode =>
    children(parentId).map((p) => (
      <li key={p.id} style={{ marginLeft: depth * 16 }}>
        <Link to={`/pages/${p.id}`}>{p.title}</Link> <span className="muted small">v{p.currentVersionNo}</span>
        <ul>{render(p.id, depth + 1)}</ul>
      </li>
    ));

  return (
    <main className="shell">
      <p className="muted small"><Link to="/">← 스페이스 목록</Link></p>
      <h1>{space.name}</h1>
      <p className="muted small">
        {space.kind === 'personal' ? '개인' : '팀'} · {space.key}
        {space.status !== 'active' && <span className="badge fail"> 중지됨 — 읽기만 된다</span>}
      </p>
      {error && <p className="badge fail" role="alert">{error}</p>}

      <section className="card">
        <h2>페이지</h2>
        <ul>{render(null, 0)}</ul>
        {tree.length === 0 && <p className="muted">아직 페이지가 없다.</p>}
        {space.access.canWrite && (
          <form onSubmit={addPage}>
            <label htmlFor="pg-title">새 페이지 제목</label>
            <input id="pg-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
            <button type="submit">만들기</button>
          </form>
        )}
      </section>

      {space.kind === 'team' && (
        <section className="card">
          <h2>Crew</h2>
          <ul>
            {crew.map((m) => (
              <li key={m.userId}>
                {m.displayName} <span className="muted small">({m.username})</span> — {m.role}
                {space.access.canManageMembers && m.role !== 'owner' && (
                  <button type="button" onClick={() => void act(() => api(`/api/spaces/${id}/members/${m.userId}`, { method: 'DELETE' }))}>
                    제거
                  </button>
                )}
              </li>
            ))}
          </ul>
          {space.access.canManageMembers && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await api(`/api/spaces/${id}/members`, { method: 'POST', json: { username, role: 'editor' } });
                  setUsername('');
                });
              }}
            >
              <label htmlFor="crew-user">아이디로 Crew 추가 (editor)</label>
              <input id="crew-user" value={username} onChange={(e) => setUsername(e.target.value)} required />
              <button type="submit">추가</button>
            </form>
          )}
        </section>
      )}
    </main>
  );
}
