import { isUuid } from '@workfluence/shared';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';

/**
 * 주소의 `:id`가 **식별자 모양일 때만** 그 화면을 그린다 (P10 종료 루틴 — 경로 조작).
 *
 * 화면은 주소의 id를 API 경로와 부품(첨부·댓글·라벨)에 넘긴다. 라우터는 주소의 `%2F`를 풀어 넘기므로 `x%2Flabels%2Fy`가 그대로
 * 경로의 하위 조각이 된다 — `api()`의 점 조각 막기(`hasDotSegment`)가 닿지 않는 하강이다. 이 시스템의 id는 모두 UUID이고 서버도
 * 같은 판정으로 받는다(`UuidPipe`, `isUuid`). 아니면 API를 부르지 않고 "찾을 수 없다"를 그린다.
 */
export function RequireUuidParam({ children }: { children: ReactNode }) {
  const { id } = useParams();
  if (!isUuid(id)) {
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
