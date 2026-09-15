import { can, type SpaceMemberView, type SpaceView } from '@workfluence/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { KIND_LABEL, MEMBER_ROLE_LABEL, STATUS_LABEL } from '../../components/SpaceBadges';
import { fmtDate } from './format';

/** 스페이스 관리: 표(스페이스명·카테고리·생성자·생성일자·상태) + 선택 시 상세(메타·Crew) + 상태 변경하기 */
export function AdminSpacesPage() {
  const { me } = useAuth();
  const [spaces, setSpaces] = useState<SpaceView[]>([]);
  const [selected, setSelected] = useState<SpaceView | null>(null);
  const [members, setMembers] = useState<SpaceMemberView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<SpaceView[]>('/api/spaces?scope=all&limit=500').then(setSpaces).catch((e: Error) => setError(e.message)), []);
  useEffect(() => {
    if (me && can(me, 'space.manage')) void load();
  }, [me, load]);

  useEffect(() => {
    if (!selected) return;
    api<SpaceMemberView[]>(`/api/spaces/${selected.id}/members`).then(setMembers).catch((e: Error) => setError(e.message));
  }, [selected]);

  if (me && !can(me, 'space.manage')) return <Navigate to="/" replace />;

  const toggleStatus = async () => {
    if (!selected) return;
    const status = selected.status === 'active' ? 'suspended' : 'active';
    if (!window.confirm(`'${selected.name}'을(를) ${STATUS_LABEL[status]} 상태로 바꿀까?`)) return;
    try {
      const s = await api<SpaceView>(`/api/spaces/${selected.id}/status`, { method: 'POST', json: { status } });
      setSelected(s);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '상태 변경 실패');
    }
  };

  const remove = async () => {
    if (!selected || !window.confirm(`'${selected.name}' 스페이스를 삭제할까?`)) return;
    try {
      await api<void>(`/api/spaces/${selected.id}`, { method: 'DELETE' });
      setSelected(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '삭제 실패');
    }
  };

  return (
    <div className="two-col wide-detail">
      <section>
        <p className="crumb">
          <Link to="/admin">관리</Link> › 스페이스
        </p>
        <h1>스페이스</h1>
        {error && <p className="error">{error}</p>}
        <table className="table selectable">
          <thead>
            <tr>
              <th>스페이스명</th>
              <th>카테고리</th>
              <th>생성자</th>
              <th>생성일자</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {spaces.map((s) => (
              <tr key={s.id} className={selected?.id === s.id ? 'active' : undefined} onClick={() => setSelected(s)}>
                <td>
                  <Link to={`/spaces/${s.id}`} onClick={(e) => e.stopPropagation()}>
                    {s.name}
                  </Link>{' '}
                  <span className={`badge kind-${s.kind}`}>{KIND_LABEL[s.kind]}</span>
                </td>
                <td>{s.categoryName ?? '-'}</td>
                <td>{s.createdByUsername}</td>
                <td>{fmtDate(s.createdAt)}</td>
                <td>
                  <span className={`badge status-${s.status}`}>{STATUS_LABEL[s.status]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">행을 누르면 오른쪽에 상세가 뜬다. 스페이스명을 누르면 그 스페이스로 이동한다.</p>
      </section>
      <aside>
        {selected ? (
          <div className="card detail-panel">
            <h2>{selected.name}</h2>
            <dl className="meta">
              <dt>카테고리</dt>
              <dd>{selected.categoryName ?? '-'}</dd>
              <dt>종류</dt>
              <dd>{KIND_LABEL[selected.kind]}</dd>
              <dt>생성일자</dt>
              <dd>{fmtDate(selected.createdAt)}</dd>
              <dt>상태</dt>
              <dd>
                <span className={`badge status-${selected.status}`}>{STATUS_LABEL[selected.status]}</span>
              </dd>
            </dl>
            <div className="actions">
              <button type="button" className="primary" onClick={toggleStatus}>
                상태 변경하기 → {STATUS_LABEL[selected.status === 'active' ? 'suspended' : 'active']}
              </button>
              <button type="button" className="danger" onClick={remove} disabled={!selected.access.canDelete} title={selected.access.canDelete ? '' : '중지 상태에서만 삭제할 수 있다'}>
                삭제
              </button>
            </div>
            <h3>사용자 ({members.length})</h3>
            <table className="table small">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>이름</th>
                  <th>역할</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId}>
                    <td>{m.username}</td>
                    <td>{m.displayName}</td>
                    <td>{MEMBER_ROLE_LABEL[m.role]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="card muted">왼쪽 표에서 스페이스를 선택하면 상세와 사용자 목록이 보인다.</div>
        )}
      </aside>
    </div>
  );
}
