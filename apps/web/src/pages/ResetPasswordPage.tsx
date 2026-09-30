import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { RESET_TOKEN_PATTERN } from '@workfluence/shared';
import { api } from '../api';
import { AuthBrand } from '../layout/AuthLayout';
import { PasswordInput } from '../components/PasswordInput';
import { Field, FormActions, Notice, useDocumentTitle } from '../components/ui';
import { usePasswordRuleText } from '../components/usePasswordRules';
import { CONFIRM_MISMATCH } from './ChangePasswordPage';

const TITLE = '새 비밀번호 정하기';

/** 링크가 모양이 아니다 — 서버에 가 보지 않는다 */
export const LINK_BROKEN = '링크가 올바르지 않다 — 메일의 링크를 다시 열거나, 비밀번호 찾기에서 다시 요청한다.';
export const RESET_DONE = '새 비밀번호를 정했다. 그 비밀번호로 로그인한다 — 이 계정으로 로그인돼 있던 곳은 모두 끊겼다.';

/** 주소의 `#t=값` — 없거나 모양이 아니면 `null` */
export function tokenFromHash(hash: string): string | null {
  const t = new URLSearchParams(hash.replace(/^#/, '')).get('t');
  return t && RESET_TOKEN_PATTERN.test(t) ? t : null;
}

/**
 * **메일의 링크로 새 비밀번호를 정한다** (P19 FR-2006·2013). 값은 주소의 `#` 뒤에 온다 — 브라우저가 서버로 보내지 않는다. **읽자마자 주소창에서 지운다**
 * (A.1-6 — 화면 공유·방문 기록에 남지 않게). 새 비밀번호와 확인 칸, 눈 모양, 규칙 안내 — 비밀번호 변경(P17 FR-1810)과 같다. 지금 비밀번호 칸은 없다 — 잊은
 * 사람이다. 정한 뒤 곧바로 들여보내지 않는다 — 로그인으로 간다(A.1-10).
 *
 * 카드 틀(P17 설계서 J.6 — 카드 제목이 h1)
 */
export function ResetPasswordPage() {
  const loc = useLocation();
  const nav = useNavigate();
  // 처음 그릴 때 한 번 읽는다 — 아래 효과가 주소에서 지운 뒤에도 값은 여기 남는다
  const [token] = useState(() => tokenFromHash(loc.hash));
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const ruleText = usePasswordRuleText();
  useDocumentTitle(TITLE);

  useEffect(() => {
    if (loc.hash) nav({ pathname: loc.pathname, search: loc.search }, { replace: true });
  }, [loc.hash, loc.pathname, loc.search, nav]);

  const mismatch = confirm !== '' && confirm !== newPassword;
  const ready = token !== null && newPassword !== '' && confirm !== '' && !mismatch;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await api<{ ok: true }>('/api/auth/reset-password', { method: 'POST', json: { token, newPassword } });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const card = () => {
    if (done) {
      return (
        <>
          <Notice kind="success">{RESET_DONE}</Notice>
          <FormActions>
            <Link className="btn primary" to="/login">
              로그인으로
            </Link>
          </FormActions>
        </>
      );
    }
    if (!token) {
      return (
        <>
          <Notice kind="error">{LINK_BROKEN}</Notice>
          <FormActions>
            <Link className="btn" to="/find-account">
              비밀번호 찾기로
            </Link>
          </FormActions>
        </>
      );
    }
    return (
      <form onSubmit={(e) => void submit(e)} noValidate>
        {error && <Notice kind="error">{error}</Notice>}
        <Field id="rp-new" label="새 비밀번호" help={ruleText}>
          <PasswordInput id="rp-new" name="새 비밀번호" value={newPassword} onChange={setNew} autoComplete="new-password" />
        </Field>
        <Field id="rp-confirm" label="새 비밀번호 확인" error={mismatch ? CONFIRM_MISMATCH : undefined}>
          <PasswordInput id="rp-confirm" name="새 비밀번호 확인" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        </Field>
        <FormActions>
          <button type="submit" className="primary" disabled={busy || !ready}>
            {busy ? '정하는 중…' : '새 비밀번호로 정하기'}
          </button>
        </FormActions>
      </form>
    );
  };

  return (
    <>
      <AuthBrand />
      <div className="auth-card wide">
        <h1>{TITLE}</h1>
        {card()}
      </div>
      <p className="auth-links">
        <Link to="/login">← 로그인으로</Link>
      </p>
    </>
  );
}
