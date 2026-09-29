import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { SearchHit } from '@workfluence/shared';
import { api } from '../api';
import { EmptyState, Field, Loading, Notice, Page, PageHeader } from '../components/ui';

/**
 * 검색 (P3_설계서_Content 2절 · P17 설계서 J.6 기본 문맥).
 *
 * 질의는 주소에 둔다 — 결과를 그대로 링크로 건넬 수 있고, 뒤로 가기가 기대대로 동작한다.
 * **권한 필터는 서버가 질의에서 건다** (FR-403). 화면은 받은 것을 그리기만 한다.
 * 찾기 칸은 이 화면 한 곳이다 — 위 막대에는 두지 않고 주 메뉴 "검색"이 여기로 온다(J.3.2 · J.9-6)
 */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [input, setInput] = useState(q);
  // 결과는 어느 질의의 것인지와 함께 든다 — "'X' 결과 N건"이 바로 앞 질의의 건수를 말하지 않게
  const [result, setResult] = useState<{ q: string; hits: SearchHit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInput(q);
    setError(null);
    if (!q.trim()) {
      setResult(null);
      return;
    }
    // 늦게 온 앞 질의의 응답이 뒤 질의의 결과를 덮지 않게 한다
    let alive = true;
    api<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`)
      .then((hits) => alive && setResult({ q, hits }))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [q]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setParams(input.trim() ? { q: input } : {});
  };

  const current = result && result.q === q ? result : null;

  return (
    <Page>
      <PageHeader title="검색" description="볼 수 있는 스페이스의 페이지에서 제목과 본문을 찾는다." />
      {/* 칸 하나 + 단추 한 줄 (J.5.4) */}
      <form className="inline-form" role="search" onSubmit={submit}>
        <Field id="q" label="찾을 말">
          <input id="q" type="search" className="w-l" value={input} onChange={(e) => setInput(e.target.value)} placeholder="두 글자부터 찾는다" autoFocus />
        </Field>
        <button type="submit" className="primary">
          찾기
        </button>
      </form>
      {error && <Notice kind="error">{error}</Notice>}
      {!!q.trim() && !current && !error && <Loading />}
      {current && (
        <section aria-labelledby="search-count">
          <h2 id="search-count">
            '{current.q}' 결과 {current.hits.length}건
          </h2>
          {current.hits.length === 0 ? (
            <EmptyState title="찾은 것이 없다." description="볼 수 없는 스페이스의 페이지는 결과에 나오지 않는다." />
          ) : (
            <ul className="row-list result-list">
              {current.hits.map((h) => (
                <li key={h.pageId}>
                  <Link className="row-title" to={`/pages/${h.pageId}`}>
                    {h.title}
                  </Link>{' '}
                  <span className="muted small">{h.spaceName}</span>
                  {h.snippet && <p className="snippet small">{h.snippet}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </Page>
  );
}
