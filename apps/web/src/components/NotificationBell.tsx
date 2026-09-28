import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { NOTIFICATION_PANEL_LIMIT, NOTIFICATION_POLL_MS, type NotificationView } from '@workfluence/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { NotificationText } from './NotificationText';

/** 알림함이 읽음을 바꾸면 이 이름으로 알린다 — 알림 영역이 안 읽은 수를 곧바로 다시 묻는다 */
export const NOTIFICATIONS_CHANGED = 'wf:notifications-changed';

/** 단추의 이름 — 안 읽은 수를 함께 읽어 준다 */
export const bellLabel = (count: number): string => (count > 0 ? `알림 — 안 읽은 것 ${count}건` : '알림');

/**
 * 모든 화면의 알림 영역 (P17 F-010 8번). 로그인한 사람의 화면 맨 위 오른쪽에 **알림**과 안 읽은 수를 두고, 누르면 최근 알림
 * (`NOTIFICATION_PANEL_LIMIT`건)이 펼쳐진다. 예전에는 스페이스 목록의 머리말에만 수가 있었고 다른 화면에서는 알림이 온 것을 알 수 없었다.
 *
 * - 안 읽은 수는 화면을 옮길 때와 `NOTIFICATION_POLL_MS`마다 다시 묻는다 — 서버가 밀어 주는 길은 없다(알림함과 같은 API). 실패해도 화면을 막지 않는다
 * - 펼친 목록은 바깥을 누르거나 Esc를 누르거나 화면을 옮기면 닫힌다
 * - 비밀번호를 바꿔야 하는 동안은 그리지 않는다 — 그 화면 밖으로 나갈 수 없다(P1 FR-209)
 */
export function NotificationBell() {
  const { me } = useAuth();
  const location = useLocation();
  const active = !!me && !me.mustChangePassword;
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    api<{ count: number }>('/api/notifications/unread-count')
      .then((r) => setCount(r.count))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
    const timer = window.setInterval(refresh, NOTIFICATION_POLL_MS);
    window.addEventListener(NOTIFICATIONS_CHANGED, refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(NOTIFICATIONS_CHANGED, refresh);
    };
  }, [active, refresh, location.key]);

  // 화면을 옮기면 닫는다 — 알림의 링크를 누른 뒤에도
  useEffect(() => setOpen(false), [location.key]);

  useEffect(() => {
    if (!open) return;
    setRows(null);
    setError(null);
    api<NotificationView[]>(`/api/notifications?limit=${NOTIFICATION_PANEL_LIMIT}`)
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  if (!active) return null;
  return (
    <div className="global-bar">
      <div className="notify" ref={box}>
        <button
          type="button"
          className="secondary notify-button"
          aria-label={bellLabel(count)}
          aria-expanded={open}
          aria-controls="notify-panel"
          onClick={() => setOpen((v) => !v)}
        >
          <BellIcon />
          <span aria-hidden="true">알림</span>
          {count > 0 && (
            <span className="notify-count" aria-hidden="true">
              {count}
            </span>
          )}
        </button>
        {open && (
          <div id="notify-panel" className="notify-panel" role="region" aria-label="최근 알림">
            <p className="notify-head">
              <strong>최근 알림</strong>
              <Link to="/notifications">알림함에서 모두 보기</Link>
            </p>
            {error && (
              <p className="badge fail" role="alert">
                {error}
              </p>
            )}
            {!error && rows === null && <p className="muted small">불러오는 중…</p>}
            {rows?.length === 0 && <p className="muted small">알림이 없다.</p>}
            {rows && rows.length > 0 && (
              <ul className="notify-list">
                {rows.map((n) => (
                  <li key={n.id} className={n.readAt ? 'read' : 'unread'}>
                    <p className="small">
                      <NotificationText n={n} />
                    </p>
                    <p className="muted small">
                      {new Date(n.createdAt).toLocaleString('ko-KR')}
                      {n.readAt ? ' · 읽음' : ' · 안 읽음'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 종 모양 — 이 파일 안의 SVG다(외부 자원을 쓰지 않는다, `CLAUDE.md` 7절) */
const BellIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
    <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <path d="M10 20.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
