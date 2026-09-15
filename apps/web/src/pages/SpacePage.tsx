import type { PageSummary, PageView, SpaceView } from '@workfluence/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api';
import { DocView } from '../components/Editor';
import { PageTree } from '../components/PageTree';

export function SpacePage() {
  const { spaceId = '', pageId } = useParams();
  const navigate = useNavigate();
  const [space, setSpace] = useState<SpaceView | null>(null);
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [page, setPage] = useState<PageView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadTree = useCallback(async () => {
    const [s, p] = await Promise.all([api<SpaceView>(`/api/spaces/${spaceId}`), api<PageSummary[]>(`/api/spaces/${spaceId}/pages`)]);
    setSpace(s);
    setPages(p);
    return p;
  }, [spaceId]);

  useEffect(() => {
    setError(null);
    loadTree()
      .then((p) => {
        if (!pageId && p.length) navigate(`/spaces/${spaceId}/pages/${p[0].id}`, { replace: true });
      })
      .catch((e: Error) => setError(e.message));
  }, [loadTree, pageId, spaceId, navigate]);

  useEffect(() => {
    if (!pageId) {
      setPage(null);
      return;
    }
    api<PageView>(`/api/pages/${pageId}`).then(setPage).catch((e: Error) => setError(e.message));
  }, [pageId]);

  const remove = async () => {
    if (!page || !window.confirm(`'${page.title}' 페이지를 삭제할까? (휴지통으로 이동)`)) return;
    try {
      await api<void>(`/api/pages/${page.id}`, { method: 'DELETE' });
      navigate(`/spaces/${spaceId}`);
      await loadTree();
    } catch (e) {
      setError(e instanceof Error ? e.message : '삭제 실패');
    }
  };

  return (
    <div className="space-layout">
      <aside className="sidebar">
        <h2>
          <span className="key">{space?.key}</span> {space?.name}
        </h2>
        <Link className="button small" to={`/spaces/${spaceId}/new${pageId ? `?parentId=${pageId}` : ''}`}>
          + 새 페이지{pageId ? ' (현재 페이지 아래)' : ''}
        </Link>
        <PageTree pages={pages} spaceId={spaceId} activeId={pageId} />
      </aside>
      <article className="page">
        {error && <p className="error">{error}</p>}
        {page ? (
          <>
            <header className="page-header">
              <h1>{page.title}</h1>
              <div className="actions">
                <span className="muted">v{page.currentVersionNo} · {new Date(page.updatedAt).toLocaleString('ko-KR')}</span>
                <Link className="button" to={`/pages/${page.id}/edit`}>
                  편집
                </Link>
                <Link className="button" to={`/pages/${page.id}/history`}>
                  이력
                </Link>
                <button type="button" className="danger" onClick={remove}>
                  삭제
                </button>
              </div>
            </header>
            <DocView content={page.content} />
          </>
        ) : (
          !error && <p className="muted">{pages.length ? '왼쪽에서 페이지를 선택하자.' : '첫 페이지를 만들어 보자.'}</p>
        )}
      </article>
    </div>
  );
}
