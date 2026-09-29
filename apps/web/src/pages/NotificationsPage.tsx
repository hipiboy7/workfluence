import { useCallback, useEffect, useState } from 'react';
import type { NotificationView } from '@workfluence/shared';
import { LIST_PAGE_LIMIT } from '@workfluence/shared';
import { api } from '../api';
import { NOTIFICATIONS_CHANGED } from '../components/NotificationBell';
import { NotificationText } from '../components/NotificationText';
import { EmptyState, Loading, Notice, Page, PageHeader } from '../components/ui';

/**
 * 알림함 (P4_설계서_Admin C절 · P17 설계서 J.6 기본 문맥). **자기 것만 본다** — 서버에 남의 것을 볼 경로가 없다. 글은 모든 화면의 알림 영역과
 * 같다(`NotificationText`, P17). 멘션과 비밀번호 초기화 요청(관리자·시스템 관리자에게만)이 온다.
 *
 * 줄은 펼친 알림 목록과 같은 모양이다(J.5.12) — 안 읽은 줄은 왼쪽 막대와 "안 읽음" 글로 가른다. 색만으로 가르지 않는다(J.7).
 * 줄의 `li.card`와 부른 사람의 `strong` 하나는 E2E가 찾는다 — 줄 안에 다른 `strong`을 두지 않는다
 */
export function NotificationsPage() {
  const [rows, setRows] = useState<NotificationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<NotificationView[]>(`/api/notifications?limit=${LIST_PAGE_LIMIT}`)
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  const act = (path: string) => {
    setError(null);
    void api(path, { method: 'POST' })
      .then(() => {
        load();
        // 모든 화면의 알림 영역이 안 읽은 수를 곧바로 다시 묻는다 (P17)
        window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const unread = rows ? rows.filter((r) => !r.readAt).length : 0;

  return (
    <Page>
      <PageHeader
        title="알림함"
        // 받기 전에는 수를 말하지 않는다 — "0건"이 먼저 보이면 다 읽은 것으로 읽힌다
        description={rows ? `안 읽은 것 ${unread}건` : undefined}
        actions={
          unread > 0 && (
            <button type="button" className="subtle" onClick={() => act('/api/notifications/read-all')}>
              모두 읽음
            </button>
          )
        }
      />
      {error && <Notice kind="error">{error}</Notice>}
      {rows === null ? (
        !error && <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="알림이 없다." description="문서나 댓글에서 누가 부르면 여기에 온다." />
      ) : (
        <ul className="row-list" aria-label="알림 목록">
          {rows.map((n) => (
            <li key={n.id} className={n.readAt ? 'card' : 'card unread'}>
              <span className="grow">
                <NotificationText n={n} />
              </span>
              <span className="muted small">
                {new Date(n.createdAt).toLocaleString('ko-KR')}
                {n.readAt ? ' · 읽음' : ' · 안 읽음'}
              </span>
              {!n.readAt && (
                <button type="button" className="subtle" onClick={() => act(`/api/notifications/${n.id}/read`)}>
                  읽음
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
