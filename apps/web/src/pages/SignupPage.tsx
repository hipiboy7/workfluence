import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { AuthBrand } from '../layout/AuthLayout';
import { Field, FormActions, Notice, useDocumentTitle } from '../components/ui';
import { usePasswordRuleText } from '../components/usePasswordRules';

/**
 * 가입 요청 (FR-200, FR-242). 승인 전에는 로그인되지 않는다는 것을 화면이 먼저 말한다.
 *
 * 카드 틀(P17 설계서 J.6 — 카드 480, 카드 제목이 h1). 비밀번호 규칙은 칸 아래 도움말이다(칸의 `aria-describedby`). 눈 모양 단추는 두지 않는다
 * (J.5.3 — "비밀번호"로 칸을 찾는 이름 찾기가 그 단추에도 걸린다). 접수되면 폼 자리에 완료 알림띠를 둔다 — 누른 단추가 사라지므로 보조기기가
 * 결과를 읽게 `status`다
 */
export function SignupPage() {
  const ruleText = usePasswordRuleText();
  const [form, setForm] = useState({ username: '', displayName: '', email: '', password: '' });
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  useDocumentTitle('가입 요청');

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

  return (
    <>
      <AuthBrand />
      <div className="auth-card wide">
        <h1>가입 요청</h1>
        {done ? (
          <Notice kind="success">가입 요청이 접수됐다. 관리자가 승인하면 로그인할 수 있다. 승인 전에는 로그인되지 않는다.</Notice>
        ) : (
          <>
            {error && <Notice kind="error">{error}</Notice>}
            <form className="form-stack" onSubmit={submit}>
              <Field id="su-username" label="아이디" required>
                <input id="su-username" className="w-full" value={form.username} onChange={set('username')} />
              </Field>
              <Field id="su-name" label="이름" required>
                <input id="su-name" className="w-full" value={form.displayName} onChange={set('displayName')} />
              </Field>
              <Field id="su-email" label="email" required>
                <input id="su-email" className="w-full" type="email" value={form.email} onChange={set('email')} />
              </Field>
              <Field id="su-pw" label="비밀번호" help={ruleText} required>
                <input id="su-pw" className="w-full" type="password" value={form.password} onChange={set('password')} autoComplete="new-password" />
              </Field>
              <FormActions>
                <button type="submit" className="primary" disabled={busy}>
                  {busy ? '보내는 중…' : '가입 요청'}
                </button>
              </FormActions>
            </form>
          </>
        )}
      </div>
      <p className="auth-links">
        <Link to="/login">← 로그인으로</Link>
      </p>
    </>
  );
}
