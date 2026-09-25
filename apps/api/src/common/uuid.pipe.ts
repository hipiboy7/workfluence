import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { isUuid } from '@workfluence/shared';

/**
 * 경로·쿼리의 uuid를 검증한다 (CLAUDE.md 7절 "모든 요청 본문·쿼리는 zod 검증").
 *
 * **없으면 PostgreSQL이 `22P02`로 죽어 500이 난다.** 잘못된 입력은 400이어야 한다 —
 * 500은 "서버가 고장났다"는 뜻이고, 그러면 진짜 고장과 구분되지 않는다.
 */
@Injectable()
export class UuidPipe implements PipeTransform<unknown, string> {
  /** 판정은 화면의 경로 지킴(`RequireUuidParam`)과 같은 함수다 (`isUuid`) */
  transform(value: unknown): string {
    if (!isUuid(value)) throw new BadRequestException('올바른 식별자가 아니다');
    return value;
  }
}
