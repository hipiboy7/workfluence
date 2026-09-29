import { useEffect, useState } from 'react';
import type { PageTemplateView, PageView } from '@workfluence/shared';
import { api } from '../api';
import { useConfirm } from './ConfirmDialog';
import { FormActions, FormRow, FormRows, Notice } from './ui';

/**
 * 이 문서를 템플릿으로 (P6_설계서_Collab FR-740·743·745).
 *
 * **별도 관리 화면을 두지 않는다.** 템플릿이 되는 것은 언제나 "잘 쓴 문서 하나"이고,
 * 그 판단은 그것을 보고 있을 때 내린다. 목록과 지우기도 여기 함께 둔다 — 관리자가
 * 템플릿을 생각하는 자리가 한 곳이면 된다.
 *
 * 페이지 보기 맨 아래의 **접힌 구획**이다(P17 설계서 J.6) — 관리자는 날마다 문서를 읽으므로 펼쳐 두면 읽을 때마다 폼이 걸린다. 폼은 구획 폼의 줄
 * 목록(J.5.4)이고 라벨은 이름만이다(J.5.3 — 예전 "이 문서를 템플릿으로 저장 — 이름"·"설명 (없어도 된다)"). **지우기 전에 묻는다**(J.5.10) —
 * 템플릿은 물리 삭제라 되살릴 길이 없다
 */
export function TemplateFromPage({ page }: { page: PageView }) {
  const [list, setList] = useState<PageTemplateView[]>([]);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [msg, setMsg] = useState<{ kind: 'success' | 'info'; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, dialog] = useConfirm();

  const load = (): void => {
    api<PageTemplateView[]>('/api/templates')
      .then(setList)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);

  const save = (e: React.FormEvent): void => {
    e.preventDefault();
    setMsg(null);
    setError(null);
    void api<PageTemplateView>('/api/templates', {
      method: 'POST',
      json: { name, description: desc || null, content: page.content },
    })
      .then((t) => {
        // **같은 이름이면 있던 것을 돌려준다** (멱등). 덮어쓰지 않으므로 그것을 말해 준다 —
        // 안 그러면 "저장했는데 내용이 안 바뀌었다"가 된다
        const same = list.some((x) => x.id === t.id);
        setMsg(
          same
            ? { kind: 'info', text: `"${t.name}"은 이미 있다. 내용을 바꾸려면 지우고 다시 만든다.` }
            : { kind: 'success', text: `"${t.name}" 템플릿을 만들었다.` },
        );
        setName('');
        setDesc('');
        load();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const remove = async (t: PageTemplateView) => {
    // 확정 단추는 "지우기"를 품지 않는다 — 시험이 부른 단추와 확정 단추를 헷갈리지 않게(J.5.10)
    const ok = await confirm({
      title: '이 템플릿을 지울까요?',
      body: (
        <p>
          <strong>{t.name}</strong> 템플릿을 지운다. 되살릴 수 없다 — 그것으로 만든 문서는 그대로다.
        </p>
      ),
      confirmLabel: '지운다',
    });
    if (!ok) return;
    setMsg(null);
    setError(null);
    try {
      await api(`/api/templates/${t.id}`, { method: 'DELETE' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="doc-section" aria-label="템플릿">
      <h2>템플릿</h2>
      {dialog}
      {/* 알림띠는 접힌 구획 밖에 둔다 — 목록을 읽지 못한 오류가 접힌 채 숨지 않게 */}
      {error && <Notice kind="error">{error}</Notice>}
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <details>
        <summary>이 문서를 템플릿으로 저장 · 만든 템플릿 {list.length}개</summary>
        <form onSubmit={save}>
          <FormRows>
            <FormRow id="tpl-name" label="이름" required help="80자까지. 같은 이름이 있으면 새로 만들지 않는다.">
              <input id="tpl-name" className="w-m" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </FormRow>
            <FormRow id="tpl-desc" label="설명" help="없어도 된다. 200자까지.">
              <input id="tpl-desc" className="w-l" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={200} />
            </FormRow>
          </FormRows>
          <FormActions>
            <button type="submit" className="primary">
              템플릿으로 저장
            </button>
          </FormActions>
        </form>
        {list.length > 0 && (
          <>
            <h3>만든 템플릿</h3>
            <ul className="row-list">
              {list.map((t) => (
                <li key={t.id}>
                  <span className="grow">
                    <span className="row-title">{t.name}</span>
                    {t.description && <span className="muted"> — {t.description}</span>}
                  </span>
                  <button type="button" className="danger sm" aria-label={`${t.name} 지우기`} onClick={() => void remove(t)}>
                    지우기
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="muted small">템플릿을 지워도 그것으로 만든 문서는 그대로다 — 만들 때 내용을 복사하고 끝이다.</p>
      </details>
    </section>
  );
}
