import type { SpaceMemberView, SpaceView } from '@workfluence/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { MEMBER_ROLE_LABEL } from './SpaceBadges';

/** Crew: 이 스페이스를 함께 쓰는(편집) 사람과 볼 수 있는(보기) 사람. owner·관리자만 추가·변경·제외 */
export function CrewPanel({ space, onChanged }: { space: SpaceView; onChanged: () => void }) {
  const [members, setMembers] = useState<SpaceMemberView[] | null>(null);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [error, setError] = useState<string | null>(null);
  const manage = space.access.canManageMembers;

  const load = useCallback(() => api<SpaceMemberView[]>(`/api/spaces/${space.id}/members`).then(setMembers).catch((e: Error) => setError(e.message)), [space.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<SpaceMemberView[]>) => {
    setError(null);
    try {
      setMembers(await fn());
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '실패');
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api<SpaceMemberView[]>(`/api/spaces/${space.id}/members`, { method: 'POST', json: { username, role } })).then(() => setUsername(''));
  };

  return (
    <section className="crew card">
      <h3>Crew · {members?.length ?? '…'}명</h3>
      {error && <p className="error">{error}</p>}
      <table className="table small">
        <thead>
          <tr>
            <th>ID</th>
            <th>이름</th>
            <th>역할</th>
            {manage && <th></th>}
          </tr>
        </thead>
        <tbody>
          {members?.map((m) => (
            <tr key={m.userId}>
              <td>{m.username}</td>
              <td>{m.displayName}</td>
              <td>
                {manage && m.role !== 'owner' ? (
                  <select
                    aria-label={`${m.username} 역할`}
                    value={m.role}
                    onChange={(e) =>
                      void run(() => api<SpaceMemberView[]>(`/api/spaces/${space.id}/members/${m.userId}`, { method: 'PATCH', json: { role: e.target.value } }))
                    }
                  >
                    <option value="editor">편집</option>
                    <option value="viewer">보기</option>
                  </select>
                ) : (
                  MEMBER_ROLE_LABEL[m.role]
                )}
              </td>
              {manage && (
                <td>
                  {m.role !== 'owner' && (
                    <button type="button" className="danger small" onClick={() => void run(() => api<SpaceMemberView[]>(`/api/spaces/${space.id}/members/${m.userId}`, { method: 'DELETE' }))}>
                      제외
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {manage && (
        <form className="inline-add" onSubmit={add}>
          <input aria-label="추가할 사용자 ID" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="사용자 ID" required />
          <select aria-label="추가 역할" value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}>
            <option value="editor">편집</option>
            <option value="viewer">보기</option>
          </select>
          <button type="submit">Crew 추가</button>
        </form>
      )}
    </section>
  );
}
