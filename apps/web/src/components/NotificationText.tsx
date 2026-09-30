import { Link } from 'react-router';
import type { NotificationView } from '@workfluence/shared';

/**
 * 알림 한 건의 글 (P4_설계서_Admin C절 · P17 F-010 8번). 알림함과 모든 화면의 알림 영역(`NotificationBell`)이 같은 글을 쓴다 — 두 곳이 따로
 * 쓰면 한쪽이 어긋난다
 */
export function NotificationText({ n }: { n: NotificationView }) {
  if (n.kind === 'password.reset.request' || n.kind === 'email.confirm.request') {
    // 그 사람을 사용자 관리에서 찾는다 — 찾기 칸에 아이디를 넣어 연다. 요청은 감사로그에도 있다(`auth.password.recover`·`auth.email.help`).
    // **본인의 요청이라고 말하지 않는다** (P17 병합 전 검토 22) — 요청은 로그인 없이 이름·email(초기화 — P19 FR-2000) 또는 아이디·이름(email 확인 — FR-2009)만으로
    // 만들어지고, 그것을 아는 것은 본인이라는 보증이 아니다(P1 설계서 2.4절). 그래서 "누구의 무엇으로 요청됐다"고 말하고 본인 확인을 먼저 하라고 한다
    const reset = n.kind === 'password.reset.request';
    return (
      <>
        <strong>{n.actorName ?? '(알 수 없는 사용자)'}</strong>
        {n.actorUsername && <> ({n.actorUsername})</>}
        {reset ? '님의 이름·email로 비밀번호 초기화가 요청됐다 — 본인에게 확인한 뒤 초기화한다' : '님의 아이디·이름으로 email 확인이 요청됐다 — 본인에게 확인한 뒤 알려 준다'}
        {n.actorUsername && (
          <>
            {' · '}
            <Link to={`/admin/users?q=${encodeURIComponent(n.actorUsername)}`}>{reset ? '사용자 관리에서 초기화' : '사용자 관리에서 보기'}</Link>
          </>
        )}
      </>
    );
  }
  return (
    <>
      {/* 부른 사람을 모르면 이름을 지어내지 않는다 (P8 FR-901) — 실시간 편집에서 그 멘션을 누가 만들었는지 확실하지 않을 때다 */}
      {n.actorName ? (
        <>
          <strong>{n.actorName}</strong>님이 불렀다
        </>
      ) : (
        <>{n.commentId ? '댓글' : '문서'}에서 불렸다</>
      )}
      {/* 대상이 지워지면 제목이 없다 (FR-506). 알림은 남되 갈 곳이 없음을 말한다 */}
      {n.pageTitle && n.pageId ? (
        <>
          {' · '}
          <Link to={`/pages/${n.pageId}`}>{n.pageTitle}</Link>
        </>
      ) : (
        <>
          {' · '}
          <span className="muted">(지워진 글)</span>
        </>
      )}
    </>
  );
}
