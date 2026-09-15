import { PASSWORD_POLICY } from '@workfluence/shared';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../../api';
import { PasswordInput } from '../../components/PasswordInput';

export function SignupPage() {
  const [form, setForm] = useState({ username: '', displayName: '', email: '', password: '', confirm: '' });
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (form.password !== form.confirm) {
      setError('비밀번호 확인이 일치하지 않는다');
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ message: string }>('/api/auth/signup', {
        method: 'POST',
        json: { username: form.username, displayName: form.displayName, email: form.email, password: form.password },
      });
      setDone(r.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : '가입 요청 실패');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="card login">
        <h1>신규 가입</h1>
        {done ? (
          <>
            <p className="notice info">{done}</p>
            <Link className="button wide" to="/login">
              로그인 화면으로
            </Link>
          </>
        ) : (
          <form onSubmit={onSubmit}>
            <label htmlFor="su-username">사용자명 (ID)</label>
            <input id="su-username" value={form.username} onChange={(e) => set('username')(e.target.value)} autoComplete="username" placeholder="소문자·숫자·._- 2~64자" required />
            <label htmlFor="su-name">이름</label>
            <input id="su-name" value={form.displayName} onChange={(e) => set('displayName')(e.target.value)} autoComplete="name" required />
            <label htmlFor="su-email">email</label>
            <input id="su-email" type="email" value={form.email} onChange={(e) => set('email')(e.target.value)} autoComplete="email" required />
            <label htmlFor="su-password">비밀번호 ({PASSWORD_POLICY.minLength}자 이상, {PASSWORD_POLICY.minCharClasses}종 조합)</label>
            <PasswordInput id="su-password" value={form.password} onChange={set('password')} autoComplete="new-password" required minLength={PASSWORD_POLICY.minLength} />
            <label htmlFor="su-confirm">비밀번호 확인</label>
            <PasswordInput id="su-confirm" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required />
            {error && <p className="error">{error}</p>}
            <button type="submit" className="primary wide" disabled={busy}>
              {busy ? '요청 중…' : '가입 요청'}
            </button>
            <p className="muted small">가입 요청은 관리자 승인 후 활성화된다.</p>
            <Link to="/login">← 로그인 화면</Link>
          </form>
        )}
      </div>
    </div>
  );
}
