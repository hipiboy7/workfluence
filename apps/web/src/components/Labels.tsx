import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { LabelView } from '@workfluence/shared';
import { api } from '../api';
import { Field, Notice } from './ui';

/**
 * 페이지의 라벨 (P4_설계서_Admin C절, FR-533·534).
 *
 * 페이지 보기의 한 구획이다 — 카드 없이 위 1px 선과 h2로 잇는다(P17 설계서 J.5.6). 라벨은 칩으로 늘어서고, 떼기 단추의 이름은 "{라벨} 떼기"다
 * (J.5.12 — 칩이 여럿이면 "떼기"만으로는 어느 것인지 모른다). **떼기는 묻지 않는다** — 다시 붙이면 된다(J.5.10). 붙이기는 칸 + 단추 한 줄(J.5.4)
 */
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
    <section className="doc-section" aria-label="라벨">
      <h2>라벨</h2>
      {error && <Notice kind="error">{error}</Notice>}
      {rows.length === 0 ? (
        <p className="muted">라벨이 없다.</p>
      ) : (
        <ul className="chips">
          {rows.map((l) => (
            <li key={l.id} className="chip">
              <Link to={`/labels/${encodeURIComponent(l.name)}`}>{l.name}</Link>
              {canWrite && (
                <button
                  type="button"
                  className="subtle sm"
                  aria-label={`${l.name} 떼기`}
                  onClick={() =>
                    void api(`/api/pages/${pageId}/labels/${l.id}`, { method: 'DELETE' })
                      .then(load)
                      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                  }
                >
                  떼기
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form className="inline-form" onSubmit={add}>
          <Field id="label-name" label="라벨 붙이기">
            <input id="label-name" className="w-m" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 회의록" />
          </Field>
          <button type="submit">붙이기</button>
        </form>
      )}
    </section>
  );
}
