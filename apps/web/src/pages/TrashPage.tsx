import { useCallback, useEffect, useState } from 'react';
import { LIST_PAGE_LIMIT, PAGE_TREE_MAX_DEPTH, can, type TrashPageView, type TrashSpaceView } from '@workfluence/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { EmptyState, Loading, Notice, Page, PageHeader } from '../components/ui';
import { announceTreeChanged } from '../layout/SpaceSideNav';

/**
 * 휴지통 (P4_설계서_Admin C절 · P17 설계서 J.6 기본 문맥). 되살리기 권한은 그 스페이스의 쓰기 권한이다.
 * 되살리기는 묻지 않는다 — 되돌릴 수 있는 일이고, 한 일은 알림띠가 알린다(J.5.10)
 */
export function TrashPage() {
  const { me } = useAuth();
  // 받기 전(null)과 빈 목록을 가른다 — 받기 전에 "되살릴 것이 없다"가 보이면 휴지통이 빈 것으로 읽힌다
  const [pages, setPages] = useState<TrashPageView[] | null>(null);
  const [spaces, setSpaces] = useState<TrashSpaceView[] | null>(null);
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

  const restorePage = (p: TrashPageView) => {
    setError(null);
    setNotice(null);
    void api<{ movedToRoot: boolean }>(`/api/trash/pages/${p.id}/restore`, { method: 'POST' })
      .then((r) => {
        // 부모가 아직 지워져 있거나 제자리가 깊이 한도를 넘으면 최상위로 올라간다 (FR-512, P14). 말없이 옮기면 찾지 못한다
        setNotice(
          r.movedToRoot
            ? `"${p.title}"을 되살렸다. 제자리로 돌아갈 수 없어(부모가 아직 휴지통에 있거나 ${PAGE_TREE_MAX_DEPTH}단계를 넘는다) 맨 위로 옮겼다.`
            : `"${p.title}"을 되살렸다.`,
        );
        // 그 스페이스의 트리가 바뀌었다 — 왼쪽 칸이 들고 있는 트리를 다시 받게 알린다 (J.5.11)
        announceTreeChanged(p.spaceId);
        load();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const restoreSpace = (s: TrashSpaceView) => {
    setError(null);
    setNotice(null);
    void api(`/api/trash/spaces/${s.id}/restore`, { method: 'POST' })
      .then(() => {
        setNotice(`"${s.name}"을 되살렸다. 안에 있던 문서도 함께 다시 보인다.`);
        load();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <Page>
      <PageHeader title="휴지통" description="지운 페이지와 스페이스는 보존 기간이 지나면 영영 지워진다. 그 전에는 되살릴 수 있다." />
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}

      <section aria-label="지운 페이지">
        <h2>지운 페이지</h2>
        {pages === null ? (
          !error && <Loading />
        ) : pages.length === 0 ? (
          <EmptyState title="되살릴 페이지가 없다." />
        ) : (
          <ul className="row-list">
            {pages.map((p) => (
              <li key={p.id}>
                <span className="grow">
                  <span className="row-title">{p.title}</span>{' '}
                  <span className="muted small">
                    {p.spaceName} · 지운 사람 {p.deletedByName} · {new Date(p.deletedAt).toLocaleString('ko-KR')}
                  </span>
                </span>
                <button type="button" className="subtle" onClick={() => restorePage(p)}>
                  되살리기
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {overseer && (
        <section aria-label="지운 스페이스">
          <h2>지운 스페이스</h2>
          <p className="muted">
            스페이스를 되살리면 <strong>안에 있던 문서도 함께 다시 보인다.</strong> 따로 지운 문서만 위 목록에 남는다.
          </p>
          {spaces === null ? (
            !error && <Loading />
          ) : spaces.length === 0 ? (
            <EmptyState title="되살릴 스페이스가 없다." />
          ) : (
            <ul className="row-list">
              {spaces.map((s) => (
                <li key={s.id}>
                  <span className="grow">
                    <span className="row-title">{s.name}</span>{' '}
                    <span className="muted small">
                      <span className="mono">{s.key}</span> · 만든 사람 {s.createdByName} · {new Date(s.deletedAt).toLocaleString('ko-KR')}
                    </span>
                  </span>
                  <button type="button" className="subtle" onClick={() => restoreSpace(s)}>
                    되살리기
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </Page>
  );
}
