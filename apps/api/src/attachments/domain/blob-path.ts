import { join } from 'node:path';

/**
 * 첨부 파일이 디스크에 놓이는 자리를 **한 곳에서** 정한다 (P3_설계서_Content 3.1절, A등급).
 *
 * `<root>/<해시 앞 2자>/<해시>`다. 앞 두 자로 나누는 것은 한 디렉토리에 파일이 수만 개
 * 쌓이면 디렉토리 조회 자체가 느려지기 때문이다.
 *
 * **왜 떼어냈나.** 같은 규칙이 `LocalDiskStorage`와 `pnpm trash:purge` 두 곳에 적혀 있었다.
 * 정리 명령은 Nest 밖에서 돌아 스토리지 구현을 쓸 수 없었기 때문이다. 그런데 **한쪽만
 * 바뀌면 정리가 엉뚱한 경로를 지운다** — 지우는 쪽이 조용히 아무것도 못 지우거나, 더 나쁘면
 * 안 지워야 할 것을 지운다. 규칙은 순수 함수라 양쪽이 같은 것을 부를 수 있다 (P4 자체 점검).
 */

/** 해시가 아닌 이름은 받지 않는다. 경로를 만드는 값이라 **여기서 막는다** (FR-412) */
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function blobPath(root: string, sha256: string): string {
  if (!SHA256_HEX.test(sha256)) throw new Error(`저장소 키가 SHA-256 16진수가 아니다: ${sha256}`);
  return join(root, sha256.slice(0, 2), sha256);
}
