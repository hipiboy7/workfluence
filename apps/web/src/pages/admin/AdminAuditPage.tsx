import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { AuditEventView } from '@workfluence/shared';
import { LIST_PAGE_LIMIT } from '@workfluence/shared';
import { api } from '../../api';

/** 감사로그 (FR-237, FR-243). append-only라 화면에도 조회만 있다 */
export function AdminAuditPage() {
  const [rows, setRows] = useState<AuditEventView[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<AuditEventView[]>(`/api/audit?limit=${LIST_PAGE_LIMIT}`)
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main className="shell">
      <h1>감사로그</h1>
      <p className="muted small"><Link to="/">← 홈</Link> · 기록은 추가만 된다. 고치거나 지울 수 없다.</p>
      {error && <p className="badge fail" role="alert">{error}</p>}
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
