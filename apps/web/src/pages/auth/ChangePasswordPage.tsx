import { PASSWORD_POLICY } from '@workfluence/shared';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { PasswordInput } from '../../components/PasswordInput';

export function ChangePasswordPage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError('새 비밀번호 확인이 일치하지 않는다');
      return;
    }
    setBusy(true);
    try {
      await api<void>('/api/auth/change-password', { method: 'POST', json: { currentPassword: current, newPassword: next } });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '변경 실패');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="narrow">
      <h1>비밀번호 변경</h1>
      {me?.mustChangePassword && <p className="notice warn">임시 비밀번호로 로그인했다. 계속하려면 새 비밀번호를 설정해야 한다.</p>}
      <form className="card" onSubmit={onSubmit}>
        <label htmlFor="cp-current">현재 비밀번호</label>
        <PasswordInput id="cp-current" value={current} onChange={setCurrent} autoComplete="current-password" required />
        <label htmlFor="cp-next">새 비밀번호 ({PASSWORD_POLICY.minLength}자 이상, {PASSWORD_POLICY.minCharClasses}종 조합)</label>
        <PasswordInput id="cp-next" value={next} onChange={setNext} autoComplete="new-password" required minLength={PASSWORD_POLICY.minLength} />
        <label htmlFor="cp-confirm">새 비밀번호 확인</label>
        <PasswordInput id="cp-confirm" value={confirm} onChange={setConfirm} autoComplete="new-password" required />
        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? '변경 중…' : '변경'}
        </button>
      </form>
    </div>
  );
}
