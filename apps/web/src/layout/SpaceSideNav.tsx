import type { PageSummary, SpaceView } from '@workfluence/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { api } from '../api';
import { ChevronIcon, PlusIcon } from '../components/icons';
import { flattenTree, type TreeRow } from '../components/pageTree';

/** 트리를 바꾼 화면이 이 이름으로 알린다 — 왼쪽 칸이 그 스페이스의 트리를 다시 받는다(만들기·옮기기·지우기·되살리기 뒤) */
export const TREE_CHANGED = 'wf:tree-changed';
export const announceTreeChanged = (spaceId: string) => window.dispatchEvent(new CustomEvent(TREE_CHANGED, { detail: spaceId }));

type Entry = { space: SpaceView; pages: PageSummary[] };
/** 스페이스 안의 화면 사이에 들고 있는 트리 — 옮길 때마다 비었다가 다시 그려지지 않게 먼저 보이고 뒤에서 새로 받는다 (J.5.11) */
const cache = new Map<string, Entry>();

/**
 * 스페이스 문맥의 왼쪽 칸 (P17 설계서 J.3.3·J.5.11, FR-1853) — 스페이스 이름과 "팀 · 키 · Crew N"(글 — 링크도 제목도 아니다), 스페이스 첫 화면,
 * 새 페이지(쓸 수 있을 때만), 페이지 트리. 화면이 이미 읽은 스페이스와 트리를 넘기면 다시 부르지 않는다
 */
export function SpaceSideNav({ spaceId, currentPageId, space, pages }: { spaceId: string; currentPageId?: string; space?: SpaceView | null; pages?: PageSummary[] | null }) {
  const given = space && pages ? { space, pages } : null;
  const [entry, setEntry] = useState<Entry | null>(given ?? cache.get(spaceId) ?? null);
  // 스스로 부른 것이 실패했다 — 들고 있는 트리가 없으면 "불러오는 중"에 머물지 않고 그렇게 말한다(P17 병합 전 검토 5, FR-1861)
  const [failed, setFailed] = useState(false);
  // **다시 읽기**를 누른 횟수 — 바뀌면 다시 부른다
  const [attempt, setAttempt] = useState(0);
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (given) {
      cache.set(spaceId, given);
      setEntry(given);
      setFailed(false);
      return;
    }
    let alive = true;
    const load = () =>
      Promise.all([api<SpaceView>(`/api/spaces/${spaceId}`), api<PageSummary[]>(`/api/pages?spaceId=${spaceId}`)])
        .then(([s, p]) => {
          if (!alive) return;
          const e = { space: s, pages: p };
          cache.set(spaceId, e);
          setEntry(e);
          setFailed(false);
        })
        // 들고 있던 트리가 있으면 그것을 그대로 보인다 — 다음 알림(TREE_CHANGED)이나 다시 읽기가 다시 부른다
        .catch(() => {
          if (alive) setFailed(true);
        });
    setEntry(cache.get(spaceId) ?? null);
    setFailed(false);
    void load();
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<string>).detail === spaceId) void load();
    };
    window.addEventListener(TREE_CHANGED, onChanged);
    return () => {
      alive = false;
      window.removeEventListener(TREE_CHANGED, onChanged);
    };
    // 넘겨받은 값이 바뀌면(화면이 다시 읽었다) 그것을 쓴다
  }, [spaceId, given?.space, given?.pages, attempt]);

  if (!entry) {
    if (!failed) return <p className="loading">불러오는 중…</p>;
    return (
      <div className="side-group">
        <p className="side-meta">트리를 읽지 못했다.</p>
        <button type="button" className="sm" onClick={() => setAttempt((n) => n + 1)}>
          다시 읽기
        </button>
      </div>
    );
  }
  const s = entry.space;
  const home = pathname === `/spaces/${spaceId}` && hash !== '#new-page';
  return (
    <>
      <nav className="side-group" aria-label="스페이스 메뉴">
        <p className="side-title">{s.name}</p>
        <p className="side-meta">
          {s.kind === 'personal' ? '개인' : '팀'} · {s.key}
          {s.kind === 'team' && <> · Crew {s.memberCount}</>}
        </p>
        <ul>
          <li>
            <Link className="side-item" to={`/spaces/${spaceId}`} aria-current={home ? 'page' : undefined}>
              스페이스 첫 화면
            </Link>
          </li>
          {s.access.canWrite && (
            <li>
              <Link className="side-item" to={`/spaces/${spaceId}#new-page`}>
                <PlusIcon /> 새 페이지
              </Link>
            </li>
          )}
        </ul>
      </nav>
      <PageTree pages={entry.pages} currentId={currentPageId} />
    </>
  );
}

