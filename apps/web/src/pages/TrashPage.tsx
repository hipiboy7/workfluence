import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { LIST_PAGE_LIMIT, can, type TrashPageView, type TrashSpaceView } from '@workfluence/shared';
import { api } from '../api';
import { useAuth } from '../auth';

/** 휴지통 (P4_설계서_Admin C절). 되살리기 권한은 그 스페이스의 쓰기 권한이다 */
export function TrashPage() {
  const { me } = useAuth();
  const [pages, setPages] = useState<TrashPageView[]>([]);
  const [spaces, setSpaces] = useState<TrashSpaceView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isAdmin = me ? can({ id: me.id, role: me.role }, 'space.manage') : false;

  const load = useCallback(() => {
    api<TrashPageView[]>(`/api/trash/pages?limit=${LIST_PAGE_LIMIT}`)
      .then(setPages)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    if (isAdmin) {
      // **오류를 삼키지 않는다.** 여기는 이미 관리자만 오므로 실패는 진짜 고장이다 —
      // 삼키면 "되살릴 스페이스가 없다"로 보여 휴지통이 빈 것으로 오해한다 (코드 리뷰 11)
      api<TrashSpaceView[]>(`/api/trash/spaces?limit=${LIST_PAGE_LIMIT}`)
        .then(setSpaces)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }
  }, [isAdmin]);
  useEffect(load, [load]);

  const restorePage = (p: TrashPageView) =>
    void api<{ movedToRoot: boolean }>(`/api/trash/pages/${p.id}/restore`, { method: 'POST' })
      .then((r) => {
        // 부모가 아직 지워져 있으면 최상위로 올라간다 (FR-512). 말없이 옮기면 찾지 못한다
        setNotice(r.movedToRoot ? `"${p.title}"을 되살렸다. 부모가 아직 휴지통에 있어 맨 위로 옮겼다.` : `"${p.title}"을 되살렸다.`);
        load();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  return (
    <main className="shell">
      <p className="muted small"><Link to="/">← 스페이스 목록</Link></p>
      <h1>휴지통</h1>
      {error && <p className="badge fail" role="alert">{error}</p>}
      {notice && <p className="badge" role="status">{notice}</p>}

      <section className="card" aria-label="지운 페이지">
        <h2>지운 페이지</h2>
        {pages.length === 0 ? (
          <p className="muted small">되살릴 페이지가 없다.</p>
        ) : (
          <ul>
            {pages.map((p) => (
              <li key={p.id}>
                {p.title} <span className="muted small">{p.spaceName} · {new Date(p.deletedAt).toLocaleString('ko-KR')}</span>{' '}
                <button type="button" className="linklike" onClick={() => restorePage(p)}>되살리기</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isAdmin && (
        <section className="card" aria-label="지운 스페이스">
          <h2>지운 스페이스</h2>
          <p className="muted small">스페이스를 되살리면 <strong>안에 있던 문서도 함께 다시 보인다.</strong> 따로 지운 문서만 위 목록에 남는다.</p>
          {spaces.length === 0 ? (
            <p className="muted small">되살릴 스페이스가 없다.</p>
          ) : (
            <ul>
              {spaces.map((s) => (
                <li key={s.id}>
                  {s.name} <span className="muted small">{s.key} · {new Date(s.deletedAt).toLocaleString('ko-KR')}</span>{' '}
                  <button
                    type="button"
                    className="linklike"
                    onClick={() =>
                      void api(`/api/trash/spaces/${s.id}/restore`, { method: 'POST' })
                        .then(load)
                        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                    }
                  >
                    되살리기
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
