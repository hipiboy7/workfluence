import type { PageSummary } from '@workfluence/shared';
import type { PageRow } from '../db/schema';

/** 행 → 응답 변환. pages.service와 spaces.module 양쪽이 쓰므로 순환 import를 피해 별도 파일에 둔다 */
export function toPageSummary(p: PageRow): PageSummary {
  return {
    id: p.id,
    spaceId: p.spaceId,
    parentId: p.parentId,
    title: p.title,
    position: p.position,
    currentVersionNo: p.currentVersionNo,
    updatedAt: p.updatedAt.toISOString(),
  };
}
