import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ASSIGNABLE_MEMBER_ROLES, type PageTemplateView, type PageSummary, type SpaceMemberView, type SpaceView } from '@workfluence/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { useConfirm } from '../components/ConfirmDialog';
import { EMPTY_DOC } from '../components/Editor';
import { flattenTree, indentedTitle } from '../components/pageTree';
import { SpaceManage } from '../components/SpaceManage';
import { Field, FormActions, FormRow, FormRows, FormSection, Loading, Notice, Page, PageHeader, StatusBadge } from '../components/ui';
import { SideSlot } from '../layout/AppLayout';
import { SpaceSideNav, announceTreeChanged } from '../layout/SpaceSideNav';

type MemberRole = (typeof ASSIGNABLE_MEMBER_ROLES)[number];

/** Crew 역할의 이름 */
const ROLE_LABELS: Record<SpaceMemberView['role'], string> = { owner: 'owner', editor: 'editor (쓰기)', viewer: 'viewer (읽기만)' };

/** 오류를 보일 자리 — 조치한 구획 바로 위다(P17 J.5.7). 읽기 실패는 머리 아래 */
type ErrorAt = 'top' | 'page' | 'crew';

/**
 * 스페이스 첫 화면 (FR-341 · P17 설계서 J.6 스페이스 문맥): 새 페이지 + Crew + 관리.
 *
 * - **페이지 트리는 왼쪽 칸에 있다**(J.3.3·J.5.11) — 본문에 두지 않는다. 이 화면이 이미 읽은 스페이스와 트리를 넘긴다(`SpaceSideNav`) — 왼쪽 칸이
 *   같은 것을 다시 부르지 않는다. 틀 없이 그린 컴포넌트 시험에서는 제자리에 그려진다(`SideSlot`)
 * - **하위 페이지** (P14 FR-1500) — 새 페이지 칸의 **위치**로 부모를 고른다. 주소의 `?parent=<페이지>`(페이지 보기의 하위 페이지 만들기)가 있으면
 *   그것을 골라 두고 제목 칸으로 간다. 왼쪽 칸의 **새 페이지**(`#new-page`)로 와도 제목 칸으로 간다
 * - **관리** (P14 FR-1510·1511) — 이름·설명·분류, 중지·다시 쓰기, 지우기(`SpaceManage`)
 * - **Crew의 역할** (P14 FR-1512) — 넣을 때 고르고, 넣은 뒤 바꾼다. owner는 바꾸지 않는다. 빼기는 한 번 더 묻는다(J.5.10)
 */
