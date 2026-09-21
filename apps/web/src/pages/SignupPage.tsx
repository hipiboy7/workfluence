import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api';

/** 가입 요청 (FR-200, FR-242). 승인 전에는 로그인되지 않는다는 것을 화면이 먼저 말한다 */
export function SignupPage() {
  const [form, setForm] = useState({ username: '', displayName: '', email: '', password: '' });
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/signup', { method: 'POST', json: form });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <main className="shell">
        <section className="card">
          <h2>가입 요청이 접수됐다</h2>
          <p>관리자가 승인하면 로그인할 수 있다. 승인 전에는 로그인되지 않는다.</p>
          <Link to="/login">로그인 화면으로</Link>
        </section>
      </main>
    );

  return (
    <main className="shell">
      <form className="card" onSubmit={submit}>
        <h2>가입 요청</h2>
        <label htmlFor="su-username">아이디</label>
        <input id="su-username" value={form.username} onChange={set('username')} required />
        <label htmlFor="su-name">이름</label>
        <input id="su-name" value={form.displayName} onChange={set('displayName')} required />
        <label htmlFor="su-email">email</label>
        <input id="su-email" type="email" value={form.email} onChange={set('email')} required />
        <label htmlFor="su-pw">비밀번호</label>
        <input id="su-pw" type="password" value={form.password} onChange={set('password')} autoComplete="new-password" required />
        <p className="muted small">8자 이상, 영문 대·소문자·숫자·특수문자 중 2종 이상</p>
        {error && <p className="badge fail" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? '보내는 중…' : '가입 요청'}</button>
        <p className="muted small"><Link to="/login">로그인 화면으로</Link></p>
      </form>
    </main>
  );
}
