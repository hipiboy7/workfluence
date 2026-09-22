import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { LabelView } from '@workfluence/shared';
import { api } from '../api';

/** 페이지의 라벨 (P4_설계서_Admin C절, FR-533·534) */
export function Labels({ pageId, canWrite }: { pageId: string; canWrite: boolean }) {
  const [rows, setRows] = useState<LabelView[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<LabelView[]>(`/api/pages/${pageId}/labels`)
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [pageId]);
  useEffect(load, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/pages/${pageId}/labels`, { method: 'POST', json: { name } });
      setName('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="card" aria-label="라벨">
      <h2>라벨</h2>
      {error && <p className="badge fail" role="alert">{error}</p>}
      {rows.length === 0 && <p className="muted small">라벨이 없다.</p>}
      <ul>
        {rows.map((l) => (
          <li key={l.id}>
            <Link to={`/labels/${encodeURIComponent(l.name)}`}>{l.name}</Link>
            {canWrite && (
              <>
                {' '}
                <button
                  type="button"
                  className="linklike"
                  onClick={() =>
                    void api(`/api/pages/${pageId}/labels/${l.id}`, { method: 'DELETE' })
                      .then(load)
                      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                  }
                >
                  떼기
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {canWrite && (
        <form onSubmit={add}>
          <label htmlFor="label-name">라벨 붙이기</label>
          <input id="label-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 회의록" />
          <button type="submit">붙이기</button>
        </form>
      )}
    </section>
  );
}
