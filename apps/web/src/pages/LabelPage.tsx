import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { SearchHit } from '@workfluence/shared';
import { LIST_PAGE_LIMIT } from '@workfluence/shared';
import { api } from '../api';

/** 라벨로 찾은 페이지 (FR-534). **볼 수 없는 것은 결과에 없다** — 서버가 질의에서 거른다 */
export function LabelPage() {
  const { name = '' } = useParams();
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SearchHit[]>(`/api/labels/${encodeURIComponent(name)}/pages?limit=${LIST_PAGE_LIMIT}`)
      .then(setHits)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [name]);

  return (
    <main className="shell">
      <p className="muted small"><Link to="/">← 스페이스 목록</Link></p>
      <h1>라벨: {name}</h1>
      {error && <p className="badge fail" role="alert">{error}</p>}
      {hits && (
        <>
          <p className="muted small">{hits.length}건</p>
          <ul>
            {hits.map((h) => (
              <li key={h.pageId} className="card">
                <Link to={`/pages/${h.pageId}`}>{h.title}</Link>
                <p className="muted small">{h.spaceName}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
