import { Link } from 'react-router';
import { can } from '@workfluence/shared';
import { useAuth } from '../auth';

/** 로그인 후 첫 화면. Phase 2가 스페이스·페이지를 여기에 붙인다 */
export function HomePage() {
  const { me, logout } = useAuth();
  if (!me) return null;
  // 버튼 노출도 서버와 **같은 판정 함수**를 쓴다. 화면이 규칙을 다시 구현하면 어긋난다
  const principal = { id: me.id, role: me.role };

  return (
    <main className="shell">
      <h1>workfluence</h1>
      <section className="card">
        <h2>{me.displayName}님</h2>
        <dl className="meta">
          <dt>아이디</dt><dd>{me.username}</dd>
          <dt>역할</dt><dd><span className="badge ok">{me.role}</span></dd>
        </dl>
        <nav>
          {can(principal, 'user.manage') && <Link to="/admin/users">사용자 관리</Link>}
          {can(principal, 'audit.read') && <> · <Link to="/admin/audit">감사로그</Link></>}
          {' · '}<Link to="/change-password">비밀번호 변경</Link>
        </nav>
        <button type="button" onClick={() => void logout()}>로그아웃</button>
      </section>
      <p className="muted small">스페이스·페이지는 Phase 2에서 붙는다.</p>
    </main>
  );
}
