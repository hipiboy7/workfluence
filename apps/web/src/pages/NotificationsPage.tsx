import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { NotificationView } from '@workfluence/shared';
import { LIST_PAGE_LIMIT } from '@workfluence/shared';
import { api } from '../api';

/** 알림함 (P4_설계서_Admin C절). **자기 것만 본다** — 서버에 남의 것을 볼 경로가 없다 */
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
      .then(load)
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
                {/* 부른 사람을 모르면 이름을 지어내지 않는다 (P8 FR-901) — 실시간 편집에서
                    그 멘션을 누가 생기게 했는지 확실하지 않을 때다 */}
                {n.actorName ? <><strong>{n.actorName}</strong>님이 불렀다</> : <>{n.commentId ? '댓글' : '문서'}에서 불렸다</>}
                {/* 대상이 지워지면 제목이 없다 (FR-506). 알림은 남되 갈 곳이 없음을 말한다 */}
                {n.pageTitle && n.pageId ? (
                  <> · <Link to={`/pages/${n.pageId}`}>{n.pageTitle}</Link></>
                ) : (
                  <> · <span className="muted">(지워진 글)</span></>
                )}
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
