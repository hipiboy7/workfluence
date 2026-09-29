import { isUuid } from '@workfluence/shared';
import type { ReactNode } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import { Notice, Page, PageHeader } from './ui';

/**
 * 주소의 `:id`가 **식별자 모양일 때만** 그 화면을 그린다 (P10 종료 루틴 — 경로 조작).
 *
 * 화면은 주소의 id를 API 경로와 부품(첨부·댓글·라벨)에 넘긴다. 라우터는 주소의 `%2F`를 풀어 넘기므로 `x%2Flabels%2Fy`가 그대로
 * 경로의 하위 조각이 된다 — `api()`의 점 조각 막기(`hasDotSegment`)가 닿지 않는 하강이다. 이 시스템의 id는 모두 UUID이고 서버도
 * 같은 판정으로 받는다(`UuidPipe`, `isUuid`). 아니면 API를 부르지 않고 "찾을 수 없다"를 그린다.
 *
 * **`:id`가 없는 경로에서는 그대로 그린다** — 같은 화면이 두 경로에 있으면(`/llm`·`/llm/:id`) 둘 다 이것으로 감싸 트리의 모양을 같게
 * 둔다. 모양이 다르면 옮길 때 React가 화면을 새로 만들어 알림과 상태를 잃는다(새 대화의 답이 끝나 `/llm/:id`로 옮길 때 — E2E가 잡았다).
 *
 * **대문자가 든 식별자는 소문자 주소로 바꿔 연다** — 서버는 경계에서 소문자로 맞춰 돌려주고(`idSchema`, P14), 화면은 받은 것과 주소의 id를
 * 견준다(페이지 보기는 주소의 페이지를 읽은 뒤에만 그린다). 대문자 주소(붙여 넣은 링크)면 영영 "불러오는 중"에 머물렀다(P17 좁은 재점검 N2)
 */
export function RequireUuidParam({ children }: { children: ReactNode }) {
  const { id } = useParams();
  const { pathname, search, hash } = useLocation();
  if (id !== undefined && !isUuid(id)) return <NotFoundPage />;
  if (id !== undefined && id !== id.toLowerCase()) return <Navigate replace to={{ pathname: pathname.replace(id, id.toLowerCase()), search, hash }} />;
  return <>{children}</>;
}

/**
 * 잘못된 주소 — 한 틀 안에 머리(h1 "찾을 수 없다" — 탭 제목도 같다)와 알림띠, **← 홈** (P17 설계서 J.6). 식별자 모양이 아닌 id와 없는 경로가 같이
 * 쓴다. 화면마다 h1이 하나다(FR-1854) — 없으면 보조기기의 제목 탐색에 이 화면이 잡히지 않는다(병합 전 검토 10)
 */
export function NotFoundPage() {
  return (
    <Page>
      <PageHeader title="찾을 수 없다" />
      <Notice kind="error">주소가 올바르지 않다 — 찾을 수 없다</Notice>
      <p>
        <Link to="/">← 홈</Link>
      </p>
    </Page>
  );
}
