import type { DocNode, PageVersionView, PageView } from '@workfluence/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api';
import { DocView } from '../components/Editor';

export function PageHistoryPage() {
  const { pageId = '' } = useParams();
  const navigate = useNavigate();
  const [page, setPage] = useState<PageView | null>(null);
  const [versions, setVersions] = useState<PageVersionView[]>([]);
  const [selected, setSelected] = useState<(PageVersionView & { content: DocNode }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api<PageView>(`/api/pages/${pageId}`), api<PageVersionView[]>(`/api/pages/${pageId}/versions`)])
      .then(([p, v]) => {
        setPage(p);
        setVersions(v);
      })
      .catch((e: Error) => setError(e.message));
  }, [pageId]);

  const view = (no: number) => api<PageVersionView & { content: DocNode }>(`/api/pages/${pageId}/versions/${no}`).then(setSelected).catch((e: Error) => setError(e.message));

  const restore = async (no: number) => {
    if (!window.confirm(`v${no} 내용으로 새 버전을 만들까? (이력은 지워지지 않는다)`)) return;
    try {
      const p = await api<PageView>(`/api/pages/${pageId}/versions/${no}/restore`, { method: 'POST' });
      navigate(`/spaces/${p.spaceId}/pages/${p.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '복원 실패');
    }
  };

  return (
    <div className="space-layout">
      <aside className="sidebar">
        <h2>버전 이력</h2>
        {page && (
          <p>
            <Link to={`/spaces/${page.spaceId}/pages/${page.id}`}>← {page.title}</Link>
          </p>
        )}
        <ul className="versions">
          {versions.map((v) => (
            <li key={v.versionNo} className={selected?.versionNo === v.versionNo ? 'active' : undefined}>
              <button type="button" className="link" onClick={() => view(v.versionNo)}>
                v{v.versionNo} {v.versionNo === page?.currentVersionNo && <em>(현재)</em>}
              </button>
              <div className="muted small">
                {v.createdByName} · {new Date(v.createdAt).toLocaleString('ko-KR')}
              </div>
            </li>
          ))}
        </ul>
      </aside>
      <article className="page">
        {error && <p className="error">{error}</p>}
        {selected ? (
          <>
            <header className="page-header">
              <h1>
                {selected.title} <span className="muted">v{selected.versionNo}</span>
              </h1>
              {selected.versionNo !== page?.currentVersionNo && (
                <button type="button" className="primary" onClick={() => restore(selected.versionNo)}>
                  이 버전으로 복원
                </button>
              )}
            </header>
            <DocView content={selected.content} />
          </>
        ) : (
          <p className="muted">왼쪽에서 버전을 선택하면 내용을 보여준다.</p>
        )}
      </article>
    </div>
  );
}
