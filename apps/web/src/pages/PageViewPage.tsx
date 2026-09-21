import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { PageView, SpaceView } from '@workfluence/shared';
import { api } from '../api';
import { Attachments } from '../components/Attachments';
import { Comments } from '../components/Comments';
import { Editor } from '../components/Editor';

/** 페이지 보기 */
export function PageViewPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [page, setPage] = useState<PageView | null>(null);
  const [space, setSpace] = useState<SpaceView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<PageView>(`/api/pages/${id}`)
      .then(async (p) => {
        setPage(p);
        setSpace(await api<SpaceView>(`/api/spaces/${p.spaceId}`));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  if (error) return <main className="shell"><p className="badge fail" role="alert">{error}</p><Link to="/">← 목록</Link></main>;
  if (!page) return <main className="shell"><p className="muted">불러오는 중…</p></main>;

  return (
    <main className="shell">
      <p className="muted small"><Link to={`/spaces/${page.spaceId}`}>← {space?.name ?? '스페이스'}</Link></p>
      <h1>{page.title}</h1>
      <p className="muted small">
        버전 {page.currentVersionNo} · <Link to={`/pages/${id}/history`}>이력</Link>
        {space?.access.canWrite && <> · <Link to={`/pages/${id}/edit`}>편집</Link></>}
        {space?.access.canWrite && (
          <>
            {' · '}
            <button
              type="button"
              className="linklike"
              onClick={() =>
                void api(`/api/pages/${id}`, { method: 'DELETE' })
                  .then(() => nav(`/spaces/${page.spaceId}`))
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              }
            >
              삭제
            </button>
          </>
        )}
      </p>
      <section className="card">
        <Editor value={page.content} editable={false} />
      </section>
      <Attachments pageId={id} canWrite={space?.access.canWrite ?? false} />
      <Comments pageId={id} canWrite={space?.access.canWrite ?? false} />
    </main>
  );
}
