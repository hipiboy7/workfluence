import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api';

/**
 * 아이디 찾기와 비밀번호 초기화 **요청** (FR-208, FR-209a).
 *
 * **결과가 없어도 "없다"고 말하지 않는다** — 그 자체가 계정 존재를 알려 준다.
 * 비밀번호는 여기서 발급하지 않는다. 미인증 화면이 비밀번호를 내주면 아이디와 사내 email을
 * 아는 사람이 곧 계정 소유자가 된다 (P1_설계서_Auth 2.4절).
 */
export function FindAccountPage() {
  const [id, setId] = useState({ email: '', displayName: '' });
  const [pw, setPw] = useState({ username: '', email: '' });
  const [idResult, setIdResult] = useState<string | null | undefined>(undefined);
  const [pwSent, setPwSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (e: FormEvent, fn: () => Promise<void>) => {
    e.preventDefault();
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main className="shell">
      <h1>아이디·비밀번호 찾기</h1>
      {error && <p className="badge fail" role="alert">{error}</p>}

      <form className="card" onSubmit={(e) => run(e, async () => setIdResult((await api<{ username: string | null }>('/api/auth/find-id', { method: 'POST', json: id })).username))}>
        <h2>아이디 찾기</h2>
        <label htmlFor="fi-email">email</label>
        <input id="fi-email" type="email" value={id.email} onChange={(e) => setId({ ...id, email: e.target.value })} required />
        <label htmlFor="fi-name">이름</label>
        <input id="fi-name" value={id.displayName} onChange={(e) => setId({ ...id, displayName: e.target.value })} required />
        <button type="submit">찾기</button>
        {idResult !== undefined && (
          <p aria-live="polite">
            {idResult ? <>아이디: <strong>{idResult}</strong> (일부만 표시된다)</> : '일치하는 정보로 찾을 수 없다. 관리자에게 문의한다.'}
          </p>
        )}
      </form>

      <form
        className="card"
        onSubmit={(e) =>
          run(e, async () => {
            await api<{ ok: true }>('/api/auth/recover-password', { method: 'POST', json: pw });
            setPwSent(true);
          })
        }
      >
        <h2>비밀번호 찾기</h2>
        <p className="muted small">
          비밀번호는 이 화면에서 바로 바꿔 드리지 않는다. 요청을 남기면 <strong>관리자가 확인하고 초기화</strong>한다.
        </p>
        <label htmlFor="fp-username">아이디</label>
        <input id="fp-username" value={pw.username} onChange={(e) => setPw({ ...pw, username: e.target.value })} required />
        <label htmlFor="fp-email">email</label>
        <input id="fp-email" type="email" value={pw.email} onChange={(e) => setPw({ ...pw, email: e.target.value })} required />
        <button type="submit">초기화 요청</button>
        {pwSent && (
          <p aria-live="polite">요청을 접수했다. 관리자에게 문의하면 임시 비밀번호를 받을 수 있다.</p>
        )}
      </form>
      <p className="muted small"><Link to="/login">로그인 화면으로</Link></p>
    </main>
  );
}
