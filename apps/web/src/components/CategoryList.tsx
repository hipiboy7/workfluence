import { useState } from 'react';
import type { CategoryView } from '@workfluence/shared';
import { api } from '../api';

/** 지우기를 묻는 말 — 쓰던 공간(휴지통 포함)이 몇 개 "분류 없음"이 되는지 말한다 (P15 FR-1624) */
export function confirmDeleteCategoryText(c: CategoryView): string {
  // 쓰임은 지울 수 있는 사람에게 늘 온다 — 없으면(서버가 싣지 않았다) 개수를 말하지 않는다
  const n = c.usage?.spaces ?? 0;
  const cleared = n > 0 ? ` 이 분류를 쓰는 공간 ${n}개(휴지통 포함)가 "분류 없음"이 된다.` : '';
  return `분류 "${c.name}"을(를) 지운다.${cleared} 되살릴 수 없다 — 어느 공간이었는지는 감사로그에 남는다.`;
}

/**
 * 분류의 **이름 바꾸기·지우기** (P15_설계서_Grants D.5, FR-1621~1624) — 관리 콘솔의 스페이스 관리와 공간의 관리 칸이 같이 쓴다(같은 말을 두 곳에
 * 적으면 한쪽만 바뀐다). 줄마다 할 수 있는지는 응답의 `access`다(`categoryAccess`) — 화면은 규칙을 다시 만들지 않는다. 할 수 없는 단추는 까닭을
 * `title`로 보인다(`meId`가 있으면 만든 사람인지 가려 말한다). `editableOnly`면 할 수 있는 줄만 보인다(공간의 관리 칸 — 남의 분류를 늘어놓지 않는다).
 *
 * 바꾸거나 지운 뒤 `onChanged`를 부른다 — 부르는 쪽이 분류와 스페이스를 다시 읽는다(지운 분류를 쓰던 공간은 분류 없음이 된다). 알림과 거절의 까닭은
 * 부르는 쪽의 알림 칸에 싣는다(`onNotice`·`onError`) — 칸이 둘이면 어느 것이 방금의 결과인지 헷갈린다
 */
export function CategoryList({
  categories,
  onChanged,
  editableOnly = false,
  emptyText = '분류가 없다.',
  meId,
  onNotice,
  onError,
}: {
  categories: CategoryView[];
  onChanged: () => void;
  onNotice: (text: string | null) => void;
  onError: (text: string | null) => void;
  editableOnly?: boolean;
  emptyText?: string;
  meId?: string;
}) {
  const [renaming, setRenaming] = useState<Record<string, string>>({});
  const shown = editableOnly ? categories.filter((c) => c.access.canRename || c.access.canDelete) : categories;

  // 할 수 없는 까닭 — 만든 사람이면 남의 공간이 써서, 아니면 만든 사람이 아니어서다(서버의 거절과 같은 말)
  const why = (c: CategoryView) =>
    meId !== undefined && c.createdBy === meId
      ? "남의 공간이 쓰는 분류는 관리자나 '분류 관리'를 받은 사람이 바꾸고 지운다"
      : '분류는 만든 사람과 관리자가 바꾸고 지운다';

  const act = async (fn: () => Promise<unknown>, done: string, after?: () => void) => {
    onError(null);
    onNotice(null);
    try {
      await fn();
      onNotice(done);
      after?.();
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const rename = (c: CategoryView) => {
    const name = (renaming[c.id] ?? c.name).trim();
    if (!name || name === c.name) return;
    void act(() => api(`/api/categories/${c.id}`, { method: 'PATCH', json: { name } }), `분류 이름을 "${name}"(으)로 바꿨다.`, () =>
      setRenaming((r) => {
        const next = { ...r };
        delete next[c.id];
        return next;
      }),
    );
  };

  const remove = (c: CategoryView) => {
    if (!window.confirm(confirmDeleteCategoryText(c))) return;
    void act(
      () => api(`/api/categories/${c.id}`, { method: 'DELETE' }),
      (c.usage?.spaces ?? 0) > 0 ? `분류 "${c.name}"을(를) 지웠다 — 쓰던 공간 ${c.usage?.spaces}개는 분류 없음이 됐다.` : `분류 "${c.name}"을(를) 지웠다.`,
    );
  };

  return (
    <div>
      {shown.length === 0 ? (
        <p className="muted small">{emptyText}</p>
      ) : (
        <ul aria-label="분류 목록">
          {shown.map((c) => {
            const value = renaming[c.id] ?? c.name;
            return (
              <li key={c.id}>
                <input
                  aria-label={`분류 ${c.name} 이름`}
                  value={value}
                  disabled={!c.access.canRename}
                  onChange={(e) => setRenaming((r) => ({ ...r, [c.id]: e.target.value }))}
                />{' '}
                <button
                  type="button"
                  onClick={() => rename(c)}
                  disabled={!c.access.canRename || value.trim() === c.name}
                  title={c.access.canRename ? undefined : why(c)}
                >
                  이름 바꾸기
                </button>{' '}
                <button type="button" onClick={() => remove(c)} disabled={!c.access.canDelete} title={c.access.canDelete ? undefined : why(c)}>
                  지우기
                </button>{' '}
                {/* 쓰임은 바꿀 수 있는 사람과 만든 사람에게만 온다 (P15 병합 전 검토) */}
                {c.usage && (
                  <span className="muted small">
                    공간 {c.usage.spaces}개{c.usage.otherSpaces > 0 ? ` (만든 사람의 것이 아닌 공간 ${c.usage.otherSpaces}개)` : ''}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
