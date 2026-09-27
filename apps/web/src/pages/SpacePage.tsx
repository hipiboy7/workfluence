import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ASSIGNABLE_MEMBER_ROLES, type PageTemplateView, type PageSummary, type SpaceMemberView, type SpaceView } from '@workfluence/shared';
import { api } from '../api';
import { EMPTY_DOC } from '../components/Editor';
import { flattenTree, indentedTitle } from '../components/pageTree';
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
  const [space, setSpace] = useState<SpaceView | null>(null);
  const [tree, setTree] = useState<PageSummary[]>([]);
  const [crew, setCrew] = useState<SpaceMemberView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [parentId, setParentId] = useState(search.get('parent') ?? '');
  const [templates, setTemplates] = useState<PageTemplateView[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [username, setUsername] = useState('');
  const [addRole, setAddRole] = useState<MemberRole>('editor');
  const titleBox = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setError(null);
    api<SpaceView>(`/api/spaces/${id}`)
      .then(async (s) => {
        setSpace(s);
        setTree(await api<PageSummary[]>(`/api/pages?spaceId=${id}`));
        if (s.kind === 'team') setCrew(await api<SpaceMemberView[]>(`/api/spaces/${id}/members`));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    // 목록이 없어도 페이지는 만들 수 있어야 한다. 실패를 화면 오류로 올리지 않는다
    api<PageTemplateView[]>('/api/templates')
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, []);
  // 하위 페이지 만들기로 왔으면 그 부모를 골라 두고 제목 칸으로 간다 (FR-1500). 스페이스를 읽은 뒤에야 칸이 있다
  const wanted = search.get('parent');
  useEffect(() => {
    if (!wanted) return;
    setParentId(wanted);
    titleBox.current?.focus();
  }, [wanted, space]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
        json: { spaceId: id, parentId: parentId || null, title, content: picked?.content ?? EMPTY_DOC },
      });
      setTitle('');
      nav(`/pages/${p.id}/edit`);
    });
  };

  if (error && !space) return <main className="shell"><p className="badge fail" role="alert">{error}</p><Link to="/">← 목록</Link></main>;
  if (!space) return <main className="shell"><p className="muted">불러오는 중…</p></main>;

  // 부모 → 자식 순서로 펼친다(`pageTree`) — 위치 고르기와 옮기기 칸도 같은 것을 쓴다. 깊이는 서버가 10으로 제한한다
  const rows = flattenTree(tree);

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
        <ul aria-label="페이지 트리">
          {rows.map((p) => (
            <li key={p.id} style={{ marginLeft: p.depth * 16 }}>
              <Link to={`/pages/${p.id}`}>{p.title}</Link> <span className="muted small">v{p.currentVersionNo}</span>
            </li>
          ))}
        </ul>
        {tree.length === 0 && <p className="muted">아직 페이지가 없다.</p>}
        {space.access.canWrite && (
          <form onSubmit={addPage} id="new-page">
            <label htmlFor="pg-title">새 페이지 제목</label>
            <input id="pg-title" ref={titleBox} value={title} onChange={(e) => setTitle(e.target.value)} required />
            <label htmlFor="pg-parent">위치</label>
            <select id="pg-parent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
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

      <SpaceManage space={space} onChanged={load} onDeleted={() => nav('/')} />
    </main>
  );
}
