import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api';

/**
 * 아이디·비밀번호 찾기 (FR-208, FR-209).
 * **결과가 없어도 "없다"고 말하지 않는다** — 그 자체가 계정 존재를 알려 준다.
 */
export function FindAccountPage() {
  const [id, setId] = useState({ email: '', displayName: '' });
  const [pw, setPw] = useState({ username: '', email: '' });
  const [idResult, setIdResult] = useState<string | null | undefined>(undefined);
  const [pwResult, setPwResult] = useState<string | null | undefined>(undefined);
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

      <form className="card" onSubmit={(e) => run(e, async () => setPwResult((await api<{ temporaryPassword: string | null }>('/api/auth/recover-password', { method: 'POST', json: pw })).temporaryPassword))}>
        <h2>비밀번호 찾기</h2>
        <label htmlFor="fp-username">아이디</label>
        <input id="fp-username" value={pw.username} onChange={(e) => setPw({ ...pw, username: e.target.value })} required />
        <label htmlFor="fp-email">email</label>
        <input id="fp-email" type="email" value={pw.email} onChange={(e) => setPw({ ...pw, email: e.target.value })} required />
        <button type="submit">임시 비밀번호 발급</button>
        {pwResult !== undefined && (
          <div aria-live="polite">
            {pwResult ? (
              <>
                <p>임시 비밀번호: <code>{pwResult}</code></p>
                <p className="badge fail">이 값은 다시 볼 수 없다. 지금 옮겨 적는다. 로그인하면 변경을 요구한다.</p>
              </>
            ) : (
              <p>일치하는 정보로 찾을 수 없다. 관리자에게 문의한다.</p>
            )}
          </div>
        )}
      </form>
      <p className="muted small"><Link to="/login">로그인 화면으로</Link></p>
    </main>
  );
}
