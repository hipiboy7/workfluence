import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { CATEGORY_NAME_MAX, type CategoryView, type SpaceView } from '@workfluence/shared';
import { api } from '../api';
import { CategoryList } from './CategoryList';
import { useConfirm, type ConfirmOptions } from './ConfirmDialog';
import { FormActions, FormRow, FormRows, FormSection, Notice } from './ui';

/**
 * 중지를 묻는 말 — 스페이스 화면의 관리 칸과 관리 콘솔이 같이 쓴다(같은 말을 두 곳에 적으면 한쪽만 바뀐다). **열어 둔 편집 창은 곧바로 끊기지
 * 않는다** — 주기 재판정(`WF_COLLAB_RECHECK_MS`, 기본 5분)이 끊는다(병합 전 자체 점검 15)
 */
export function confirmSuspendText(name: string): string {
  return `"${name}"을(를) 중지한다. 모두 읽기만 되고(열어 둔 편집 창은 몇 분 안에 끊긴다), 다시 쓰기로 되돌릴 수 있다.`;
}

/**
 * **주인이 건 중지를 넘겨받는가** — 관리자·스페이스 관리 전체(주인이 아닌 사람)가 다시 걸면 관리자가 건 중지가 된다(P15 A.1-12, 병합 전 보안 검토 1).
 * 관리 칸과 관리 콘솔이 같은 조건·같은 말을 쓴다
 */
export function canTakeOver(space: SpaceView): boolean {
  return space.status === 'suspended' && space.suspendedByOwner && space.access.canChangeStatus && !space.access.isOwner;
}
export function confirmTakeoverText(name: string): string {
  return `"${name}"은(는) 주인이 중지했다 — 주인이 언제든 다시 쓰기로 푼다. 관리자가 건 중지로 바꾸면 주인은 '관리자가 건 중지 풀기'를 받아야 푼다.`;
}

/**
 * 확인 대화의 내용 (P17 J.5.10) — 관리 칸과 관리 콘솔이 같은 제목·같은 확정 단추를 쓰게 여기 둔다. **확정 단추는 부른 단추의 이름을 품지 않는다**
 * ("중지" → "멈춘다", "관리자가 건 중지로 바꾸기" → "넘겨받는다", "지우기" → "지운다") — 시험과 사람이 둘을 헷갈리지 않게. 제목에는 이름을 넣지
 * 않는다 — 대화가 떠 있는 동안 스페이스 이름의 제목이 둘이 된다(이름은 본문에 있다)
 */
export function suspendConfirm(name: string): ConfirmOptions {
  return { title: '스페이스를 중지할까요?', body: confirmSuspendText(name), confirmLabel: '멈춘다' };
}
export function takeoverConfirm(name: string): ConfirmOptions {
  return { title: '관리자가 건 중지로 바꿀까요?', body: confirmTakeoverText(name), confirmLabel: '넘겨받는다' };
}
export function deleteSpaceConfirm(name: string): ConfirmOptions {
  return {
    title: '스페이스를 지울까요?',
    body: `"${name}"을(를) 지운다. 스페이스와 그 안의 페이지가 보이지 않게 된다 — 되살리기는 관리자(와 스페이스 관리 전체를 받은 사람)가 휴지통에서 한다.`,
    confirmLabel: '지운다',
  };
}

/** 결과를 보일 구획 — 조치한 구획 바로 위에 둔다(J.5.7). 정보 칸의 새 분류도 정보 구획이다 */
type Area = 'info' | 'category' | 'status';

