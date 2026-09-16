import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodPipe } from './zod.pipe';

const schema = z.object({ name: z.string().min(1), count: z.coerce.number().int().min(0) });

describe('ZodPipe (FR-060)', () => {
  it('유효한 값은 파싱 결과를 돌려준다', () => {
    const pipe = new ZodPipe(schema);
    expect(pipe.transform({ name: 'a', count: '3' })).toEqual({ name: 'a', count: 3 });
  });

  it('실패하면 400과 위반 항목 목록을 낸다 — 어느 필드가 왜 틀렸는지 화면이 보여줄 수 있어야 한다', () => {
    const pipe = new ZodPipe(schema);
    let thrown: unknown;
    try {
      pipe.transform({ name: '', count: -1 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    const body = (thrown as BadRequestException).getResponse() as { message: string; issues: { path: string; message: string }[] };
    expect(body.message).toBe('요청 검증 실패');
    expect(body.issues.map((i) => i.path).sort()).toEqual(['count', 'name']);
    expect(body.issues.every((i) => typeof i.message === 'string' && i.message.length > 0)).toBe(true);
  });

  it('중첩 필드의 경로를 점으로 잇는다', () => {
    const pipe = new ZodPipe(z.object({ user: z.object({ email: z.string().min(3) }) }));
    try {
      pipe.transform({ user: { email: '' } });
      expect.unreachable('예외가 나야 한다');
    } catch (e) {
      const body = (e as BadRequestException).getResponse() as { issues: { path: string }[] };
      expect(body.issues[0].path).toBe('user.email');
    }
  });
});
