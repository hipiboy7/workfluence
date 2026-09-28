import { Link } from 'react-router';

/**
 * 시스템 관리자 아이디 찾기 (P17 F-010 7번). **안내만 한다** — 실제 아이디를 보여 주지 않는다. 로그인하지 않은 사람에게 계정이 있는지 드러내지
 * 않는다(`CLAUDE.md` 7절 — ID 찾기는 마스킹, 계정 열거 방지). 시스템 관리자의 아이디는 설치 때 정한 값이다(`WF_ROOT_USERNAME`)
 */
export function RootIdHelpPage() {
  return (
    <main className="shell">
      <nav className="page-nav" aria-label="이동">
        <Link to="/login">← 로그인으로</Link>
      </nav>
      <section className="card">
        <h2>시스템 관리자 아이디 찾기</h2>
        <p>
          시스템 관리자(root)의 아이디는 <strong>설치할 때 정한 값</strong>이다. 따로 정하지 않았으면 <code>root</code>다.
        </p>
        <h3>서버 담당자가 확인하는 법</h3>
        <ol>
          <li>
            반입한 서버의 compose 폴더에서 설정 파일(<code>.env</code>)의 <code>WF_ROOT_USERNAME</code> 줄을 본다.
          </li>
          <li>
            또는 데이터베이스에서 본다:{' '}
            <code>docker exec workfluence-postgres psql -U workfluence -d workfluence -c &quot;SELECT username, status FROM users WHERE role = &apos;root&apos;&quot;</code>
          </li>
        </ol>
        <h3>비밀번호를 잊었을 때</h3>
        <p>시스템 관리자가 둘 이상이면 다른 시스템 관리자에게 부탁한다. 한 사람뿐이면 서버 담당자에게 알린다 — 장애 대응 가이드 7.29절(root로 로그인이 안 될 때).</p>
        <p className="muted small">
          이 화면은 누구의 아이디도 보여 주지 않는다 — 로그인하지 않은 사람에게 계정이 있는지 드러내지 않기 위해서다. 일반 사용자의 아이디는{' '}
          <Link to="/find-account">아이디·비밀번호 찾기</Link>에서 찾는다.
        </p>
      </section>
    </main>
  );
}
