import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ASSIGNABLE_MEMBER_ROLES, type PageTemplateView, type PageSummary, type SpaceMemberView, type SpaceView } from '@workfluence/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { EMPTY_DOC } from '../components/Editor';
import { flattenTree, indentedTitle, type TreeRow } from '../components/pageTree';
import { SpaceManage } from '../components/SpaceManage';

type MemberRole = (typeof ASSIGNABLE_MEMBER_ROLES)[number];

/** Crew 역할의 이름 */
const ROLE_LABELS: Record<SpaceMemberView['role'], string> = { owner: 'owner', editor: 'editor (쓰기)', viewer: 'viewer (읽기만)' };

/**
 * 스페이스 화면 (FR-341): 페이지 트리 + Crew 패널.
 *
 * - **하위 페이지** (P14 FR-1500) — 새 페이지 칸의 **위치**로 부모를 고른다. 주소의 `?parent=<페이지>`(페이지 보기의 하위 페이지 만들기)가 있으면
 *   그것을 골라 두고 제목 칸으로 간다
 * - **관리** (P14 FR-1510·1511) — 이름·설명·분류, 중지·다시 쓰기, 지우기(`SpaceManage`)
 * - **Crew의 역할** (P14 FR-1512) — 넣을 때 고르고, 넣은 뒤 바꾼다. owner는 바꾸지 않는다
 */