/**
 * 스페이스 화면의 **관리** 칸 (P14_설계서_Spaces D.3, FR-1510·1511 · P15_설계서_Grants D.5). 보이는 조건은 응답의 `access`다(P2 FR-345) — 화면은
 * 규칙을 다시 만들지 않는다. 이름·설명·분류는 `canEditInfo`(주인과 관리자), 중지·다시 쓰기는 `canChangeStatus`(지금 상태에서 바꿀 수 있는가),
 * 지우기는 `canDelete`. 중지된 스페이스는 이름·설명·분류를 바꿀 수 없다(서버 규칙).
 *
 * **새 분류**를 여기서 만든다(P15 FR-1620) — 만든 것이 고른 상태가 되고, 공간에 붙는 것은 **저장**을 눌렀을 때다(A.1-8). 아래 **분류 관리**는 내가
 * **만들었고** 이름을 바꾸거나 지울 수 있는 분류들이다(`CategoryList`) — 관리자는 모든 분류를 바꾸지만 그것을 공간마다 늘어놓지 않는다(관리 콘솔의
 * 스페이스 관리가 모든 분류를 보인다). 중지된 공간에는 누가 중지했는지 보이고, 관리자가 건 중지를 풀지 못하는 주인에게는 그 까닭을 보인다(FR-1612).
 *
 * 중지와 지우기는 한 번 더 묻는다(A.1-7) — 확인 대화다(P17 J.5.10). 지우면 스페이스 목록으로 간다 — 되살리기는 관리자(와 스페이스 관리 전체를
 * 받은 사람)가 휴지통에서 한다. 관리자에게는 주인이 건 중지를 **넘겨받는** 단추가 있다(`canTakeOver`). 거절되면(그 사이 누가 바꿨다) 다시 읽는다.
 *
 * 모양 (P17 J.6 스페이스 문맥): 구역 "스페이스 관리" 안에 **스페이스 정보**(구획 폼 — 이름·설명·분류·새 분류 → 저장) → **분류 관리**(줄 목록) →
 * **위험 구역**(중지·다시 쓰기·넘겨받기·지우기). 결과와 거절은 조치한 구획 안의 알림띠다. 보일 것이 없으면 아무것도 그리지 않는다 — 감싸는 요소도
 */
