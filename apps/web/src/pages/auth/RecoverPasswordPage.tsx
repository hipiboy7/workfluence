import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../../api';
import { CopyableSecret } from '../../components/CopyableSecret';

/** PWD 찾기: ID + email → 임시 비밀번호 1회 표시. 로그인 후 즉시 변경이 강제된다 */
export function RecoverPasswordPage() {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<{ temporaryPassword: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    try {
      setResult(await api('/api/auth/recover-password', { method: 'POST', json: { username, email } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : '요청 실패');
    }
  };

  return (
    <div className="login-wrap">
      <div className="card login">
        <h1>PWD 찾기</h1>
        <p className="muted small">ID와 가입 시 등록한 email이 일치하면 임시 비밀번호를 발급한다. 이 화면에서만 볼 수 있으니 바로 로그인해 새 비밀번호로 바꾼다.</p>
        {result ? (
          <>
            <p className="notice info">
              임시 비밀번호: <CopyableSecret value={result.temporaryPassword} label="recover" />
            </p>
            <p className="muted small">{result.message}</p>
            <Link className="button primary wide" to="/login">
              로그인 화면으로
            </Link>
          </>
        ) : (
          <form onSubmit={onSubmit}>
            <label htmlFor="rp-username">사용자명 (ID)</label>
            <input id="rp-username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
            <label htmlFor="rp-email">email</label>
            <input id="rp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            {error && <p className="error">{error}</p>}
            <button type="submit" className="primary wide">
              임시 비밀번호 발급
            </button>
            <Link to="/login">← 로그인 화면</Link>
          </form>
        )}
      </div>
    </div>
  );
}