export function SpacePage() {
  const { id = '' } = useParams();
  const [search] = useSearchParams();
  const location = useLocation();
  const nav = useNavigate();
  const { me } = useAuth();
  const [confirm, dialog] = useConfirm();
  const [space, setSpace] = useState<SpaceView | null>(null);
  const [tree, setTree] = useState<PageSummary[]>([]);
  const [crew, setCrew] = useState<SpaceMemberView[]>([]);
  const [error, setError] = useState<{ at: ErrorAt; text: string } | null>(null);
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
        if (mine === seq.current) setError({ at: 'top', text: e instanceof Error ? e.message : String(e) });
      });
  }, [id]);
  useEffect(() => load(), [load]);
  useEffect(() => {
    // 목록이 없어도 페이지는 만들 수 있어야 한다. 실패를 화면 오류로 올리지 않는다
    api<PageTemplateView[]>('/api/templates')
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, []);
  // 부모 → 자식 순서로 펼친다(`pageTree`) — 왼쪽 칸의 트리와 옮기기 칸도 같은 것을 쓴다. 깊이는 서버가 10으로 제한한다
  const rows = useMemo(() => flattenTree(tree), [tree]);

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

  // 왼쪽 칸의 **새 페이지**(`#new-page`)로 오면 제목 칸으로 간다 — 주소의 뒤만 바뀌면 브라우저는 스크롤하지 않아 눌러도 아무 일이 없어 보였다.
  // **그 이동에 한 번만** — 다시 읽을 때마다(Crew를 바꾼 뒤) 초점을 빼앗지 않는다
  const canWrite = space?.access.canWrite ?? false;
  const focusedFor = useRef<string | null>(null);
  useEffect(() => {
    if (location.hash !== '#new-page' || !canWrite || focusedFor.current === location.key) return;
    focusedFor.current = location.key;
    titleBox.current?.focus();
  }, [location.hash, location.key, canWrite]);

  const act = async (at: ErrorAt, fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError({ at, text: e instanceof Error ? e.message : String(e) });
      // **거절되면 지금 상태를 다시 읽는다** — 화면을 연 사이 관리자가 중지했으면 옛 화면이 넣기 칸을 계속 보여 같은 403을 되풀이했다(P16 병합 전
      // 검토). 관리 칸(`SpaceManage`)과 같은 원칙이다(P15)
      load(true);
    }
  };

  const addPage = async (e: FormEvent) => {
    e.preventDefault();
    await act('page', async () => {
      // **템플릿을 고르면 그 내용으로 시작한다** (FR-741). 안 고르면 지금처럼 빈 문서다 —
      // 기존 흐름을 깨지 않는 것이 이 기능의 조건이었다
      const picked = templates.find((t) => t.id === templateId);
      const p = await api<PageSummary>('/api/pages', {
        method: 'POST',
        json: { spaceId: id, parentId: parentValue || null, title, content: picked?.content ?? EMPTY_DOC },
      });
      setTitle('');
      // 트리가 바뀌었다 — 이 스페이스의 트리를 들고 있는 왼쪽 칸이 다시 받는다 (J.5.11)
      announceTreeChanged(id);
      nav(`/pages/${p.id}/edit`);
    });
  };

  // Crew에서 빼기는 한 번 더 묻는다 — 잘못 누르면 그 사람의 화면이 곧바로 막힌다(J.5.10). 다시 넣으면 돌아온다
  const removeMember = async (m: SpaceMemberView) => {
    const ok = await confirm({
      title: 'Crew에서 뺄까요?',
      body: `"${m.displayName}"(${m.username})을(를) 이 스페이스의 Crew에서 뺀다. Crew로 받은 읽기·쓰기가 사라진다 — 다시 넣으면 돌아온다.`,
      confirmLabel: '뺀다',
    });
    if (!ok) return;
    await act('crew', () => api(`/api/spaces/${id}/members/${m.userId}`, { method: 'DELETE' }));
  };

  if (error?.at === 'top' && !space)
    return (
      <Page>
        <PageHeader title="스페이스를 열 수 없다" />
        <Notice kind="error">{error.text}</Notice>
      </Page>
    );
  // 읽는 동안에도 왼쪽 칸을 차지한다 — 비워 두지 않으면 기본 문맥(바로가기·관리)이 잠깐 보였다가 스페이스 문맥으로 바뀐다
  if (!space)
    return (
      <Page>
        <SideSlot>{null}</SideSlot>
        <Loading />
      </Page>
    );

  // 고른 부모가 다시 읽은 트리에 없으면(그 사이 지워졌다) 맨 위로 보이고 맨 위로 보낸다 — 보이는 것과 보내는 것이 같아야 한다
  const parentValue = rows.some((r) => r.id === parentId) ? parentId : '';
  const { canManageMembers } = space.access;
  const errorAt = (at: ErrorAt) => (error?.at === at ? <Notice kind="error">{error.text}</Notice> : null);
  // 새 페이지 칸이 사라졌으면(그 사이 중지됐다) 그 거절은 머리 아래에 보인다 — 까닭이 칸과 함께 사라지면 안 된다
  const topError = error && (error.at === 'top' || (error.at === 'page' && !space.access.canWrite)) ? <Notice kind="error">{error.text}</Notice> : null;

  return (
    <Page>
      <SideSlot>
        <SpaceSideNav spaceId={id} space={space} pages={tree} />
      </SideSlot>
      <PageHeader
        title={space.name}
        description={
          <>
            {space.kind === 'personal' ? '개인' : '팀'} · {space.key}
            {space.categoryName && <> · {space.categoryName}</>}
            {space.status !== 'active' && (
              <>
                {' '}
                <StatusBadge kind="paused">중지됨 — 읽기만 된다</StatusBadge>
              </>
            )}
            {space.description && (
              <>
                <br />
                {space.description}
              </>
            )}
          </>
        }
      />
      {topError}

      {space.access.canWrite && (
        // 왼쪽 칸의 새 페이지가 여기로 온다(`#new-page`) — 구획의 머리부터 보이게 폼 전체에 둔다
        <form onSubmit={addPage} id="new-page">
          <FormSection title="새 페이지" as="div">
            {errorAt('page')}
            <FormRows>
              <FormRow id="pg-title" label="새 페이지 제목" required>
                <input id="pg-title" className="w-l" ref={titleBox} value={title} onChange={(e) => setTitle(e.target.value)} />
              </FormRow>
              <FormRow id="pg-parent" label="위치">
                <select id="pg-parent" className="w-l" value={parentValue} onChange={(e) => setParentId(e.target.value)}>
                  <option value="">맨 위</option>
                  {rows.map((r) => (
                    <option key={r.id} value={r.id}>
                      {indentedTitle(r)} 아래
                    </option>
                  ))}
                </select>
              </FormRow>
              {templates.length > 0 && (
                <FormRow id="pg-template" label="템플릿">
                  <select id="pg-template" className="w-m" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                    <option value="">빈 문서로 시작</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.description ? ` — ${t.description}` : ''}
                      </option>
                    ))}
                  </select>
                </FormRow>
              )}
            </FormRows>
            <FormActions>
              <button type="submit" className="primary">
                만들기
              </button>
            </FormActions>
          </FormSection>
        </form>
      )}

      {space.kind === 'team' && (
        <section className="card">
          <h2 id="crew-title">Crew</h2>
          {/* 관리자가 건 중지 동안 Crew는 관리자만 바꾼다 — 단추만 사라지면 권한을 잃은 줄 안다 (P16 FR-1702). 얼었는지는 판정이 말한다(`crewFrozen`).
              스스로 풀 수 있는 주인(관리자가 건 중지 풀기·스페이스 관리 전체를 받았다)에게는 관리자에게 부탁하라고 하지 않는다 */}
          {space.access.crewFrozen && (
            <Notice kind="warning">
              {space.access.canChangeStatus
                ? '관리자가 중지한 스페이스라 Crew를 바꾸지 못한다 — 아래 관리 칸의 다시 쓰기로 먼저 풀면 바꾼다.'
                : '관리자가 중지한 스페이스라 Crew를 바꾸지 못한다 — 관리자에게 부탁한다. 다시 쓰게 되면 주인도 바꾼다.'}
            </Notice>
          )}
          {errorAt('crew')}
          {/* 진짜 표 (J.5.5) — 예전에는 한 줄에 이름·아이디·역할을 이어 붙인 목록이었다 */}
          <div className="table-scroll" tabIndex={0}>
            <table aria-labelledby="crew-title">
              <thead>
                <tr>
                  <th scope="col">이름</th>
                  <th scope="col">아이디</th>
                  <th scope="col">역할</th>
                  {canManageMembers && (
                    <th scope="col">
                      <span className="sr-only">조치</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {crew.map((m) => {
                  const editable = canManageMembers && m.role !== 'owner';
                  return (
                    <tr key={m.userId}>
                      <td>{m.displayName}</td>
                      <td className="mono">{m.username}</td>
                      <td>
                        {editable ? (
                          <select
                            aria-label={`${m.username} 역할`}
                            className="w-s"
                            value={m.role}
                            onChange={(e) =>
                              void act('crew', () => api(`/api/spaces/${id}/members/${m.userId}`, { method: 'PATCH', json: { role: e.target.value as MemberRole } }))
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
                      </td>
                      {canManageMembers && (
                        <td className="actions-cell">
                          {editable && (
                            <button type="button" className="danger sm" onClick={() => void removeMember(m)}>
                              제거
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {canManageMembers && (
            // 칸 + 단추 한 줄 (J.5.4). `required`는 칸에 둔다 — Field의 보이는 "필수"는 label 안에 들어가 라벨 글이 바뀐다(시험은 라벨로 칸을 찾는다)
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void act('crew', async () => {
                  await api(`/api/spaces/${id}/members`, { method: 'POST', json: { username, role: addRole } });
                  setUsername('');
                });
              }}
            >
              <Field id="crew-user" label="아이디로 Crew 추가">
                <input id="crew-user" className="w-m" value={username} onChange={(e) => setUsername(e.target.value)} required />
              </Field>
              <Field id="crew-role" label="역할">
                <select id="crew-role" className="w-s" value={addRole} onChange={(e) => setAddRole(e.target.value as MemberRole)}>
                  {ASSIGNABLE_MEMBER_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </Field>
              <button type="submit" className="primary">
                추가
              </button>
            </form>
          )}
        </section>
      )}

      <SpaceManage space={space} meId={me?.id} onChanged={load} onDeleted={() => nav('/')} />
      {dialog}
    </Page>
  );
}
