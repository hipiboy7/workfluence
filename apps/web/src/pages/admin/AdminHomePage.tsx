import { can, type AuditEventView, type SpaceView, type UserView } from '@workfluence/shared';
import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { KIND_LABEL, STATUS_LABEL } from '../../components/SpaceBadges';
import { USER_STATUS_LABEL, fmtDate, fmtDateTime } from './format';

/** 관리 대시보드: 사용자·스페이스·감사로그 각 5건. 제목을 누르면 각 페이지로 (prototype-v2) */
export function AdminHomePage() {
  const { me } = useAuth();
  const [users, setUsers] = useState<UserView[]>([]);
  const [spaces, setSpaces] = useState<SpaceView[]>([]);
  const [audit, setAudit] = useState<AuditEventView[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me || !can(me, 'user.manage')) return;
    Promise.all([api<UserView[]>('/api/users?limit=5'), api<SpaceView[]>('/api/spaces?scope=all&limit=5'), api<AuditEventView[]>('/api/audit?limit=5')])
      .then(([u, s, a]) => {
        setUsers(u);
        setSpaces(s);
        setAudit(a);
      })
      .catch((e: Error) => setError(e.message));
  }, [me]);

  if (me && !can(me, 'user.manage')) return <Navigate to="/" replace />;
  const pending = users.filter((u) => u.status === 'pending').length;

  return (
    <div className="admin-home">
      <h1>관리</h1>
      {error && <p className="error">{error}</p>}
      <div className="admin-grid">
        <section className="card">
          <h2>
            <Link to="/admin/users">사용자</Link> {pending > 0 && <span className="badge status-pending">승인 대기 {pending}</span>}
          </h2>
          <table className="table small">
            <thead>
              <tr>
                <th>ID</th>
                <th>이름</th>
                <th>역할</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.username}</td>
                  <td>{u.displayName}</td>
                  <td>{u.role}</td>
                  <td>
                    <span className={`badge status-${u.status}`}>{USER_STATUS_LABEL[u.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h2>
            <Link to="/admin/spaces">스페이스</Link>
          </h2>
          <table className="table small">
            <thead>
              <tr>
                <th>스페이스명</th>
                <th>종류</th>
                <th>생성자</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {spaces.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/spaces/${s.id}`}>{s.name}</Link>
                  </td>
                  <td>{KIND_LABEL[s.kind]}</td>
                  <td>{s.createdByUsername}</td>
                  <td>
                    <span className={`badge status-${s.status}`}>{STATUS_LABEL[s.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card wide-card">
          <h2>
            <Link to="/admin/audit">감사로그</Link>
          </h2>
          <table className="table small">
            <thead>
              <tr>
                <th>시각</th>
                <th>행위</th>
                <th>행위자</th>
                <th>상세</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id}>
                  <td>{fmtDateTime(a.createdAt)}</td>
                  <td>{a.action}</td>
                  <td>{a.actorName ?? '-'}</td>
                  <td>
                    <code>{a.detail ? JSON.stringify(a.detail) : ''}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
      <p className="muted small">최근 생성 순 5건씩. 전체는 각 제목을 눌러 본다. {fmtDate(new Date().toISOString())} 기준</p>
    </div>
  );
}
