import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db.module';
import { HealthController } from './health.controller';

/** DB는 대역을 쓰지 않는 것이 원칙이지만(CLAUDE.md 3절·설계서_Architecture 6절), 여기서 볼 것은 "DB 실패를 503으로 바꾸는가"다. */
const okDb = { execute: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) } as unknown as Db;
const deadDb = { execute: vi.fn().mockRejectedValue(new Error('connection refused')) } as unknown as Db;

describe('HealthController (FR-040, FR-041)', () => {
  it('DB 질의가 성공하면 status·db가 ok이고 시각은 파싱 가능하다', async () => {
    const res = await new HealthController(okDb).check();
    expect(res.status).toBe('ok');
    expect(res.db).toBe('ok');
    expect(Number.isNaN(Date.parse(res.time))).toBe(false);
  });

  it('Error가 아닌 값으로 거부돼도 503을 던지고 로그를 남긴다', async () => {
    const weirdDb = { execute: vi.fn().mockRejectedValue('문자열 거부') } as unknown as Db;
    await expect(new HealthController(weirdDb).check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('DB 질의가 실패하면 503을 던진다 — 앱만 살아 있는 상태를 정상으로 보고하지 않는다', async () => {
    await expect(new HealthController(deadDb).check()).rejects.toBeInstanceOf(ServiceUnavailableException);
    try {
      await new HealthController(deadDb).check();
    } catch (e) {
      expect((e as ServiceUnavailableException).getResponse()).toMatchObject({ status: 'degraded', db: 'unreachable' });
    }
  });
});
