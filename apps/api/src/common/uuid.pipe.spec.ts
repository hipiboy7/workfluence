import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { UuidPipe } from './uuid.pipe';

/**
 * 이 파일은 **Phase 5에서 처음 생겼다.** 그전까지 `uuid.pipe.ts`는 커버리지 0%였고,
 * 패키지 합계(93.9%)에 가려 관문이 초록이었다.
 *
 * 하필 이것이 **입력 검증 부품**이다. 이게 없으면 잘못된 식별자가 PostgreSQL까지 가서
 * `22P02`로 500이 난다. 500은 "서버가 고장났다"는 뜻이라 **진짜 고장과 구분되지 않는다** —
 * 그래서 이 조각이 조용히 죽어 있으면 운영에서 원인 못 찾는 500이 쌓인다.
 */
describe('UuidPipe (CLAUDE.md 7절)', () => {
  const pipe = new UuidPipe();

  it('uuid를 그대로 통과시킨다', () => {
    const id = '3a1cbfb8-82bc-4923-a4d5-cf3bdf359845';
    expect(pipe.transform(id)).toBe(id);
  });

  it('**uuid가 아닌 것은 400으로 거부한다** — DB까지 보내면 500이 된다', () => {
    for (const bad of ['', 'abc', '3a1cbfb8-82bc-4923-a4d5', `3a1cbfb8-82bc-4923-a4d5-cf3bdf359845 or 1=1`]) {
      expect(() => pipe.transform(bad)).toThrow(BadRequestException);
    }
  });

  it('문자열이 아닌 것도 거부한다 — 쿼리는 배열이나 객체로도 들어온다', () => {
    for (const bad of [undefined, null, 42, {}, ['3a1cbfb8-82bc-4923-a4d5-cf3bdf359845']]) {
      expect(() => pipe.transform(bad)).toThrow(BadRequestException);
    }
  });

  it('거부 문구에 **입력값을 되돌려 주지 않는다** — 반사된 값이 화면에 그대로 뜨는 길을 막는다', () => {
    const attack = '<script>alert(1)</script>';
    try {
      pipe.transform(attack);
      expect.unreachable('거부돼야 한다');
    } catch (e) {
      expect((e as BadRequestException).message).not.toContain(attack);
    }
  });
});
