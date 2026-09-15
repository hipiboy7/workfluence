import { can, type AuditEventView } from '@workfluence/shared';
import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { fmtDateTime } from './format';

export function AdminAuditPage() {
  const { me } = useAuth();
  const [limit, setLimit] = useState(100);
  const [rows, setRows] = useState<AuditEventView[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me || !can(me, 'audit.read')) return;
    api<AuditEventView[]>(`/api/audit?limit=${limit}`).then(setRows).catch((e: Error) => setError(e.message));
  }, [me, limit]);

  if (me && !can(me, 'audit.read')) return <Navigate to="/" replace />;

  return (
    <section>
      <p className="crumb">
        <Link to="/admin">관리</Link> › 감사로그
      </p>
      <div className="title-row">
        <h1>감사로그</h1>
        <label className="inline">
          표시 건수
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[50, 100, 200, 500].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <table className="table small">
        <thead>
          <tr>
            <th>시각</th>
            <th>행위</th>
            <th>행위자</th>
            <th>대상</th>
            <th>IP</th>
            <th>상세</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td>{fmtDateTime(a.createdAt)}</td>
              <td>{a.action}</td>
              <td>{a.actorName ?? '-'}</td>
              <td>
                {a.targetType ?? ''} {a.targetId ? a.targetId.slice(0, 8) : ''}
              </td>
              <td>{a.ip ?? ''}</td>
              <td>
                <code>{a.detail ? JSON.stringify(a.detail) : ''}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