export function SpaceManage({
  space,
  meId,
  onChanged,
  onDeleted,
}: {
  space: SpaceView;
  meId: string | undefined;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description);
  const [categoryId, setCategoryId] = useState(space.categoryId ?? '');
  const [categories, setCategories] = useState<CategoryView[]>([]);
  const [newCategory, setNewCategory] = useState('');
  // 만들기를 두 번 누르면 같은 이름이 두 번 간다 — 앞의 것이 끝날 때까지 받지 않는다
  const creating = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [area, setArea] = useState<Area>('info');
  const [confirm, dialog] = useConfirm();
  const active = space.status === 'active';
  const { canEditInfo, canChangeStatus, canDelete, isOwner } = space.access;
  // 중지된 공간의 주인에게도 보인다 — 풀지 못해도 까닭은 들어야 한다 (P15 FR-1612)
  const visible = canEditInfo || canChangeStatus || canDelete;

  // **서버의 값이 바뀌었을 때만**, 그리고 **바뀐 칸만** 맞춘다 — 부모는 Crew를 바꿀 때도 스페이스를 다시 읽는데, 그때마다 맞추면 치던 이름·설명이
  // 지워졌다(P14 병합 전 검토). 칸마다 따로 둔다 — 쓰던 분류를 지워 분류만 바뀌어도 치던 이름·설명이 지워졌다(P15 병합 전 코드 리뷰 8)
  useEffect(() => setName(space.name), [space.id, space.name]);
  useEffect(() => setDescription(space.description), [space.id, space.description]);
  useEffect(() => setCategoryId(space.categoryId ?? ''), [space.id, space.categoryId]);
  // 분류 읽기의 순번 — **늦게 온 옛 목록은 버린다.** 저장 뒤 다시 읽는 사이 새 분류를 만들면, 만들기 전의 목록이 늦게 와 새 분류를 빼고 고른 것을
  // "분류 없음"으로 돌려 다음 저장이 조용히 분류를 비웠다(좁은 재검토 1). 만들기도 순번을 올린다 — 그 전에 떠난 읽기는 새 분류를 모른다
  const catSeq = useRef(0);
  const loadCategories = useCallback(() => {
    const mine = ++catSeq.current;
    api<CategoryView[]>('/api/categories')
      .then((list) => {
        if (mine !== catSeq.current) return;
        setCategories(list);
        // 고른 채 저장하지 않은 분류가 지워졌으면 고르지 않은 것으로 — 그대로 저장하면 "없는 분류다"였다(병합 전 코드 리뷰 8)
        setCategoryId((cur) => (cur && !list.some((c) => c.id === cur) ? '' : cur));
      })
      .catch(() => {
        if (mine === catSeq.current) setCategories([]);
      });
  }, []);
  useEffect(() => {
    // 이름·분류를 바꿀 수 있을 때만 읽는다. 분류를 못 읽어도 나머지 관리는 된다 — 화면 오류로 올리지 않는다
    if (canEditInfo) loadCategories();
  }, [canEditInfo, loadCategories]);

  if (!visible) return null;

  const run = async (at: Area, fn: () => Promise<unknown>, done: string, after?: () => void) => {
    setArea(at);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      after?.();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // 그 사이 누가 바꿔 거절됐으면(409·403·400 "없는 분류다") 지금 상태를 다시 읽는다 — 옛 단추·옛 선택이 남으면 다시 눌러도 같은 거절이다(병합 전
      // 코드 리뷰 12 · 좁은 재검토 4)
      after?.();
      onChanged();
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    // 저장하면 분류의 쓰임이 바뀐다 — 다시 읽어야 분류 관리의 개수와 지우기 확인이 맞다(병합 전 코드 리뷰 2)
    void run('info', () => api(`/api/spaces/${space.id}`, { method: 'PATCH', json: { name, description, categoryId: categoryId || null } }), '저장했다.', loadCategories);
  };

  // 새 분류 — 만들거나(같은 이름이면 있던 것을) 고른다. 저장을 눌러야 붙는다 (P15 A.1-8)
  const addCategory = () => {
    const n = newCategory.trim();
    if (!n || creating.current) return;
    creating.current = true;
    setBusy(true);
    setArea('info');
    setError(null);
    setNotice(null);
    api<CategoryView>('/api/categories', { method: 'POST', json: { name: n } })
      .then((c) => {
        // 그 전에 떠난 분류 읽기는 이 분류를 모른다 — 늦게 와도 받지 않는다
        catSeq.current += 1;
        const existed = categories.some((x) => x.id === c.id);
        setCategories((list) => (list.some((x) => x.id === c.id) ? list : [...list, c].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))));
        setCategoryId(c.id);
        setNewCategory('');
        setNotice(existed ? `있던 분류 "${c.name}"을(를) 골랐다 — 저장을 누르면 붙는다.` : `분류 "${c.name}"을(를) 만들어 골랐다 — 저장을 누르면 붙는다.`);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        creating.current = false;
        setBusy(false);
      });
  };

  const changeStatus = async (status: 'active' | 'suspended') => {
    // 다시 쓰기는 묻지 않는다 — 되돌리는 쪽이다
    if (status === 'suspended' && !(await confirm(suspendConfirm(space.name)))) return;
    await run(
      'status',
      () => api(`/api/spaces/${space.id}/status`, { method: 'PATCH', json: { status } }),
      status === 'suspended' ? '중지했다 — 읽기만 된다.' : '다시 쓸 수 있게 했다.',
    );
  };

  // 주인이 건 중지를 관리자가 건 중지로 — 같은 상태를 다시 보내면 서버가 넘겨받는다 (P15 A.1-12)
  const takeOver = async () => {
    if (!(await confirm(takeoverConfirm(space.name)))) return;
    // 화면이 본 상태(주인이 건 중지)를 싣는다 — 그 사이 주인이 풀었으면 서버가 새 중지로 만들지 않고 409다(좁은 재검토 12)
    await run('status', () => api(`/api/spaces/${space.id}/status`, { method: 'PATCH', json: { status: 'suspended', takeover: true } }), '관리자가 건 중지로 바꿨다.');
  };

  const remove = async () => {
    if (!(await confirm(deleteSpaceConfirm(space.name)))) return;
    setArea('status');
    setError(null);
    setNotice(null);
    try {
      await api(`/api/spaces/${space.id}`, { method: 'DELETE' });
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      onChanged();
    }
  };

  // 결과와 거절은 조치한 구획 안에 보인다. 그 구획이 사라졌으면(그 사이 권한이 바뀌었다) 구역 맨 위에 — 까닭이 구획과 함께 사라지면 안 된다
  const shown: Record<Area, boolean> = { info: canEditInfo, category: canEditInfo, status: true };
  const results = (at: Area | 'top') =>
    (at === 'top' ? !shown[area] : at === area) ? (
      <>
        {error && <Notice kind="error">{error}</Notice>}
        {notice && <Notice kind="success">{notice}</Notice>}
      </>
    ) : null;
  const anyStatusButton = canChangeStatus || canDelete;

  return (
    <section aria-label="스페이스 관리">
      {results('top')}
      {!active && (
        <Notice kind="warning">
          {space.suspendedByOwner ? '주인이 중지한 스페이스다.' : '관리자가 중지한 스페이스다.'}
          {!canChangeStatus && isOwner && (
            <>
              {' '}
              주인도 다시 쓰기로 풀지 못한다 — 관리자에게 부탁하거나, 관리자에게 <strong>관리자가 건 중지 풀기</strong>를 받는다.
            </>
          )}
        </Notice>
      )}
      {canEditInfo && (
        <>
          <FormSection title="스페이스 정보" as="div">
            {results('info')}
            <form onSubmit={save}>
              <FormRows>
                <FormRow id="sp-name" label="이름" required>
                  <input id="sp-name" className="w-m" value={name} onChange={(e) => setName(e.target.value)} disabled={!active} />
                </FormRow>
                <FormRow id="sp-desc" label="설명" top>
                  <textarea id="sp-desc" className="w-full" value={description} onChange={(e) => setDescription(e.target.value)} disabled={!active} />
                </FormRow>
                <FormRow id="sp-cat" label="분류">
                  <select id="sp-cat" className="w-m" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={!active}>
                    <option value="">분류 없음</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </FormRow>
                {active && (
                  // 칸과 단추가 한 줄이다 — 도움말은 칸에 직접 잇는다(`FormRow`는 자식 하나에만 잇는다)
                  <FormRow id="sp-cat-new" label="새 분류" help="만든 분류가 위 칸에 골라진다 — 저장을 눌러야 이 스페이스에 붙는다.">
                    <div className="inline">
                      <input
                        id="sp-cat-new"
                        className="w-m"
                        aria-describedby="sp-cat-new-help"
                        value={newCategory}
                        maxLength={CATEGORY_NAME_MAX}
                        onChange={(e) => setNewCategory(e.target.value)}
                        onKeyDown={(e) => {
                          // 이 칸의 Enter는 저장이 아니라 만들기다 — 저장하지 않은 이름·설명과 따로 논다
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addCategory();
                          }
                        }}
                      />
                      <button type="button" onClick={addCategory} disabled={busy || !newCategory.trim()}>
                        분류 만들기
                      </button>
                    </div>
                  </FormRow>
                )}
              </FormRows>
              <FormActions>
                <button type="submit" className="primary" disabled={!active}>
                  저장
                </button>
                {/* 누를 수 없는 까닭은 단추 옆에 글로도 보인다 (J.5.2) */}
                {!active && (
                  <span className="muted small">
                    {canChangeStatus
                      ? '중지된 스페이스는 이름·설명·분류를 바꿀 수 없다. 먼저 다시 쓸 수 있게 한다.'
                      : '중지된 스페이스는 이름·설명·분류를 바꿀 수 없다. 관리자가 다시 쓰게 하면 바꿀 수 있다.'}
                  </span>
                )}
              </FormActions>
            </form>
          </FormSection>
          <FormSection title="분류 관리" as="div">
            {results('category')}
            <CategoryList
              categories={categories.filter((c) => c.createdBy === meId)}
              editableOnly
              onNotice={(t) => {
                setArea('category');
                setNotice(t);
              }}
              onError={(t) => {
                setArea('category');
                setError(t);
              }}
              emptyText="내가 만들어 이름을 바꾸거나 지울 수 있는 분류가 없다 — 남의 공간이 쓰는 분류는 관리자가 바꾼다."
              onChanged={() => {
                loadCategories();
                onChanged();
              }}
            />
          </FormSection>
        </>
      )}
      {/* 위험 구역 (J.5.6) — 테두리가 위험 선이다. 다시 쓰기도 여기 있다 — 상태를 바꾸는 단추를 한곳에 모은다 */}
      <FormSection title="위험 구역" as="div" className="card danger-zone">
        {results('status')}
        {anyStatusButton && (
          <div className="actions">
            {canChangeStatus &&
              (active ? (
                <button type="button" className="danger" onClick={() => void changeStatus('suspended')}>
                  중지
                </button>
              ) : (
                <button type="button" onClick={() => void changeStatus('active')}>
                  다시 쓰기
                </button>
              ))}
            {canTakeOver(space) && (
              <button type="button" className="danger" onClick={() => void takeOver()}>
                관리자가 건 중지로 바꾸기
              </button>
            )}
            {canDelete && (
              <button type="button" className="danger" onClick={() => void remove()}>
                지우기
              </button>
            )}
          </div>
        )}
        {!canDelete && (
          <p className="muted small">지우기는 활성 스페이스에서 Crew가 본인뿐인 주인, 또는 중지된 스페이스에서 관리자(와 스페이스 관리 전체를 받은 사람)가 할 수 있다.</p>
        )}
      </FormSection>
      {dialog}
    </section>
  );
}
