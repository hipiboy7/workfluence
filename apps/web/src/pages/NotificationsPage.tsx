import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { NotificationView } from '@workfluence/shared';
import { LIST_PAGE_LIMIT } from '@workfluence/shared';
import { api } from '../api';
import { NOTIFICATIONS_CHANGED } from '../components/NotificationBell';
import { NotificationText } from '../components/NotificationText';

/**
 * 알림함 (P4_설계서_Admin C절). **자기 것만 본다** — 서버에 남의 것을 볼 경로가 없다. 글은 모든 화면의 알림 영역과 같다(`NotificationText`, P17).
 * 멘션과 비밀번호 초기화 요청(관리자·시스템 관리자에게만)이 온다
 */
export function NotificationsPage() {
  const [rows, setRows] = useState<NotificationView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<NotificationView[]>(`/api/notifications?limit=${LIST_PAGE_LIMIT}`)
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  const act = (path: string) =>
    void api(path, { method: 'POST' })
      .then(() => {
        load();
        // 모든 화면의 알림 영역이 안 읽은 수를 곧바로 다시 묻는다 (P17)
        window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  const unread = rows.filter((r) => !r.readAt).length;

  return (
    <main className="shell">
      <p className="muted small"><Link to="/">← 스페이스 목록</Link></p>
      <h1>알림</h1>
      {error && <p className="badge fail" role="alert">{error}</p>}
      <p className="muted small">
        안 읽은 것 {unread}건
        {unread > 0 && (
          <>
            {' · '}
            <button type="button" className="linklike" onClick={() => act('/api/notifications/read-all')}>모두 읽음</button>
          </>
        )}
      </p>
      {rows.length === 0 ? (
        <p className="muted">알림이 없다.</p>
      ) : (
        <ul>
          {rows.map((n) => (
            <li key={n.id} className="card">
              <p className="small">
                <NotificationText n={n} />
              </p>
              <p className="muted small">
                {new Date(n.createdAt).toLocaleString('ko-KR')}
                {n.readAt ? ' · 읽음' : (
                  <>
                    {' · '}
                    <button type="button" className="linklike" onClick={() => act(`/api/notifications/${n.id}/read`)}>읽음</button>
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
