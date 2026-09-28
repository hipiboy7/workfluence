import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { LIST_PAGE_LIMIT, PAGE_TREE_MAX_DEPTH, can, type TrashPageView, type TrashSpaceView } from '@workfluence/shared';
import { api } from '../api';
import { useAuth } from '../auth';

/** 휴지통 (P4_설계서_Admin C절). 되살리기 권한은 그 스페이스의 쓰기 권한이다 */
export function TrashPage() {
  const { me } = useAuth();
  const [pages, setPages] = useState<TrashPageView[]>([]);
  const [spaces, setSpaces] = useState<TrashSpaceView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 지운 스페이스는 관리자와 스페이스 관리 전체를 받은 사람이 본다 (FR-513 · P15 FR-1630) — 받은 위임을 함께 넘긴다
  const overseer = me ? can({ id: me.id, role: me.role, grants: me.grants }, 'space.oversee') : false;

  const load = useCallback(() => {
    api<TrashPageView[]>(`/api/trash/pages?limit=${LIST_PAGE_LIMIT}`)
      .then(setPages)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    if (overseer) {
      // **오류를 삼키지 않는다.** 여기는 이미 볼 수 있는 사람만 오므로 실패는 진짜 고장이다 —
      // 삼키면 "되살릴 스페이스가 없다"로 보여 휴지통이 빈 것으로 오해한다 (코드 리뷰 11)
      api<TrashSpaceView[]>(`/api/trash/spaces?limit=${LIST_PAGE_LIMIT}`)
        .then(setSpaces)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }
  }, [overseer]);
  useEffect(load, [load]);

  const restorePage = (p: TrashPageView) =>
    void api<{ movedToRoot: boolean }>(`/api/trash/pages/${p.id}/restore`, { method: 'POST' })
      .then((r) => {
        // 부모가 아직 지워져 있거나 제자리가 깊이 한도를 넘으면 최상위로 올라간다 (FR-512, P14). 말없이 옮기면 찾지 못한다
        setNotice(
          r.movedToRoot
            ? `"${p.title}"을 되살렸다. 제자리로 돌아갈 수 없어(부모가 아직 휴지통에 있거나 ${PAGE_TREE_MAX_DEPTH}단계를 넘는다) 맨 위로 옮겼다.`
            : `"${p.title}"을 되살렸다.`,
        );
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

      {overseer && (
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
