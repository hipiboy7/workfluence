import { can, type SystemInfoView } from '@workfluence/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
import { api } from '../../api';
import { useAuth } from '../../auth';

/** root 화면 (최소 구성, prototype-v2 2절 13번): 시스템 정보 + 담당자 안내문 편집 + 관리 진입 */
export function SystemPage() {
  const { me } = useAuth();
  const [info, setInfo] = useState<SystemInfoView | null>(null);
  const [message, setMessage] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me || !can(me, 'system.manage')) return;
    api<SystemInfoView>('/api/system/info').then(setInfo).catch((e: Error) => setError(e.message));
    api<{ message: string }>('/api/settings/contact').then((r) => setMessage(r.message)).catch((e: Error) => setError(e.message));
  }, [me]);

  if (me && !can(me, 'system.manage')) return <Navigate to="/" replace />;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    try {
      await api('/api/settings/contact', { method: 'PUT', json: { message } });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '저장 실패');
    }
  };

  return (
    <div className="two-col">
      <section>
        <h1>시스템 (root)</h1>
        <p className="muted small">root 화면은 아직 최소 구성이다. 시스템 영역의 항목은 이후 설계에서 채운다.</p>
        {error && <p className="error">{error}</p>}
        {info && (
          <dl className="meta card">
            <dt>버전</dt>
            <dd>{info.version}</dd>
            <dt>Node</dt>
            <dd>{info.node}</dd>
            <dt>PostgreSQL</dt>
            <dd>{info.postgres}</dd>
            <dt>가동 시간</dt>
            <dd>{Math.floor(info.uptimeSec / 60)}분</dd>
            <dt>사용자</dt>
            <dd>
              {info.counts.users}명 (승인 대기 {info.counts.pendingUsers})
            </dd>
            <dt>스페이스 / 페이지</dt>
            <dd>
              {info.counts.spaces} / {info.counts.pages}
            </dd>
            <dt>감사 이벤트</dt>
            <dd>{info.counts.auditEvents}</dd>
          </dl>
        )}
        <p>
          <Link className="button" to="/admin">
            관리 화면으로 (admin 부여는 사용자 페이지의 역할 변경)
          </Link>
        </p>
      </section>
      <aside>
        <form className="card" onSubmit={save}>
          <h2>담당자 확인 안내문</h2>
          <p className="muted small">로그인 화면의 "담당자 확인"에 표시된다. 관리자 이름 목록은 자동으로 붙는다. email 등 개인정보는 넣지 않는다.</p>
          <textarea aria-label="담당자 안내문" value={message} onChange={(e) => setMessage(e.target.value)} rows={5} />
          {saved && <p className="notice info small">저장했다.</p>}
          <button type="submit" className="primary">
            저장
          </button>
        </form>
      </aside>
    </div>
  );
}
