import { API_TOKEN_LIMITS, type ApiTokenView } from '@workfluence/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { API_SCOPE_NAMES, ApiTokenList } from '../components/ApiTokenList';
import { writeClipboard } from '../components/clipboard';
import { useConfirm } from '../components/ConfirmDialog';
import { CodeBlock, Field, FormActions, FormSection, Loading, Notice, Page, PageHeader, useDocumentTitle } from '../components/ui';

type Config = { enabled: boolean; scopes: string[]; maxDays: number; defaultDays: number; maxPerUser: number };
type Created = { name: string; token: string };

const TITLE = 'API 토큰';

/**
 * 내 API 토큰 (docs/spinoff/public-api 설계서 FR-2222). 프로그램·에이전트가 위키를 쓸 때 보내는 열쇠를 **내가** 발급하고 폐기한다.
 * - 토큰은 그 주인이 화면에서 할 수 있는 일을 넘지 못한다 — 여기서 정하는 권한(scope)은 그것을 **줄이기만** 한다.
 * - **값은 발급 직후 한 번만** 보인다. 서버에도 값이 없어(해시도 아니다) 다시 보여 줄 길이 없다 — 잃으면 폐기하고 새로 발급한다.
 * - 켜짐·상한(권한·만료·개수)은 서버가 준 설정(`/api/tokens/config`)을 따른다. 관리(admin) 권한은 관리자만 고른다.
 * - 토큰으로 토큰을 만들지 못한다 — 이 화면은 세션으로만 쓴다.
 */
export function ApiTokensPage() {
  const { me } = useAuth();
  const [config, setConfig] = useState<Config | null>(null);
  const [tokens, setTokens] = useState<ApiTokenView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>(['read']);
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirm, dialog] = useConfirm();
  useDocumentTitle(TITLE);

  const reload = useCallback(async () => setTokens(await api<ApiTokenView[]>('/api/tokens')), []);
  useEffect(() => {
    void (async () => {
      try {
        const c = await api<Config>('/api/tokens/config');
        setConfig(c);
        if (c.enabled) await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [reload]);

  // 관리(admin) 권한은 관리자만 — 토큰은 사람의 권한을 넘지 못하지만, 쓸 수 없는 권한을 고르게 두지 않는다
  const scopes = (config?.scopes ?? []).filter((s) => s !== 'admin' || (me !== null && me.role !== 'member'));
  const toggle = (s: string) => setPicked((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]));
  const ready = name.trim() !== '' && picked.length > 0 && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || !config) return;
    setBusy(true);
    setError(null);
    setCopied(null);
    try {
      const body: { name: string; scopes: string[]; expiresInDays?: number } = { name: name.trim(), scopes: config.scopes.filter((s) => picked.includes(s)) };
      if (days.trim() !== '') body.expiresInDays = Number(days);
      const r = await api<ApiTokenView & { token: string }>('/api/tokens', { method: 'POST', json: body });
      setCreated({ name: r.name, token: r.token });
      setName('');
      setDays('');
      setPicked(['read']);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await writeClipboard(created.token);
      setCopied('복사했다');
    } catch {
      setCopied('복사하지 못했다 — 위의 값을 직접 고른다');
    }
  };

  const revoke = async (t: ApiTokenView) => {
    const ok = await confirm({
      title: `"${t.name}" 토큰을 폐기할까요?`,
      body: '폐기하면 이 토큰으로 오는 요청이 바로 401이 되고 되돌릴 수 없다. 필요하면 새로 발급한다.',
      confirmLabel: '폐기한다',
    });
    if (!ok) return;
    setBusyId(t.id);
    setError(null);
    try {
      await api(`/api/tokens/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  if (!config) {
    return (
      <Page>
        <PageHeader title={TITLE} />
        {error ? <Notice kind="error">{error}</Notice> : <Loading />}
      </Page>
    );
  }
  if (!config.enabled) {
    return (
      <Page>
        <PageHeader title={TITLE} />
        <Notice kind="info">공개 API가 꺼져 있다. 시스템 관리자가 서버에 켠 뒤에 토큰을 발급할 수 있다.</Notice>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader title={TITLE} />
      <p className="muted">프로그램이나 에이전트가 위키를 쓸 때 보내는 열쇠다. 이 토큰은 내가 화면에서 할 수 있는 일을 넘지 못한다.</p>
      {error && <Notice kind="error">{error}</Notice>}

      {created && (
        <Notice kind="warning">
          <p>
            <strong>{created.name}</strong> 토큰을 발급했다. 이 값은 지금 한 번만 보이고 <strong>다시 볼 수 없다</strong> — 안전한 곳에 옮겨 둔다. 잃으면 폐기하고 새로 발급한다.
          </p>
          <CodeBlock label="발급된 토큰">{created.token}</CodeBlock>
          <div className="actions">
            <button type="button" className="primary" onClick={() => void copy()}>
              값 복사
            </button>
            <button type="button" onClick={() => setCreated(null)}>
              확인했다
            </button>
            {copied && (
              <span role="status" className="muted small">
                {copied}
              </span>
            )}
          </div>
        </Notice>
      )}

      <FormSection title="새 토큰 발급" description={`한 사람이 살아 있는 토큰을 ${config.maxPerUser}개까지 가진다.`}>
        <form onSubmit={submit} noValidate>
          <Field id="tk-name" label="이름" required help="어디에 쓰는 토큰인지 알아볼 이름 — 예: 보고서 봇">
            <input id="tk-name" value={name} maxLength={API_TOKEN_LIMITS.nameMaxChars} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </Field>
          <fieldset className="field-group">
            <legend>권한</legend>
            {scopes.map((s) => (
              <label key={s} className="check">
                <input type="checkbox" checked={picked.includes(s)} onChange={() => toggle(s)} /> {API_SCOPE_NAMES[s] ?? s} ({s})
              </label>
            ))}
            <p className="muted small">쓰기는 읽기를 포함한다. 필요한 만큼만 고른다.</p>
          </fieldset>
          <Field id="tk-days" label="만료(일)" help={`비우면 ${config.defaultDays}일. 최대 ${config.maxDays}일.`}>
            <input id="tk-days" type="number" min={1} max={config.maxDays} step={1} placeholder={String(config.defaultDays)} value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
          <FormActions>
            <button type="submit" className="primary" disabled={!ready}>
              {busy ? '발급하는 중…' : '발급'}
            </button>
          </FormActions>
        </form>
      </FormSection>

      <FormSection title="내 토큰">
        <ApiTokenList tokens={tokens} onRevoke={(t) => void revoke(t)} busyId={busyId} />
      </FormSection>

      <FormSection title="쓰는 법">
        <p>
          요청마다 머리말에 토큰을 싣는다 — <code>Authorization: Bearer &lt;발급한 토큰&gt;</code>
        </p>
        <p>
          쓸 수 있는 경로의 명세는 <code>/api/v1/openapi.json</code>에서 인증 없이 받는다.
        </p>
      </FormSection>
      {dialog}
    </Page>
  );
}
