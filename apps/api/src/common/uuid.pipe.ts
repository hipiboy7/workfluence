import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';

/**
 * 경로·쿼리의 uuid를 검증한다 (CLAUDE.md 7절 "모든 요청 본문·쿼리는 zod 검증").
 *
 * **없으면 PostgreSQL이 `22P02`로 죽어 500이 난다.** 잘못된 입력은 400이어야 한다 —
 * 500은 "서버가 고장났다"는 뜻이고, 그러면 진짜 고장과 구분되지 않는다.
 */
@Injectable()
export class UuidPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const r = z.uuid().safeParse(value);
    if (!r.success) throw new BadRequestException('올바른 식별자가 아니다');
    return r.data;
  }
}
