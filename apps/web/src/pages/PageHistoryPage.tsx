import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { DocNode, PageDiffView, PageVersionView, SpaceView, PageView } from '@workfluence/shared';
import { api } from '../api';
import { Editor } from '../components/Editor';
import { Loading, Notice, Page, PageHeader, useReadWide, type Crumb } from '../components/ui';
import { SideSlot } from '../layout/AppLayout';
import { SpaceSideNav } from '../layout/SpaceSideNav';

const PREVIEW_TITLE_ID = 'version-preview-title';

/**
 * 버전 이력·복원 (FR-344). 복원은 새 버전을 만든다 — 이력은 지워지지 않는다. 그래서 복원은 묻지 않는다(P17 J.5.10 — 되돌릴 수 있다)
 *
 * 모양은 P17 설계서 J.3.7·J.6이다 — 목록 폭(`Page wide`), 머리에 빵부스러기(스페이스 / 페이지)와 **← 보기로**, 도구 줄(비교하기) 바로 아래 **한
 * 자리**에 비교 결과나 미리보기(글 칸 폭 — 넓게 보기면 넓다, 보기 화면과 같은 값), 그 아래 버전 목록(`.row-list`). 비교와 미리보기는 같은 자리를
 * 번갈아 쓴다 — 둘이 함께 뜨면 어느 것이 무엇인지 헷갈린다. 왼쪽 칸은 스페이스 문맥(페이지 트리)이다
 */
export function PageHistoryPage() {
  const { id = '' } = useParams();
  // **페이지마다 새로 만든다** (P17 병합 전 검토 14) — 같은 경로의 다른 id로 곧바로 옮겨 가면 앞 페이지의 버전 목록·고른 버전·비교·미리보기가 남아
  // 복원이 새 페이지에 옛 목록의 번호로 갈 수 있었다. 트리의 링크는 보기로 가므로 이력 화면끼리 옮기는 일은 드물어 왼쪽 칸도 함께 새로 만든다
  return <PageHistoryScreen key={id} />;
}

