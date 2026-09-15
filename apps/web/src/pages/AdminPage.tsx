import { ROLES, can, type AuditEventView, type Role, type UserView } from '@workfluence/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { api } from '../api';
import { useAuth } from '../auth';

export function AdminPage() {
  const { me } = useAuth();
  const [users, setUsers] = useState<UserView[]>([]);
  const [audit, setAudit] = useState<AuditEventView[]>([]);
  const [form, setForm] = useState({ username: '', displayName: '', password: '', role: 'member' as Role });
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    Promise.all([api<UserView[]>('/api/users'), api<AuditEventView[]>('/api/audit?limit=100')])
      .then(([u, a]) => {
        setUsers(u);
        setAudit(a);
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    if (me && can(me, 'user.manage')) void load();
  }, [me]);

  if (me && !can(me, 'user.manage')) return <Navigate to="/" replace />;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api<UserView>('/api/users', { method: 'POST', json: form });
      setForm({ username: '', displayName: '', password: '', role: 'member' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '생성 실패');
    }
  };

  return (
    <div className="two-col">
      <section>
        <h1>사용자</h1>
        <table className="table">
          <thead>
            <tr>
              <th>사용자명</th>
              <th>이름</th>
              <th>역할</th>
              <th>생성</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.displayName}</td>
                <td>{u.role}</td>
                <td>{new Date(u.createdAt).toLocaleDateString('ko-KR')}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h1>감사로그 (최근 100건)</h1>
        <table className="table small">
          <thead>
            <tr>
              <th>시각</th>
              <th>행위</th>
              <th>행위자</th>
              <th>대상</th>
              <th>상세</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((a) => (
              <tr key={a.id}>
                <td>{new Date(a.createdAt).toLocaleString('ko-KR')}</td>
                <td>{a.action}</td>
                <td>{a.actorName ?? '-'}</td>
                <td>
                  {a.targetType ?? ''} {a.targetId ? a.targetId.slice(0, 8) : ''}
                </td>
                <td>
                  <code>{a.detail ? JSON.stringify(a.detail) : ''}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <aside>
        <form className="card" onSubmit={create}>
          <h2>새 사용자</h2>
          <label>
            사용자명
            <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
          </label>
          <label>
            이름
            <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required />
          </label>
          <label>
            초기 비밀번호 (12자 이상, 3종 조합)
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
          </label>
          <label>
            역할
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit">만들기</button>
        </form>
      </aside>
    </div>
  );
}
