import type { PageSummary, PageView, SpaceView } from '@workfluence/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api';
import { CrewPanel } from '../components/CrewPanel';
import { DocView } from '../components/Editor';
import { PageTree } from '../components/PageTree';
import { SpaceBadges } from '../components/SpaceBadges';

export function SpacePage() {
  const { spaceId = '', pageId } = useParams();
  const navigate = useNavigate();
  const [space, setSpace] = useState<SpaceView | null>(null);
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [page, setPage] = useState<PageView | null>(null);
  const [showCrew, setShowCrew] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSpace = useCallback(() => api<SpaceView>(`/api/spaces/${spaceId}`).then(setSpace), [spaceId]);
  const loadTree = useCallback(async () => {
    const [, p] = await Promise.all([loadSpace(), api<PageSummary[]>(`/api/spaces/${spaceId}/pages`)]);
    setPages(p);
    return p;
  }, [loadSpace, spaceId]);

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

  const removePage = async () => {
    if (!page || !window.confirm(`'${page.title}' 페이지를 삭제할까? (휴지통으로 이동)`)) return;
    try {
      await api<void>(`/api/pages/${page.id}`, { method: 'DELETE' });
      navigate(`/spaces/${spaceId}`);
      await loadTree();
    } catch (e) {
      setError(e instanceof Error ? e.message : '삭제 실패');
    }
  };

  const setStatus = async (status: 'active' | 'suspended') => {
    const label = status === 'suspended' ? '중지' : '재개';
    if (!window.confirm(`이 스페이스를 ${label}할까?${status === 'suspended' ? ' 중지되면 모두에게 읽기 전용이 된다.' : ''}`)) return;
    try {
      setSpace(await api<SpaceView>(`/api/spaces/${spaceId}/status`, { method: 'POST', json: { status } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : '상태 변경 실패');
    }
  };

  const removeSpace = async () => {
    if (!space || !window.confirm(`'${space.name}' 스페이스를 삭제할까? 페이지도 함께 보이지 않게 된다.`)) return;
    try {
      await api<void>(`/api/spaces/${spaceId}`, { method: 'DELETE' });
      navigate('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : '삭제 실패');
    }
  };

  const canWrite = space?.access.canWrite ?? false;
  const deleteHint = space
    ? space.access.canDelete
      ? '스페이스 삭제'
      : space.access.isOwner && space.memberCount >= 2
        ? 'Crew가 2명 이상이면 생성자가 삭제할 수 없다. 중지 후 관리자가 삭제한다'
        : space.status === 'active'
          ? '활성 스페이스는 삭제할 수 없다. 먼저 중지한다'
          : '삭제 권한이 없다'
    : '';

  return (
    <div className="space-layout">
      <aside className="sidebar">
        <h2 className="space-title">{space?.name}</h2>
        {space && <SpaceBadges space={space} />}
        <div className="sidebar-actions">
          {space?.kind === 'team' && (
            <button type="button" className={`small ${showCrew ? 'on' : ''}`} onClick={() => setShowCrew((v) => !v)} aria-pressed={showCrew}>
              Crew
            </button>
          )}
          {canWrite && (
            <Link className="button small" to={`/spaces/${spaceId}/new${pageId ? `?parentId=${pageId}` : ''}`}>
              + 새 페이지{pageId ? ' (현재 아래)' : ''}
            </Link>
          )}
        </div>
        {space?.status === 'suspended' && <p className="notice warn small">중지된 스페이스. 읽기 전용이다.</p>}
        <PageTree pages={pages} spaceId={spaceId} activeId={pageId} />
        {space && (space.access.canChangeStatus || space.access.canDelete) && (
          <div className="space-admin">
            {space.access.canChangeStatus &&
              (space.status === 'active' ? (
                <button type="button" className="small" onClick={() => setStatus('suspended')}>
                  스페이스 중지
                </button>
              ) : (
                <button type="button" className="small" onClick={() => setStatus('active')}>
                  스페이스 재개
                </button>
              ))}
            <button type="button" className="danger small" onClick={removeSpace} disabled={!space.access.canDelete} title={deleteHint}>
              스페이스 삭제
            </button>
          </div>
        )}
      </aside>
      <article className="page">
        {error && <p className="error">{error}</p>}
        {space && showCrew && space.kind === 'team' && <CrewPanel space={space} onChanged={() => void loadSpace()} />}
        {page ? (
          <>
            <header className="page-header">
              <h1>{page.title}</h1>
              <div className="actions">
                <span className="muted">
                  v{page.currentVersionNo} · {new Date(page.updatedAt).toLocaleString('ko-KR')}
                </span>
                {canWrite && (
                  <Link className="button" to={`/pages/${page.id}/edit`}>
                    편집
                  </Link>
                )}
                <Link className="button" to={`/pages/${page.id}/history`}>
                  이력
                </Link>
                {canWrite && (
                  <button type="button" className="danger" onClick={removePage}>
                    삭제
                  </button>
                )}
              </div>
            </header>
            <DocView content={page.content} />
          </>
        ) : (
          !error && <p className="muted">{pages.length ? '왼쪽에서 페이지를 선택하자.' : canWrite ? '첫 페이지를 만들어 보자.' : '아직 페이지가 없다.'}</p>
        )}
      </article>
    </div>
  );
}