function PageHistoryScreen() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [versions, setVersions] = useState<PageVersionView[] | null>(null);
  const [preview, setPreview] = useState<(PageVersionView & { content: DocNode }) | null>(null);
  const [page, setPage] = useState<PageView | null>(null);
  const [pageFailed, setPageFailed] = useState(false);
  const [space, setSpace] = useState<SpaceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wide] = useReadWide();

  const load = useCallback(() => {
    api<PageVersionView[]>(`/api/pages/${id}/versions`)
      .then(setVersions)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    api<PageView>(`/api/pages/${id}`)
      .then((p) => {
        setPage(p);
        return api<SpaceView>(`/api/spaces/${p.spaceId}`);
      })
      .then(setSpace)
      .catch(() => setPageFailed(true));
  }, [id]);
  useEffect(load, [load]);

  // 복원은 스페이스에 쓸 수 있을 때만 — 스페이스를 읽지 못하면 두지 않는다
  const here = page && space && space.id === page.spaceId ? space : null;
  const canWrite = here?.access.canWrite ?? false;
  const crumbs: Crumb[] | undefined = page && here ? [{ label: here.name, to: `/spaces/${page.spaceId}` }, { label: page.title }] : undefined;
  const docClass = wide ? 'doc wide' : 'doc';

  // 비교할 두 버전. 하나만 고르면 "다음 것을 고르세요"로 남는다
  const [pick, setPick] = useState<number[]>([]);
  const [diff, setDiff] = useState<PageDiffView | null>(null);
  const toggle = (no: number): void => {
    setDiff(null);
    setPick((cur) => (cur.includes(no) ? cur.filter((x) => x !== no) : [...cur, no].slice(-2)));
  };
  const compare = (): void => {
    const [a, b] = [...pick].sort((x, y) => x - y);
    void api<PageDiffView>(`/api/pages/${id}/versions/${a}/diff/${b}`)
      .then((d) => {
        setPreview(null);
        setDiff(d);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const show = (no: number): void =>
    void api<PageVersionView & { content: DocNode }>(`/api/pages/${id}/versions/${no}`)
      .then((v) => {
        setDiff(null);
        setPreview(v);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  const restore = (no: number): void =>
    void api(`/api/pages/${id}/versions/${no}/restore`, { method: 'POST' })
      .then(() => nav(`/pages/${id}`))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  return (
    <Page width="wide">
      {page ? (
        <SideSlot>
          <SpaceSideNav spaceId={page.spaceId} currentPageId={id} />
        </SideSlot>
      ) : (
        // 페이지를 읽지 못하면 스페이스를 모른다 — 왼쪽 칸은 기본 문맥으로 둔다
        !pageFailed && (
          <SideSlot>
            <Loading />
          </SideSlot>
        )
      )}
      <PageHeader
        title="버전 이력"
        crumbs={crumbs}
        actions={
          <Link className="btn" to={`/pages/${id}`}>
            ← 보기로
          </Link>
        }
        description={
          <>
            복원해도 이력은 지워지지 않는다. 그 내용으로 <strong>새 버전</strong>이 하나 더 생긴다.
          </>
        }
      />
      {error && <Notice kind="error">{error}</Notice>}

      <section aria-label="버전 비교">
        <div className="doc-tools">
          <button type="button" className="primary" onClick={compare} disabled={pick.length !== 2}>
            비교하기
          </button>
          <span className="muted">
            아래 목록에서 <strong>두 개</strong>를 고르면 무엇이 바뀌었는지 볼 수 있다. 지금 고른 것:{' '}
            {pick.length ? pick.map((n) => `v${n}`).join(', ') : '없음'}
          </span>
        </div>
        {diff && (
          // 글 칸 폭의 상자 — 칸 밖의 여백이 상자와 목록 사이를 띄운다
          <div className={docClass}>
            <div className="card diff">
              <p className="muted small">
                v{diff.from.versionNo} → v{diff.to.versionNo} · 변경 {diff.diff.modified} · 추가 {diff.diff.added} · 삭제 {diff.diff.removed}
                {diff.titleChanged && ' · 제목도 바뀌었다'}
              </p>
              {!diff.diff.changed && <p>두 버전의 내용이 같다.</p>}
              {diff.diff.blocks.map((b, i) => (
                <p key={i} className={`diff-${b.kind}`}>
                  {b.kind === 'changed' && b.words
                    ? b.words.map((w, j) => (
                        <span key={j} className={`w-${w.kind}`}>
                          {w.text}{' '}
                        </span>
                      ))
                    : (b.after ?? b.before ?? '')}
                </p>
              ))}
            </div>
          </div>
        )}
      </section>
      {preview && (
        <div className={docClass}>
          <section className="card" aria-labelledby={PREVIEW_TITLE_ID}>
            <h2 id={PREVIEW_TITLE_ID}>v{preview.versionNo} 미리보기</h2>
            <Editor value={preview.content} editable={false} />
          </section>
        </div>
      )}

      {versions === null ? (
        !error && <Loading />
      ) : (
        <ul className="row-list" aria-label="버전 목록">
          {versions.map((v) => (
            <li key={v.versionNo}>
              {/* **체크박스를 버전 뒤에 둔다.** 앞에 두면 목록 항목이 "비교 v1…"로 시작해
                  버전으로 항목을 찾던 기존 화면 테스트가 깨진다 — 읽는 순서도 이쪽이 자연스럽다 */}
              <span className="row-title">v{v.versionNo}</span> <span className="grow">{v.title}</span>{' '}
              <span className="muted">{v.createdByName}</span>{' '}
              <time className="muted" dateTime={v.createdAt}>
                {new Date(v.createdAt).toLocaleString('ko-KR')}
              </time>{' '}
              <label>
                <input type="checkbox" checked={pick.includes(v.versionNo)} onChange={() => toggle(v.versionNo)} /> 비교
              </label>{' '}
              <button type="button" className="subtle sm" onClick={() => show(v.versionNo)}>
                보기
              </button>
              {canWrite && (
                <button type="button" className="sm" onClick={() => restore(v.versionNo)}>
                  이 버전으로 복원
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
