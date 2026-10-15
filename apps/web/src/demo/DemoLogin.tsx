import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../auth';
import { Notice } from '../components/ui';
import { DEMO_ACCOUNTS } from './seed';
import { resetDemo } from './server';
import { DEMO_PASSWORD } from './store';

/**
 * 시연판의 로그인 안내 (F-015) — 시연 계정을 한 번에 고르고, 시연 데이터를 처음으로 되돌린다. `LoginPage`가 시연 빌드에서만 그린다
 */
export default function DemoLogin() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [msg, setMsg] = useState<string | null>(null);
  const enter = async (username: string) => {
    await login(username, DEMO_PASSWORD);
    nav('/', { replace: true });
  };
  return (
    <div className="demo-login">
      <Notice kind="info">
        <strong>시연판</strong> — 이 앱은 서버 없이 폰 안에서만 돕니다. 인터넷을 쓰지 않습니다. 내용은 모두 지어낸 시연 데이터입니다.
      </Notice>
      <p className="demo-login-label">시연 계정으로 들어가기 (비밀번호 {DEMO_PASSWORD})</p>
      <div className="demo-login-accounts">
        {DEMO_ACCOUNTS.map((a) => (
          <button key={a.username} type="button" onClick={() => void enter(a.username)}>
            {a.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="subtle"
        onClick={() => {
          resetDemo();
          setMsg('시연 데이터를 처음 상태로 되돌렸습니다.');
        }}
      >
        시연 데이터 처음으로
      </button>
      {msg && <p className="muted" role="status">{msg}</p>}
    </div>
  );
}
