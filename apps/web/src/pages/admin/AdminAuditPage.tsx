import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { AuditEventView } from '@workfluence/shared';
import { AUDIT_ACTIONS } from '@workfluence/shared';
import { LIST_PAGE_LIMIT } from '@workfluence/shared';
import { api } from '../../api';

/** 감사로그 (FR-237, FR-243). append-only라 화면에도 조회만 있다 */
export function AdminAuditPage() {
  const [rows, setRows] = useState<AuditEventView[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 거르는 조건 (FR-531). **거를 수 없으면 "추적한다"가 성립하지 않는다** — 수만 건에서 눈으로 찾을 수는 없다
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(() => {
    const q = new URLSearchParams({ limit: String(LIST_PAGE_LIMIT) });
    if (action) q.set('action', action);
    if (from) q.set('from', from);
    // 끝 날짜는 **그날을 포함**하도록 다음 날 0시로 보낸다. 서버는 `to` 미만으로 거른다
    if (to) q.set('to', new Date(new Date(to).getTime() + 86_400_000).toISOString());
    api<AuditEventView[]>(`/api/audit?${q.toString()}`)
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [action, from, to]);
  useEffect(load, [load]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    load();
  };

  return (
    <main className="shell">
      <h1>감사로그</h1>
      <p className="muted small"><Link to="/">← 홈</Link> · 기록은 추가만 된다. 고치거나 지울 수 없다.</p>
      {error && <p className="badge fail" role="alert">{error}</p>}

      <form onSubmit={submit} className="card">
        <label htmlFor="action">행위</label>
        <select id="action" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">전체</option>
          {AUDIT_ACTIONS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>{' '}
        <label htmlFor="from">시작</label>
        <input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />{' '}
        <label htmlFor="to">끝</label>
        <input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />{' '}
        <button type="submit">거르기</button>
        <p className="muted small">{rows.length}건 (최대 {LIST_PAGE_LIMIT})</p>
      </form>

      <table className="card">
        <thead>
          <tr><th>시각</th><th>행위</th><th>주체</th><th>대상</th><th>상세</th></tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.createdAt).toLocaleString('ko-KR')}</td>
              <td><code>{e.action}</code></td>
              <td>{e.actorName ?? '-'}</td>
              <td>{e.targetId ?? '-'}</td>
              <td className="small">{e.detail ? JSON.stringify(e.detail) : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
