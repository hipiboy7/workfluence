import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { parseId } from '@workfluence/shared';

/**
 * 경로·쿼리의 uuid를 검증한다 (CLAUDE.md 7절 "모든 요청 본문·쿼리는 zod 검증").
 *
 * **없으면 PostgreSQL이 `22P02`로 죽어 500이 난다.** 잘못된 입력은 400이어야 한다 —
 * 500은 "서버가 고장났다"는 뜻이고, 그러면 진짜 고장과 구분되지 않는다.
 *
 * **소문자로 돌려준다** (P14 반영분 점검 2) — DB의 uuid는 소문자다. 대문자 그대로 넘기면 서비스의 JS 비교(순환 판정 등)와 잠금 이름이 어긋난다
 */
@Injectable()
export class UuidPipe implements PipeTransform<unknown, string> {
  /** 모양 판정은 화면의 경로 지킴(`RequireUuidParam`)의 `isUuid`와 같다 (`parseId`) */
  transform(value: unknown): string {
    const id = parseId(value);
    if (!id) throw new BadRequestException('올바른 식별자가 아니다');
    return id;
  }
}
