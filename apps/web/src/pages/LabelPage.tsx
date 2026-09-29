import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { SearchHit } from '@workfluence/shared';
import { LIST_PAGE_LIMIT } from '@workfluence/shared';
import { api } from '../api';
import { EmptyState, Loading, Notice, Page, PageHeader } from '../components/ui';

/**
 * 라벨로 찾은 페이지 (FR-534 · P17 설계서 J.6 기본 문맥 — 검색과 같은 목록). **볼 수 없는 것은 결과에 없다** — 서버가 질의에서 거른다
 */
export function LabelPage() {
  const { name = '' } = useParams();
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHits(null);
    setError(null);
    // 늦게 온 앞 라벨의 응답이 뒤 라벨의 결과를 덮지 않게 한다
    let alive = true;
    api<SearchHit[]>(`/api/labels/${encodeURIComponent(name)}/pages?limit=${LIST_PAGE_LIMIT}`)
      .then((r) => alive && setHits(r))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [name]);

  return (
    <Page>
      <PageHeader title={`라벨: ${name}`} description={hits ? `이 라벨이 붙은 페이지 ${hits.length}건` : undefined} />
      {error && <Notice kind="error">{error}</Notice>}
      {!hits && !error && <Loading />}
      {hits &&
        (hits.length === 0 ? (
          <EmptyState title="이 라벨이 붙은 페이지가 없다." description="볼 수 없는 스페이스의 페이지는 결과에 나오지 않는다." />
        ) : (
          <ul className="row-list result-list" aria-label="라벨이 붙은 페이지">
            {hits.map((h) => (
              <li key={h.pageId}>
                <Link className="row-title" to={`/pages/${h.pageId}`}>
                  {h.title}
                </Link>{' '}
                <span className="muted small">{h.spaceName}</span>
              </li>
            ))}
          </ul>
        ))}
    </Page>
  );
}