/**
 * 페이지 트리 (J.5.11) — `ul` "페이지 트리", 단계마다 `li`의 왼쪽 여백 16px(인라인 — 시험이 단언한다). 줄은 [24px 펼치기 단추 또는 같은 폭의 빈 자리] +
 * 제목 링크라 줄 글이 제목으로 시작하고 첫 링크가 제목이다. 펼치기 단추는 글이 없고 이름과 `aria-expanded`만 둔다. **처음에는 모두 펼친다** —
 * 접은 줄 아래는 보이지 않아 찾을 수 없다. 지금 페이지는 `aria-current="page"`이고 보이도록 스크롤한다
 */
export function PageTree({ pages, currentId }: { pages: readonly PageSummary[]; currentId?: string }) {
  const rows = useMemo(() => flattenTree(pages), [pages]);
  const kidsOf = useMemo(() => {
    const m = new Map<string, TreeRow[]>();
    for (const r of rows) {
      // 깊이 0은 맨 위 단계다 — 부모를 잃은 가지도 여기서 시작한다(`flattenTree`)
      if (r.depth === 0 || r.parentId === null) continue;
      const list = m.get(r.parentId);
      if (list) list.push(r);
      else m.set(r.parentId, [r]);
    }
    return m;
  }, [rows]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const currentRef = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [currentId, rows.length]);

  if (rows.length === 0) return <p className="side-meta">아직 페이지가 없다.</p>;
  const toggle = (id: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // **트리는 목록 안의 목록이다** — 들여쓰기를 여백으로만 그리면 화면 낭독기가 단계를 읽지 못한다(P14 병합 전 코드 리뷰 13). 안쪽 목록의
  // 기본 들여쓰기(브라우저의 40px)는 없앤다 — 줄의 16px에 더해지면 깊은 페이지가 칸 밖으로 밀린다
  const branch = (items: readonly TreeRow[]): ReactNode =>
    items.map((p) => {
      const kids = kidsOf.get(p.id) ?? [];
      const open = !closed.has(p.id);
      const current = p.id === currentId;
      return (
        <li key={p.id} style={{ marginLeft: p.depth > 0 ? 16 : 0 }}>
          <div className="tree-row">
            {kids.length > 0 ? (
              <button type="button" className="tree-toggle" aria-label={`${p.title} ${open ? '접기' : '펼치기'}`} aria-expanded={open} onClick={() => toggle(p.id)}>
                <ChevronIcon open={open} />
              </button>
            ) : (
              <span className="tree-spacer" aria-hidden="true" />
            )}
            <Link to={`/pages/${p.id}`} aria-current={current ? 'page' : undefined} ref={current ? currentRef : undefined}>
              {p.title}
            </Link>
            <span className="tree-version">v{p.currentVersionNo}</span>
          </div>
          {kids.length > 0 && open && <ul style={{ paddingLeft: 0 }}>{branch(kids)}</ul>}
        </li>
      );
    });
  return (
    <ul className="tree" aria-label="페이지 트리">
      {branch(rows.filter((r) => r.depth === 0))}
    </ul>
  );
}
