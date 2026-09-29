import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { can } from '@workfluence/shared';
import type { PageSummary, PageView, SpaceView } from '@workfluence/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { TemplateFromPage } from '../components/TemplateFromPage';
import { Attachments } from '../components/Attachments';
import { Comments } from '../components/Comments';
import { CopyButtons } from '../components/CopyButtons';
import { Labels } from '../components/Labels';
import { MovePage } from '../components/MovePage';
import { Editor } from '../components/Editor';
import { Breadcrumbs, Loading, Notice, Page, PageHeader, useDocumentTitle, useReadWide, type Crumb } from '../components/ui';
import { SideSlot } from '../layout/AppLayout';
import { SpaceSideNav, announceTreeChanged } from '../layout/SpaceSideNav';

/** 스페이스와 그 트리 — 빵부스러기와 왼쪽 칸이 같이 쓴다. 트리를 읽지 못하면 `null`이다(빵부스러기는 스페이스 / 페이지만) */
type Context = { space: SpaceView; pages: PageSummary[] | null };

const LOAD_FAILED_TITLE = '페이지를 열 수 없다';

/** 트리에서 부모를 따라 올라간 조상들 — 맨 위가 먼저. 부모를 잃었거나(휴지통) 돌아오는 고리가 있으면 거기서 멈춘다 */
function ancestorsOf(page: PageSummary, pages: readonly PageSummary[]): PageSummary[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const seen = new Set<string>([page.id]);
  const chain: PageSummary[] = [];
  let cur = page.parentId ? byId.get(page.parentId) : undefined;
  while (cur && !seen.has(cur.id)) {
    chain.unshift(cur);
    seen.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

/**
 * 페이지 보기. 쓸 수 있으면 **하위 페이지 만들기**(→ 스페이스 화면의 새 페이지 칸, 부모를 골라 둔 채)와 **옮기기**(P14 FR-1500·1501·1505) —
 * 보이는 조건은 응답의 `access`다(P2 FR-345).
 *
 * 모양은 P17 설계서 J.3.5·J.6이다 — 왼쪽 칸은 스페이스 문맥(페이지 트리), 머리 줄에 빵부스러기(스페이스 / 상위 페이지 / 페이지)와 조치(편집 ·
 * 하위 페이지 만들기 · 옮기기 · 삭제), 글 칸(760px, 넓게 보기면 1200px) 안에 h1 → 메타 "버전 N · 시각 · 이력" → 도구 줄 → 본문 → 라벨 → 첨부
 * → 댓글 → 템플릿(관리자). **h1은 글 칸 안에 있어 머리(PageHeader)를 쓰지 않는다** — 탭 제목은 따로 붙인다(FR-1854).
 *
 * 머리 줄의 **삭제**는 문서 순서로 댓글의 삭제보다 앞이다 — 시험이 첫 "삭제"를 페이지의 것으로 누른다(T-071). 페이지 삭제는 묻지 않는다 — 휴지통에서
 * 되살린다(J.5.10)
 */
export function PageViewPage() {
  const { me } = useAuth();
  const { id = '' } = useParams();
  const isAdmin = me ? can({ id: me.id, role: me.role }, 'space.manage') : false;
  const nav = useNavigate();
  const [page, setPage] = useState<PageView | null>(null);
  const [ctx, setCtx] = useState<Context | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [wide, toggleWide] = useReadWide();
  useDocumentTitle(page?.title ?? (loadError ? LOAD_FAILED_TITLE : null));

  useEffect(() => {
    // 트리에서 다른 페이지로 가면 이 화면은 그대로 있고 주소만 바뀐다 — 앞 페이지의 칸·오류를 닫고, 늦게 온 앞 페이지의 응답은 버린다
    let alive = true;
    setMoving(false);
    setActionError(null);
    api<PageView>(`/api/pages/${id}`)
      .then(async (p) => {
        if (!alive) return;
        setPage(p);
        setLoadError(null);
        const [space, pages] = await Promise.all([
          api<SpaceView>(`/api/spaces/${p.spaceId}`),
          // 트리는 빵부스러기와 왼쪽 칸에만 쓴다 — 읽지 못해도 페이지는 보인다
          api<PageSummary[]>(`/api/pages?spaceId=${encodeURIComponent(p.spaceId)}`).catch(() => null),
        ]);
        if (alive) setCtx({ space, pages });
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [id]);

  // 앞 페이지의 스페이스가 남아 있으면 쓰지 않는다 — 다른 스페이스의 페이지로 옮긴 사이 그 이름·권한·트리가 섞이지 않게
  const here = page && ctx && ctx.space.id === page.spaceId ? ctx : null;
  const crumbs = useMemo<Crumb[]>(() => {
    if (!page || !here) return [];
    const parents = here.pages ? ancestorsOf(page, here.pages) : [];
    return [{ label: here.space.name, to: `/spaces/${page.spaceId}` }, ...parents.map((p) => ({ label: p.title, to: `/pages/${p.id}` })), { label: page.title }];
  }, [page, here]);

  if (loadError) {
    return (
      <Page width="read">
        <PageHeader title={LOAD_FAILED_TITLE} />
        <Notice kind="error">{loadError}</Notice>
      </Page>
    );
  }
  if (!page) {
    return (
      <>
        <SideSlot>
          <Loading />
        </SideSlot>
        <Loading />
      </>
    );
  }

  const canWrite = here?.space.access.canWrite ?? false;
  const remove = () =>
    void api(`/api/pages/${id}`, { method: 'DELETE' })
      .then(() => {
        announceTreeChanged(page.spaceId);
        nav(`/spaces/${page.spaceId}`);
      })
      .catch((e: unknown) => setActionError(e instanceof Error ? e.message : String(e)));

  return (
    <Page width="full">
      <SideSlot>
        {/* 이 화면이 읽은 스페이스와 트리를 넘긴다 — 빵부스러기와 트리가 같은 목록을 보고, 넘긴 뒤로는 왼쪽 칸이 따로 부르지 않는다. 넘기기 전(처음
            여는 동안)에는 왼쪽 칸이 들고 있던 트리를 먼저 보이고 스스로 한 번 부른다 — 옮길 때마다 비었다가 다시 그려지지 않게(J.5.11) */}
        <SpaceSideNav spaceId={page.spaceId} currentPageId={id} space={here?.space ?? null} pages={here?.pages ?? null} />
      </SideSlot>
      <div className="doc-head">
        <Breadcrumbs items={crumbs} />
        {canWrite && (
          <div className="actions">
            <Link className="btn primary" to={`/pages/${id}/edit`}>
              편집
            </Link>
            <Link className="btn" to={`/spaces/${page.spaceId}?parent=${encodeURIComponent(id)}#new-page`}>
              하위 페이지 만들기
            </Link>
            <button type="button" aria-expanded={moving} onClick={() => setMoving((v) => !v)}>
              옮기기
            </button>
            <button type="button" className="danger" onClick={remove}>
              삭제
            </button>
          </div>
        )}
      </div>
      <div className={wide ? 'doc wide' : 'doc'}>
        {actionError && <Notice kind="error">{actionError}</Notice>}
        {moving && canWrite && (
          <MovePage
            page={page}
            onMoved={() => {
              announceTreeChanged(page.spaceId);
              nav(`/spaces/${page.spaceId}`);
            }}
            onCancel={() => setMoving(false)}
          />
        )}
        <h1>{page.title}</h1>
        <p className="doc-meta">
          버전 {page.currentVersionNo} · <time dateTime={page.updatedAt}>{new Date(page.updatedAt).toLocaleString('ko-KR')}</time> ·{' '}
          <Link to={`/pages/${id}/history`}>이력</Link>
        </p>
        <div className="doc-tools">
          {/* **평범한 링크다.** `fetch`로 받아 `Blob`을 만들면 파일 이름을 화면이 다시
              정해야 하는데, 그 이름은 서버가 이미 안전하게 정했다 (FR-730) */}
          <a className="btn subtle" href={`/api/pages/${id}/export`} download>
            HTML로 내보내기
          </a>
          {/* LLM 질문에 붙여 넣으려고 복사한다 (P10 FR-1140). 서버가 페이지를 LLM에 보내는 길은 없다 */}
          <CopyButtons title={page.title} content={page.content} />
          <button type="button" className="subtle" aria-pressed={wide} onClick={toggleWide}>
            넓게 보기
          </button>
        </div>
        {/* 본문이 이 화면의 첫 읽기 전용 편집기다 — 시험이 `.editor.readonly`의 첫째를 본문으로 읽는다(댓글도 같은 편집기다) */}
        <Editor value={page.content} editable={false} />
        <Labels pageId={id} canWrite={canWrite} />
        <Attachments pageId={id} canWrite={canWrite} />
        <Comments pageId={id} canWrite={canWrite} />
        {/* **템플릿은 여기서 만든다.** 별도 관리 화면을 두지 않는 것은, 템플릿이 되는 것은
            언제나 "잘 쓴 문서 하나"이고 그것을 보고 있을 때 결정하기 때문이다 (FR-740·743). 맨 아래의 접힌 구획이다(P17 J.6) */}
        {isAdmin && <TemplateFromPage page={page} />}
      </div>
    </Page>
  );
}
