import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blobPath } from './blob-path';

const SHA = 'a'.repeat(64);

/**
 * 구분자는 OS의 것이다 — Linux는 `/`, Windows는 `\`. 경로 전체를 문자열 하나로 대조하면 **Windows에서만** 깨지므로
 * 조각으로 나눠 본다 (`exp/windows` — Windows에서 `pnpm test`를 돌리려고 고쳤다)
 */
const parts = (p: string) => p.split(sep);

describe('blobPath (FR-412)', () => {
  it('앞 두 자로 디렉토리를 나눈다', () => {
    expect(parts(blobPath('/data', SHA))).toEqual(['', 'data', 'aa', SHA]);
  });

  it('해시 형식이 아니면 거부한다 — **경로를 만드는 값이기 때문이다**', () => {
    for (const bad of ['', '../../etc/passwd', 'A'.repeat(64), 'a'.repeat(63), `${SHA}/x`, 'a/b']) {
      expect(() => blobPath('/data', bad)).toThrow(/SHA-256/);
    }
  });

  it('루트가 상대 경로여도 그대로 이어 붙인다 — 절대화는 호출부의 일이다', () => {
    expect(parts(blobPath('.local/attachments', SHA))).toEqual(['.local', 'attachments', 'aa', SHA]);
  });
});
