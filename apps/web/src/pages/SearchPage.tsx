import type { SearchHit } from '@workfluence/shared';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';

export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!q) return;
    setHits(null);
    api<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`).then(setHits).catch((e: Error) => setError(e.message));
  }, [q]);

  return (
    <section>
      <h1>검색: “{q}”</h1>
      {error && <p className="error">{error}</p>}
      {hits === null && !error && <p className="muted">검색 중…</p>}
      {hits && hits.length === 0 && <p className="muted">결과가 없다. 내가 볼 수 있는 스페이스만 검색된다.</p>}
      <ul className="hits">
        {hits?.map((h) => (
          <li key={h.pageId} className="card">
            <Link to={`/spaces/${h.spaceId}/pages/${h.pageId}`}>
              <span className="badge">{h.spaceName}</span> {h.title}
            </Link>
            <p className="muted">{h.snippet || '(본문 없음)'}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
