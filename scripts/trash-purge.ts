import { trashPurge } from '../apps/api/src/cli/trash-purge';

/**
 * 휴지통 정리 — **본문은 `apps/api/src/cli/trash-purge.ts`에 있다** (P13 D.2, FR-1411). 개발은 이것(`pnpm trash:purge`)을, 운영(폐쇄망)은 앱 이미지 안의
 * `node dist/cli/trash-purge.js`를 compose의 `tools`로 부른다 — 같은 코드다. 예전에는 본문이 여기 있어 이미지에 들지 않았고, Node가 없는 운영
 * 서버에서 돌릴 길이 없었다
 */
void trashPurge().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
