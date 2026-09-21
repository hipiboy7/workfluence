import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { SearchHit } from '@workfluence/shared';
import { api } from '../api';

/**
 * 검색 (P3_설계서_Content 2절).
 *
 * 질의는 주소에 둔다 — 결과를 그대로 링크로 건넬 수 있고, 뒤로 가기가 기대대로 동작한다.
 * **권한 필터는 서버가 질의에서 건다** (FR-403). 화면은 받은 것을 그리기만 한다.
 */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [input, setInput] = useState(q);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback((term: string) => {
    if (!term.trim()) {
      setHits(null);
      return;
    }
    api<SearchHit[]>(`/api/search?q=${encodeURIComponent(term)}`)
      .then(setHits)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    setInput(q);
    run(q);
  }, [q, run]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setParams(input.trim() ? { q: input } : {});
  };

  return (
    <main className="shell">
      <p className="muted small"><Link to="/">← 스페이스 목록</Link></p>
      <h1>검색</h1>
      <form onSubmit={submit}>
        <label htmlFor="q">찾을 말</label>
        <input id="q" value={input} onChange={(e) => setInput(e.target.value)} placeholder="두 글자부터 찾는다" autoFocus />
        <button type="submit">찾기</button>
      </form>
      {error && <p className="badge fail" role="alert">{error}</p>}
      {hits && (
        <section>
          <p className="muted small">{hits.length}건</p>
          {hits.length === 0 && <p className="muted">찾은 것이 없다. 볼 수 없는 스페이스의 페이지는 결과에 나오지 않는다.</p>}
          <ul>
            {hits.map((h) => (
              <li key={h.pageId} className="card">
                <Link to={`/pages/${h.pageId}`}>{h.title}</Link>
                <p className="muted small">{h.spaceName}</p>
                <p className="small">{h.snippet}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
