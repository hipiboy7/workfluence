import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { useAuth } from '../auth';
import { AuthBrand } from '../layout/AuthLayout';
import { PasswordInput } from '../components/PasswordInput';
import { Field, FormActions, Notice, Page, PageHeader, useDocumentTitle } from '../components/ui';
import { usePasswordRuleText } from '../components/usePasswordRules';

/** 새 비밀번호가 지금 것과 같다 — 서버도 받지 않는다(`changePasswordDto`). 화면은 보내기 전에 칸 아래에 말한다 */
export const SAME_AS_CURRENT = '새 비밀번호가 현재 비밀번호와 같다 — 다른 비밀번호를 쓴다';
/** 확인 칸이 새 비밀번호와 다르다 — 확인 칸은 화면에만 있다(서버에 보내지 않는다) */
export const CONFIRM_MISMATCH = '새 비밀번호와 확인이 다르다';

const TITLE = '비밀번호 변경';

/**
 * 비밀번호 변경 (FR-207 · P17 F-010 1·9번).
 * - 지금 비밀번호와 새 비밀번호를 칸 묶음으로 나눈다. 새 비밀번호는 확인 칸을 한 번 더 받는다 — 지금 것과 같거나 확인이 다르면 칸 아래에 까닭을 보이고
 *   **변경**을 누를 수 없다
 * - 칸마다 눈 모양 단추(`PasswordInput`) — 처음은 감은 눈(가린다), 누르면 뜬 눈(글자로 보인다)
 * - 사내 계정은 비밀번호가 없어 여기서 바꾸지 않는다(P13 FR-1471)
 *
 * **틀이 둘이다**(P17 설계서 J.3.7) — 스스로 바꿀 때는 한 틀(`--w-form`, 머리 + 폼, 폼 아래에 **← 뒤로**·**홈으로**). 로그아웃은 위 막대에 있다.
 * 변경 강제 상태면 나갈 곳이 없다(앱이 이 화면으로 되돌린다) — 카드 틀(카드 480, 위에 주의 알림띠)이고 카드 아래에 **로그아웃**만 둔다.
 * 어느 틀인지는 `App.tsx`가 같은 판정(`mustChangePassword`)으로 고른다 — 여기는 그 틀 안의 모양만 맞춘다
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
  useDocumentTitle(TITLE);
  const forced = me?.mustChangePassword === true;
  const same = newPassword !== '' && newPassword === currentPassword;
  const mismatch = confirm !== '' && confirm !== newPassword;
  const ready = currentPassword !== '' && newPassword !== '' && confirm !== '' && !same && !mismatch;
  // 주소를 바로 열어 앞 화면이 없으면 홈으로 간다
  const back = () => (window.history.length > 1 ? nav(-1) : nav('/'));
  const home = () => nav('/');

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

  /** 변경 강제면 카드 틀 — 카드 아래에 로그아웃만. 아니면 한 틀의 폼 화면 */
  const frame = (notice: ReactNode, body: ReactNode) =>
    forced ? (
      <>
        <AuthBrand />
        <div className="auth-card wide">
          <h1>{TITLE}</h1>
          {notice}
          {body}
        </div>
        <p className="auth-links">
          <button type="button" className="subtle" onClick={() => void logout().then(() => nav('/login'))}>
            로그아웃
          </button>
        </p>
      </>
    ) : (
      <Page width="form">
        <PageHeader title={TITLE} />
        {notice}
        {body}
      </Page>
    );

  if (me && !me.hasPassword) {
    // 알림띠는 이 화면의 본문이다 — 불러오자마자 읽히는 알림(status)이 아니다
    return frame(
      <Notice kind="info" role={null}>
        사내 계정으로 로그인했다. 비밀번호는 사내 계정(IdP)에서 바꾼다.
      </Notice>,
      forced ? null : (
        <div className="actions">
          <button type="button" onClick={home}>
            홈으로
          </button>
        </div>
      ),
    );
  }

  return frame(
    forced && <Notice kind="warning">비밀번호를 변경해야 계속할 수 있다.</Notice>,
    <form onSubmit={submit} noValidate>
      {error && <Notice kind="error">{error}</Notice>}
      <fieldset className="field-group">
        <legend>지금 쓰는 비밀번호</legend>
        <Field id="cp-cur" label="현재 비밀번호">
          <PasswordInput id="cp-cur" name="현재 비밀번호" value={currentPassword} onChange={setCurrent} autoComplete="current-password" />
        </Field>
      </fieldset>
      <fieldset className="field-group">
        <legend>바꿀 비밀번호</legend>
        <Field id="cp-new" label="새 비밀번호" help={ruleText} error={same ? SAME_AS_CURRENT : undefined}>
          <PasswordInput id="cp-new" name="새 비밀번호" value={newPassword} onChange={setNew} autoComplete="new-password" />
        </Field>
        <Field id="cp-confirm" label="새 비밀번호 확인" error={mismatch ? CONFIRM_MISMATCH : undefined}>
          <PasswordInput id="cp-confirm" name="새 비밀번호 확인" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        </Field>
      </fieldset>
      <FormActions>
        <button type="submit" className="primary" disabled={busy || !ready}>
          {busy ? '바꾸는 중…' : '변경'}
        </button>
        {!forced && (
          <>
            <button type="button" onClick={back}>
              ← 뒤로
            </button>
            <button type="button" onClick={home}>
              홈으로
            </button>
          </>
        )}
      </FormActions>
    </form>,
  );
}
