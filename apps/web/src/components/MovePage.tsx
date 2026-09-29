import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { PAGE_TREE_MAX_DEPTH, type PageSummary } from '@workfluence/shared';
import { api } from '../api';
import { childrenOf, flattenTree, indentedTitle, subtreeIds } from './pageTree';
import { FormActions, FormRow, FormRows, FormSection, Loading, Notice } from './ui';

/**
 * 옮기기 칸 (P14_설계서_Spaces D.2, FR-1501·1502·1504). 새 부모(맨 위, 또는 같은 스페이스의 다른 페이지)와 자리(맨 앞, 또는 어느 페이지 다음)를
 * 고른다. **자리는 형제 가운데 몇 번째**(0부터)로 보낸다 — 서버가 새 자리 값을 정한다(P14 D.1).
 *
 * 자기와 그 아래는 목록에서 뺀다 — 편의다. 판정은 서버가 한다(`checkMove` — 깊이 10을 넘는 자리 등). 거절되면 서버의 까닭을 그대로 보인다(FR-1504).
 *
 * 모양은 구획 폼이다(P17 설계서 J.5.4) — 페이지 보기의 머리 줄 아래에 펼친다. 구역 이름 "페이지 옮기기"는 제목(h2)이 붙인다 — 시험이 그 이름으로 찾는다
 */
export function MovePage({ page, onMoved, onCancel }: { page: PageSummary; onMoved: () => void; onCancel: () => void }) {
  const [tree, setTree] = useState<PageSummary[] | null>(null);
  // 빈 값이 맨 위다 — `<select>`의 값은 글자라 `null`을 둘 수 없다
  const [parentId, setParentId] = useState<string>(page.parentId ?? '');
  // 고르지 않았으면 기본 자리(아래 `defaultIndex`)
  const [index, setIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<PageSummary[]>(`/api/pages?spaceId=${encodeURIComponent(page.spaceId)}`)
      .then(setTree)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [page.spaceId]);

  const blocked = useMemo(() => (tree ? subtreeIds(tree, page.id) : new Set<string>()), [tree, page.id]);
  const parents = useMemo(() => (tree ? flattenTree(tree).filter((r) => !blocked.has(r.id)) : []), [tree, blocked]);
  // **목록에 없는 부모는 고른 것으로 치지 않는다** — 부모가 그 사이 지워졌으면(고아) 칸은 "맨 위"를 보이는데 그 id를 보내 거절됐다 (병합 전 검토)
  const parentValue = parentId && tree?.some((p) => p.id === parentId && !blocked.has(p.id)) ? parentId : '';
  const parent = parentValue || null;
  const siblings = useMemo(() => (tree ? childrenOf(tree, parent).filter((p) => p.id !== page.id) : []), [tree, parent, page.id]);
  // **지금 부모면 지금 자리, 다른 부모면 맨 뒤** — 부모만 바꾸고 누르면 그 부모의 끝에 붙는다
  const defaultIndex = useMemo(() => {
    if (!tree || parent !== page.parentId) return siblings.length;
    const at = childrenOf(tree, page.parentId).findIndex((p) => p.id === page.id);
    return at < 0 ? siblings.length : at;
  }, [tree, parent, page.parentId, page.id, siblings.length]);
  const chosen = index ?? defaultIndex;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/pages/${encodeURIComponent(page.id)}/move`, { method: 'PATCH', json: { parentId: parent, position: chosen } });
      onMoved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormSection title="페이지 옮기기" titleId="mv-title">
      {error && <Notice kind="error">{error}</Notice>}
      {!tree ? (
        !error && <Loading />
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <FormRows>
            <FormRow id="mv-parent" label="어디 아래로" help={`자기 자신과 그 아래로는 옮길 수 없다. 페이지는 ${PAGE_TREE_MAX_DEPTH}단계까지 들어간다.`}>
              <select
                id="mv-parent"
                className="w-l"
                value={parentValue}
                onChange={(e) => {
                  setParentId(e.target.value);
                  setIndex(null);
                }}
              >
                <option value="">맨 위</option>
                {parents.map((r) => (
                  <option key={r.id} value={r.id}>
                    {indentedTitle(r)}
                  </option>
                ))}
              </select>
            </FormRow>
            <FormRow id="mv-at" label="자리">
              <select id="mv-at" className="w-l" value={chosen} onChange={(e) => setIndex(Number(e.target.value))}>
                <option value={0}>맨 앞</option>
                {siblings.map((s, i) => (
                  <option key={s.id} value={i + 1}>
                    {s.title} 다음
                  </option>
                ))}
              </select>
            </FormRow>
          </FormRows>
          <FormActions>
            <button type="submit" className="primary" disabled={busy}>
              옮기기
            </button>
            <button type="button" onClick={onCancel}>
              닫기
            </button>
          </FormActions>
        </form>
      )}
    </FormSection>
  );
}
