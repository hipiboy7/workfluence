import { isUuid } from '@workfluence/shared';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';

/**
 * 주소의 `:id`가 **식별자 모양일 때만** 그 화면을 그린다 (P10 종료 루틴 — 경로 조작).
 *
 * 화면은 주소의 id를 API 경로와 부품(첨부·댓글·라벨)에 넘긴다. 라우터는 주소의 `%2F`를 풀어 넘기므로 `x%2Flabels%2Fy`가 그대로
 * 경로의 하위 조각이 된다 — `api()`의 점 조각 막기(`hasDotSegment`)가 닿지 않는 하강이다. 이 시스템의 id는 모두 UUID이고 서버도
 * 같은 판정으로 받는다(`UuidPipe`, `isUuid`). 아니면 API를 부르지 않고 "찾을 수 없다"를 그린다.
 *
 * **`:id`가 없는 경로에서는 그대로 그린다** — 같은 화면이 두 경로에 있으면(`/llm`·`/llm/:id`) 둘 다 이것으로 감싸 트리의 모양을 같게
 * 둔다. 모양이 다르면 옮길 때 React가 화면을 새로 만들어 알림과 상태를 잃는다(새 대화의 답이 끝나 `/llm/:id`로 옮길 때 — E2E가 잡았다).
 */
export function RequireUuidParam({ children }: { children: ReactNode }) {
  const { id } = useParams();
  if (id !== undefined && !isUuid(id)) {
    return (
      <main className="shell">
        <p className="badge fail" role="alert">
          주소가 올바르지 않다 — 찾을 수 없다
        </p>
        <p className="muted small">
          <Link to="/">← 홈</Link>
        </p>
      </main>
    );
  }
  return <>{children}</>;
}
