import type { ApiTokenView, UserView } from '@workfluence/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { ApiTokenList } from './ApiTokenList';
import { useConfirm } from './ConfirmDialog';
import { Loading, Notice } from './ui';

/**
 * 사용자 관리에서 **그 사람의** API 토큰을 보고 폐기한다 (docs/spinoff/public-api 설계서 FR-2222). 새어 나갔다고 의심되는 토큰을 그 자리에서 죽이는
 * 곳이다 — 값은 보이지 않는다(꺼내 보는 일이 아니다). 서버가 `user.manage`와 그 사람을 관리할 수 있는지(역할·위임)를 본다
 */
export function UserTokensPanel({ user, onClose }: { user: Pick<UserView, 'id' | 'username' | 'displayName'>; onClose: () => void }) {
  const [tokens, setTokens] = useState<ApiTokenView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, dialog] = useConfirm();
  const base = `/api/users/${encodeURIComponent(user.id)}/tokens`;

  const load = useCallback(async () => {
    try {
      setTokens(await api<ApiTokenView[]>(base));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (t: ApiTokenView) => {
    const ok = await confirm({
      title: `"${t.name}" 토큰을 폐기할까요?`,
      body: `${user.displayName}(${user.username})님의 토큰이다. 폐기하면 이 토큰으로 오는 요청이 바로 401이 되고 되돌릴 수 없다. 감사 기록에 폐기한 사람으로 남는다.`,
      confirmLabel: '폐기한다',
    });
    if (!ok) return;
    setBusyId(t.id);
    try {
      await api(`${base}/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="form-section" aria-label={`API 토큰 — ${user.username}`}>
      <h2>
        {user.displayName}({user.username})님의 API 토큰
      </h2>
      {error && <Notice kind="error">{error}</Notice>}
      {tokens === null && !error ? <Loading /> : tokens && <ApiTokenList tokens={tokens} onRevoke={(t) => void revoke(t)} busyId={busyId} emptyText="발급한 토큰이 없다" />}
      <div className="actions">
        <button type="button" onClick={onClose}>
          닫기
        </button>
      </div>
      {dialog}
    </section>
  );
}