export function SpacePage() {
  const { id = '' } = useParams();
  const [search] = useSearchParams();
  const nav = useNavigate();
  const { me } = useAuth();
  const [space, setSpace] = useState<SpaceView | null>(null);
  const [tree, setTree] = useState<PageSummary[]>([]);
  const [crew, setCrew] = useState<SpaceMemberView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  // 빈 값이 맨 위다. 주소의 `?parent=`는 트리를 읽은 뒤 그 스페이스에 있을 때만 받는다(아래)
  const [parentId, setParentId] = useState('');
  const [templates, setTemplates] = useState<PageTemplateView[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [username, setUsername] = useState('');
  const [addRole, setAddRole] = useState<MemberRole>('editor');
  const titleBox = useRef<HTMLInputElement>(null);
  // 늦게 온 옛 응답이 새 읽기를 덮지 않게 — 역할을 연달아 바꾸면 응답 순서가 뒤바뀐다 (병합 전 자체 점검 13)
  const seq = useRef(0);

  // `keepError` — 거절된 뒤 다시 읽을 때는 그 까닭을 지우지 않는다(아래 `act`)
  const load = useCallback((keepError = false) => {
    if (!keepError) setError(null);
    const mine = ++seq.current;
    api<SpaceView>(`/api/spaces/${id}`)
      .then(async (s) => {
        const pages = await api<PageSummary[]>(`/api/pages?spaceId=${id}`);
        const members = s.kind === 'team' ? await api<SpaceMemberView[]>(`/api/spaces/${id}/members`) : [];
        if (mine !== seq.current) return;
        setSpace(s);
        setTree(pages);
        setCrew(members);
      })
      .catch((e: unknown) => {
        if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
      });
  }, [id]);
  useEffect(() => load(), [load]);
  useEffect(() => {
    // 목록이 없어도 페이지는 만들 수 있어야 한다. 실패를 화면 오류로 올리지 않는다
    api<PageTemplateView[]>('/api/templates')
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, []);
  // 부모 → 자식 순서로 펼친다(`pageTree`) — 위치 고르기와 옮기기 칸도 같은 것을 쓴다. 깊이는 서버가 10으로 제한한다
  const rows = useMemo(() => flattenTree(tree), [tree]);
  // 줄마다 그 아래 줄 — 트리를 목록 안의 목록으로 그린다(아래). 제목을 칠 때마다 다시 그리므로 미리 묶어 둔다
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

  // 하위 페이지 만들기로 왔으면 그 부모를 골라 두고 제목 칸으로 간다 (FR-1500). **그 값이 바뀔 때 한 번만** — 다시 읽을 때마다(Crew·관리 칸 뒤)
  // 되돌리면 사람이 바꾼 위치가 원래 부모로 돌아가 엉뚱한 곳에 만들어졌다. **이 스페이스의 트리에 있을 때만** — 없는 id(지워졌거나 다른 스페이스)를
  // 받으면 칸은 "맨 위"를 보이면서 그 id를 보냈다 (병합 전 검토)
  const wanted = search.get('parent');
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!wanted || applied.current === wanted || !tree.some((p) => p.id === wanted)) return;
    applied.current = wanted;
    setParentId(wanted);
    titleBox.current?.focus();
  }, [wanted, tree]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // **거절되면 지금 상태를 다시 읽는다** — 화면을 연 사이 관리자가 중지했으면 옛 화면이 넣기 칸을 계속 보여 같은 403을 되풀이했다(P16 병합 전
      // 검토). 관리 칸(`SpaceManage`)과 같은 원칙이다(P15)
      load(true);
    }
  };

  const addPage = async (e: FormEvent) => {
    e.preventDefault();
    await act(async () => {
      // **템플릿을 고르면 그 내용으로 시작한다** (FR-741). 안 고르면 지금처럼 빈 문서다 —
      // 기존 흐름을 깨지 않는 것이 이 기능의 조건이었다
      const picked = templates.find((t) => t.id === templateId);
      const p = await api<PageSummary>('/api/pages', {
        method: 'POST',
        json: { spaceId: id, parentId: parentValue || null, title, content: picked?.content ?? EMPTY_DOC },
      });
      setTitle('');
      nav(`/pages/${p.id}/edit`);
    });
  };

  if (error && !space) return <main className="shell"><p className="badge fail" role="alert">{error}</p><Link to="/">← 목록</Link></main>;
  if (!space) return <main className="shell"><p className="muted">불러오는 중…</p></main>;

  // 고른 부모가 다시 읽은 트리에 없으면(그 사이 지워졌다) 맨 위로 보이고 맨 위로 보낸다 — 보이는 것과 보내는 것이 같아야 한다
  const parentValue = rows.some((r) => r.id === parentId) ? parentId : '';
  // **트리는 목록 안의 목록이다** — 들여쓰기를 여백으로만 그리면 화면 낭독기가 단계를 읽지 못한다 (병합 전 코드 리뷰 13). 안쪽 목록의 기본 들여쓰기
  // (브라우저의 40px)는 없앤다 — 줄의 16px에 더해져 단계마다 56px가 되면 깊은 페이지가 칸 밖으로 밀렸다(반영분 점검 3)
  const branch = (items: readonly TreeRow[]): ReactNode =>
    items.map((p) => {
      const kids = kidsOf.get(p.id) ?? [];
      return (
        <li key={p.id} style={{ marginLeft: p.depth > 0 ? 16 : 0 }}>
          <Link to={`/pages/${p.id}`}>{p.title}</Link> <span className="muted small">v{p.currentVersionNo}</span>
          {kids.length > 0 && <ul style={{ paddingLeft: 0 }}>{branch(kids)}</ul>}
        </li>
      );
    });

  return (
    <main className="shell">
      <p className="muted small"><Link to="/">← 스페이스 목록</Link></p>
      <h1>{space.name}</h1>
      <p className="muted small">
        {space.kind === 'personal' ? '개인' : '팀'} · {space.key}
        {space.categoryName && <> · {space.categoryName}</>}
        {space.status !== 'active' && <span className="badge fail"> 중지됨 — 읽기만 된다</span>}
      </p>
      {space.description && <p>{space.description}</p>}
      {error && <p className="badge fail" role="alert">{error}</p>}

      <section className="card">
        <h2>페이지</h2>
        <ul aria-label="페이지 트리">{branch(rows.filter((r) => r.depth === 0))}</ul>
        {tree.length === 0 && <p className="muted">아직 페이지가 없다.</p>}
        {space.access.canWrite && (
          <form onSubmit={addPage} id="new-page">
            <label htmlFor="pg-title">새 페이지 제목</label>
            <input id="pg-title" ref={titleBox} value={title} onChange={(e) => setTitle(e.target.value)} required />
            <label htmlFor="pg-parent">위치</label>
            <select id="pg-parent" value={parentValue} onChange={(e) => setParentId(e.target.value)}>
              <option value="">맨 위</option>
              {rows.map((r) => (
                <option key={r.id} value={r.id}>
                  {indentedTitle(r)} 아래
                </option>
              ))}
            </select>
            {templates.length > 0 && (
              <>
                <label htmlFor="pg-template">템플릿</label>
                <select id="pg-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                  <option value="">빈 문서로 시작</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.description ? ` — ${t.description}` : ''}
                    </option>
                  ))}
                </select>
              </>
            )}
            <button type="submit">만들기</button>
          </form>
        )}
      </section>

      {space.kind === 'team' && (
        <section className="card">
          <h2>Crew</h2>
          <ul>
            {crew.map((m) => (
              <li key={m.userId}>
                {m.displayName} <span className="muted small">({m.username})</span> —{' '}
                {space.access.canManageMembers && m.role !== 'owner' ? (
                  <select
                    aria-label={`${m.username} 역할`}
                    value={m.role}
                    onChange={(e) =>
                      void act(() => api(`/api/spaces/${id}/members/${m.userId}`, { method: 'PATCH', json: { role: e.target.value as MemberRole } }))
                    }
                  >
                    {ASSIGNABLE_MEMBER_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  ROLE_LABELS[m.role]
                )}
                {space.access.canManageMembers && m.role !== 'owner' && (
                  <>
                    {' '}
                    <button type="button" onClick={() => void act(() => api(`/api/spaces/${id}/members/${m.userId}`, { method: 'DELETE' }))}>
                      제거
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {/* 관리자가 건 중지 동안 Crew는 관리자만 바꾼다 — 단추만 사라지면 권한을 잃은 줄 안다 (P16 FR-1702). 얼었는지는 판정이 말한다(`crewFrozen`).
              스스로 풀 수 있는 주인(관리자가 건 중지 풀기·스페이스 관리 전체를 받았다)에게는 관리자에게 부탁하라고 하지 않는다 */}
          {space.access.crewFrozen && (
            <p className="muted small">
              {space.access.canChangeStatus
                ? '관리자가 중지한 스페이스라 Crew를 바꾸지 못한다 — 아래 관리 칸의 다시 쓰기로 먼저 풀면 바꾼다.'
                : '관리자가 중지한 스페이스라 Crew를 바꾸지 못한다 — 관리자에게 부탁한다. 다시 쓰게 되면 주인도 바꾼다.'}
            </p>
          )}
          {space.access.canManageMembers && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await api(`/api/spaces/${id}/members`, { method: 'POST', json: { username, role: addRole } });
                  setUsername('');
                });
              }}
            >
              <label htmlFor="crew-user">아이디로 Crew 추가</label>
              <input id="crew-user" value={username} onChange={(e) => setUsername(e.target.value)} required />
              <label htmlFor="crew-role">역할</label>
              <select id="crew-role" value={addRole} onChange={(e) => setAddRole(e.target.value as MemberRole)}>
                {ASSIGNABLE_MEMBER_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
              <button type="submit">추가</button>
            </form>
          )}
        </section>
      )}

      <SpaceManage space={space} meId={me?.id} onChanged={load} onDeleted={() => nav('/')} />
    </main>
  );
}
