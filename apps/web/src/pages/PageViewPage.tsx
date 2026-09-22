import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { can } from '@workfluence/shared';
import type { PageView, SpaceView } from '@workfluence/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { TemplateFromPage } from '../components/TemplateFromPage';
import { Attachments } from '../components/Attachments';
import { Comments } from '../components/Comments';
import { Labels } from '../components/Labels';
import { Editor } from '../components/Editor';

/** 페이지 보기 */
export function PageViewPage() {
  const { me } = useAuth();
  const { id = '' } = useParams();
  const isAdmin = me ? can({ id: me.id, role: me.role }, 'space.manage') : false;
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
        {' · '}
        {/* **평범한 링크다.** `fetch`로 받아 `Blob`을 만들면 파일 이름을 화면이 다시
            정해야 하는데, 그 이름은 서버가 이미 안전하게 정했다 (FR-730) */}
        <a href={`/api/pages/${id}/export`} download>
          HTML로 내보내기
        </a>
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
      {/* **템플릿은 여기서 만든다.** 별도 관리 화면을 두지 않는 것은, 템플릿이 되는 것은
          언제나 "잘 쓴 문서 하나"이고 그것을 보고 있을 때 결정하기 때문이다 (FR-740·743) */}
      {isAdmin && <TemplateFromPage page={page} />}
      <Labels pageId={id} canWrite={space?.access.canWrite ?? false} />
      <Attachments pageId={id} canWrite={space?.access.canWrite ?? false} />
      <Comments pageId={id} canWrite={space?.access.canWrite ?? false} />
    </main>
  );
}
