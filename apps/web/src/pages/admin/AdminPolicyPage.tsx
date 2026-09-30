import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ALLOWED_UPLOAD_EXTENSIONS, policyConsistencyProblems, validatePolicyPatch, type Policy } from '@workfluence/shared';
import { api } from '../../api';
import { withCode } from '../../components/displayNames';
import { POLICY_GROUPS, POLICY_NAMES, policyKeysOf, type PolicyGroup, type PolicyNumberKey } from '../../components/policyNames';
import { FormActions, FormRow, FormRows, FormSection, Loading, Notice, Page, PageHeader } from '../../components/ui';

type PolicyView = Policy & { uploadCeilingMb: number };

const DESCRIPTION = '감사 기록 단계는 감사로그 화면에서 시스템 관리자가 고른다.';

/**
 * 운영 정책값 (P4_설계서_Admin C절). 판정은 서버와 **같은 함수**를 쓴다 — 갈라지면 화면만 받아 준다.
 *
 * 모양 (P17 J.6 관리 다섯 · J.5.4): 구획 폼 묶음 넷(세션·계정 / 업로드·첨부 / 보존 기간 / LLM 대화 — `fieldset`·`legend`), 한 줄에 값 하나.
 * 라벨은 "휴지통 보존 기간 (trashRetentionDays)" 꼴이다(J.9-9) — 한글 이름이 뜻을, 키가 장애대응가이드·감사로그·시험과의 연결을 맡는다
 * (`components/policyNames.ts`). 단위는 칸 뒤의 글이고 라벨에 넣지 않는다. 저장은 폼 끝의 주 단추 하나다
 */
export function AdminPolicyPage() {
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [exts, setExts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 결과는 폼 위에 보인다 — 저장은 폼 끝이라 화면 밖일 수 있어 보이는 자리로 옮긴다
  const noticeRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api<PolicyView>('/api/settings/policy')
      .then((p) => {
        setPolicy(p);
        setExts(p.allowedExtensions);
        setDraft({});
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (error || notice) noticeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [error, notice]);

  // 처음 읽기가 실패하면 까닭을 보인다 — 예전에는 "불러오는 중…"에 멈춰 있었다
  if (!policy) {
    return (
      <Page width="form">
        <PageHeader title="운영 설정" description={DESCRIPTION} />
        {error ? <Notice kind="error">{error}</Notice> : <Loading />}
      </Page>
    );
  }

  // 서버가 준 숫자 값 가운데 이 화면의 묶음에 든 것만 — 감사 기록 단계는 감사로그 화면에서 시스템 관리자가 고른다 (P17 FR-1842)
  const keysOf = (group: PolicyGroup): PolicyNumberKey[] => policyKeysOf(group).filter((k) => typeof policy[k] === 'number');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const patch: Record<string, unknown> = { ...draft };
    if (exts.join(',') !== policy.allowedExtensions.join(',')) patch.allowedExtensions = exts;
    // 서버와 같은 판정을 먼저 돌린다. 왕복하지 않고 바로 말해 준다
    // 값 하나하나의 범위와, **바꾼 뒤의 전체**로 보는 짝 규칙(LLM 고정 수 < 대화 수, P10 FR-1134)
    const problems = validatePolicyPatch(patch);
    if (!problems.length) problems.push(...policyConsistencyProblems({ ...policy, ...patch } as Policy));
    if (problems.length) {
      setError(problems.join('; '));
      return;
    }
    try {
      await api('/api/settings/policy', { method: 'PATCH', json: patch });
      setNotice('저장했다. 다음 요청부터 바로 먹는다 — 다시 띄울 필요가 없다.');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 숫자 값 한 줄 — 칸 뒤에 단위. 칸과 단위가 한 줄이라 도움말은 칸에 직접 잇는다(`FormRow`는 자식 하나에만 잇는다) */
  const numberRow = (k: PolicyNumberKey) => {
    const { name, unit, help: meaning, choices } = POLICY_NAMES[k];
    const help = k === 'uploadMaxMb' ? `이 서버의 천장 ${policy.uploadCeilingMb}MB — 그 위로는 올리지 못한다.` : meaning;
    // 값이 몇 가지뿐이면 고르는 칸 — 메일 재설정 켜기·끄기(P19 FR-2008). 값은 숫자 그대로 보낸다(서버의 범위 판정이 같다)
    if (choices) {
      return (
        <FormRow key={k} id={k} label={withCode(name, k)} help={help}>
          <select id={k} className="w-s" value={draft[k] ?? policy[k]} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })}>
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </FormRow>
      );
    }
    return (
      <FormRow key={k} id={k} label={withCode(name, k)} help={help}>
        <div className="inline">
          <input
            id={k}
            type="number"
            className="w-s"
            aria-describedby={help ? `${k}-help` : undefined}
            value={draft[k] ?? policy[k]}
            onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })}
          />
          <span className="muted">{unit}</span>
        </div>
      </FormRow>
    );
  };

  return (
    <Page width="form">
      <PageHeader title="운영 설정" description={DESCRIPTION} />
      <div ref={noticeRef}>
        {error && <Notice kind="error">{error}</Notice>}
        {notice && <Notice kind="success">{notice}</Notice>}
      </div>

      <form onSubmit={(e) => void submit(e)}>
        {POLICY_GROUPS.map((g) => (
          <FormSection key={g.id} as="fieldset" title={g.title}>
            <FormRows>
              {keysOf(g.id).map(numberRow)}
              {g.id === 'upload' && (
                // 체크 상자가 여럿인 줄 — 줄 이름은 글로 두고 상자마다 이름(확장자)을 가진다. 묶음은 그 글과 도움말로 읽힌다
                <FormRow id="allowed-extensions" label="허용 확장자" labelAs="span" help="판정 규칙이 있는 것만 켤 수 있다. 목록 밖 확장자는 내용 검사를 지나치게 된다.">
                  <div className="inline" role="group" aria-labelledby="allowed-extensions-label" aria-describedby="allowed-extensions-help">
                    {ALLOWED_UPLOAD_EXTENSIONS.map((ext) => (
                      <label key={ext}>
                        <input
                          type="checkbox"
                          checked={exts.includes(ext)}
                          onChange={(e) => setExts(e.target.checked ? [...exts, ext] : exts.filter((x) => x !== ext))}
                        />
                        {ext}
                      </label>
                    ))}
                  </div>
                </FormRow>
              )}
            </FormRows>
          </FormSection>
        ))}
        <FormActions>
          <button type="submit" className="primary">
            저장
          </button>
        </FormActions>
      </form>
    </Page>
  );
}
