import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { useAuth } from '../auth';
import { PasswordInput } from '../components/PasswordInput';
import { usePasswordRuleText } from '../components/usePasswordRules';

/** 새 비밀번호가 지금 것과 같다 — 서버도 받지 않는다(`changePasswordDto`). 화면은 보내기 전에 칸 아래에 말한다 */
export const SAME_AS_CURRENT = '새 비밀번호가 현재 비밀번호와 같다 — 다른 비밀번호를 쓴다';
/** 확인 칸이 새 비밀번호와 다르다 — 확인 칸은 화면에만 있다(서버에 보내지 않는다) */
export const CONFIRM_MISMATCH = '새 비밀번호와 확인이 다르다';

/**
 * 비밀번호 변경 (FR-207 · P17 F-010 1·9번).
 * - 지금 비밀번호와 새 비밀번호를 칸 묶음으로 나눈다. 새 비밀번호는 확인 칸을 한 번 더 받는다 — 지금 것과 같거나 확인이 다르면 칸 아래에 까닭을 보이고
 *   **변경**을 누를 수 없다
 * - 칸마다 눈 모양 단추(`PasswordInput`) — 처음은 감은 눈(가린다), 누르면 뜬 눈(글자로 보인다)
 * - 위에 **← 뒤로**·**홈으로**. 변경 강제 상태면 나갈 곳이 없다(앱이 이 화면으로 되돌린다) — 그때는 **로그아웃**만 둔다
 * - 사내 계정은 비밀번호가 없어 여기서 바꾸지 않는다(P13 FR-1471)
 */
export function ChangePasswordPage() {
  const { me, refresh, logout } = useAuth();
  const nav = useNavigate();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ruleText = usePasswordRuleText();
  const same = newPassword !== '' && newPassword === currentPassword;
  const mismatch = confirm !== '' && confirm !== newPassword;
  const ready = currentPassword !== '' && newPassword !== '' && confirm !== '' && !same && !mismatch;
  // 주소를 바로 열어 앞 화면이 없으면 홈으로 간다
  const back = () => (window.history.length > 1 ? nav(-1) : nav('/'));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/change-password', { method: 'POST', json: { currentPassword, newPassword } });
      await refresh();
      nav('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const pageNav = me?.mustChangePassword ? (
    <nav className="page-nav" aria-label="이동">
      <button type="button" className="secondary" onClick={() => void logout().then(() => nav('/login'))}>
        로그아웃
      </button>
    </nav>
  ) : (
    <nav className="page-nav" aria-label="이동">
      <button type="button" className="secondary" onClick={back}>
        ← 뒤로
      </button>
      <button type="button" className="secondary" onClick={() => nav('/')}>
        홈으로
      </button>
    </nav>
  );

  if (me && !me.hasPassword) {
    return (
      <main className="shell">
        <section className="card">
          <h2>비밀번호 변경</h2>
          <p>사내 계정으로 로그인했다. 비밀번호는 사내 계정(IdP)에서 바꾼다.</p>
          <button type="button" onClick={() => nav('/')}>
            홈으로
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      {pageNav}
      <form className="card pw-form" onSubmit={submit} noValidate>
        <h2>비밀번호 변경</h2>
        {me?.mustChangePassword && <p className="badge fail">비밀번호를 변경해야 계속할 수 있다.</p>}
        <fieldset className="field-group">
          <legend>지금 쓰는 비밀번호</legend>
          <label htmlFor="cp-cur">현재 비밀번호</label>
          <PasswordInput id="cp-cur" name="현재 비밀번호" value={currentPassword} onChange={setCurrent} autoComplete="current-password" />
        </fieldset>
        <fieldset className="field-group">
          <legend>바꿀 비밀번호</legend>
          <label htmlFor="cp-new">새 비밀번호</label>
          <PasswordInput
            id="cp-new"
            name="새 비밀번호"
            value={newPassword}
            onChange={setNew}
            autoComplete="new-password"
            invalid={same}
            describedBy={same ? 'cp-new-err' : 'cp-rule'}
          />
          {same && (
            <p id="cp-new-err" className="field-error" role="alert">
              {SAME_AS_CURRENT}
            </p>
          )}
          <p id="cp-rule" className="muted small">
            {ruleText}
          </p>
          <label htmlFor="cp-confirm">새 비밀번호 확인</label>
          <PasswordInput
            id="cp-confirm"
            name="새 비밀번호 확인"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            invalid={mismatch}
            describedBy={mismatch ? 'cp-confirm-err' : undefined}
          />
          {mismatch && (
            <p id="cp-confirm-err" className="field-error" role="alert">
              {CONFIRM_MISMATCH}
            </p>
          )}
        </fieldset>
        {error && (
          <p className="badge fail" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || !ready}>
          {busy ? '바꾸는 중…' : '변경'}
        </button>
      </form>
    </main>
  );
}
