import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../../api';

/** ID 찾기: email + 이름 → 마스킹된 ID (개인정보 보호: prototype-v2 2절 3번) */
export function FindIdPage() {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    try {
      const r = await api<{ maskedUsername: string }>('/api/auth/find-id', { method: 'POST', json: { email, displayName } });
      setResult(r.maskedUsername);
    } catch (err) {
      setError(err instanceof Error ? err.message : '조회 실패');
    }
  };

  return (
    <div className="login-wrap">
      <div className="card login">
        <h1>ID 찾기</h1>
        <p className="muted small">가입 시 등록한 email과 이름이 모두 일치해야 한다. ID는 일부가 가려진 형태로 표시된다.</p>
        <form onSubmit={onSubmit}>
          <label htmlFor="fi-email">email</label>
          <input id="fi-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <label htmlFor="fi-name">이름</label>
          <input id="fi-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          {error && <p className="error">{error}</p>}
          {result && (
            <p className="notice info">
              찾은 ID: <strong className="mono">{result}</strong>
            </p>
          )}
          <button type="submit" className="primary wide">
            찾기
          </button>
          <Link to="/login">← 로그인 화면</Link>
        </form>
      </div>
    </div>
  );
}
