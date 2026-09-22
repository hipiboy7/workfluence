import { describe, expect, it } from 'vitest';
import {
  BACKUP_COUNTED_TABLES,
  BACKUP_REQUIRED_FILES,
  RELEASE_REQUIRED_FILES,
  backupCounts,
  formatChecksums,
  formatManifest,
  parseChecksums,
  parseManifest,
  verifyChecksums,
} from './release';

/** A등급 (P5_설계서_Release D절). 테스트를 먼저 썼다. */

describe('체크섬 목록 (FR-602)', () => {
  const entries = [
    { file: 'app.tar', sha256: 'a'.repeat(64) },
    { file: 'postgres.tar', sha256: 'b'.repeat(64) },
  ];

  it('sha256sum과 같은 서식으로 쓴다 — 표준 도구로도 검사할 수 있어야 한다', () => {
    expect(formatChecksums(entries)).toBe(`${'a'.repeat(64)}  app.tar\n${'b'.repeat(64)}  postgres.tar\n`);
  });

  it('쓴 것을 그대로 읽는다', () => {
    expect(parseChecksums(formatChecksums(entries))).toEqual(entries);
  });

  it('빈 줄과 주석을 넘긴다', () => {
    expect(parseChecksums(`# 만든 날\n\n${'a'.repeat(64)}  app.tar\n`)).toEqual([entries[0]]);
  });

  it('**서식이 깨진 줄은 조용히 넘기지 않고 알린다** — 검사 파일이 상하면 검사가 무의미해진다', () => {
    expect(() => parseChecksums('deadbeef  app.tar\n')).toThrow(/체크섬/);
    expect(() => parseChecksums(`${'a'.repeat(64)}\n`)).toThrow(/체크섬/);
  });
});

describe('대조 (FR-604)', () => {
  const expected = [
    { file: 'app.tar', sha256: 'a'.repeat(64) },
    { file: 'db.tar', sha256: 'b'.repeat(64) },
  ];

  it('전부 맞으면 통과', () => {
    expect(verifyChecksums(expected, { 'app.tar': 'a'.repeat(64), 'db.tar': 'b'.repeat(64) })).toEqual([]);
  });

  it('값이 다르면 그 파일을 집어 준다', () => {
    const p = verifyChecksums(expected, { 'app.tar': 'c'.repeat(64), 'db.tar': 'b'.repeat(64) });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/app\.tar/);
  });

  it('**빠진 파일도 실패다** — 목록에 있는데 없으면 반입이 불완전하다', () => {
    const p = verifyChecksums(expected, { 'app.tar': 'a'.repeat(64) });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/db\.tar/);
  });

  it('목록에 없는 파일이 더 있는 것은 실패가 아니다 — 절차서·README가 함께 온다', () => {
    expect(verifyChecksums(expected, { 'app.tar': 'a'.repeat(64), 'db.tar': 'b'.repeat(64), 'README.md': 'x' })).toEqual([]);
  });
});

describe('매니페스트 (FR-603)', () => {
  const m = { version: '0.1.0', gitSha: 'abc1234', builtAt: '2026-09-22T00:00:00.000Z', images: ['workfluence-app:abc1234'] };

  it('쓴 것을 그대로 읽는다', () => {
    expect(parseManifest(formatManifest(m))).toEqual(m);
  });

  it('**무엇을 반입했는지가 나중에 유일한 단서다** — 버전과 sha가 반드시 있다', () => {
    expect(formatManifest(m)).toContain('abc1234');
    expect(formatManifest(m)).toContain('0.1.0');
    expect(() => parseManifest('version=0.1.0\n')).toThrow(/gitSha/);
  });
});

describe('필수 파일 목록 (FR-601)', () => {
  it('묶음이 갖춰야 할 것이 한 곳에 있다', () => {
    expect(RELEASE_REQUIRED_FILES).toContain('MANIFEST.txt');
    expect(RELEASE_REQUIRED_FILES).toContain('SHA256SUMS');
    expect(RELEASE_REQUIRED_FILES).toContain('compose.yml');
    expect(RELEASE_REQUIRED_FILES.length).toBeGreaterThan(5);
  });
});

describe('parseManifest — 모양이 어긋난 줄', () => {
  it('`=`가 없는 줄은 **무시한다** — 사람이 메모를 끼워 넣어도 매니페스트가 깨지지 않는다', () => {
    const text = formatManifest({ version: '0.1.0', gitSha: 'abc1234', builtAt: '2026-09-22T00:00:00.000Z', images: ['x:1'] });
    const m = parseManifest(`${text}\n이건 사람이 적은 메모다\n`);
    expect(m.version).toBe('0.1.0');
    expect(m.images).toEqual(['x:1']);
  });
});

describe('백업 대조 계약 (보안 검토 1)', () => {
  it('`BACKUP.json`이 필수 파일에 들어 있다 — 대조 근거를 담은 파일이 검사 밖에 있으면 안 된다', () => {
    expect(BACKUP_REQUIRED_FILES).toContain('BACKUP.json');
    expect(BACKUP_REQUIRED_FILES).toContain('dump.pgc');
    expect(BACKUP_REQUIRED_FILES).toContain('attachments.tar');
  });

  it('운영 정책·Crew·라벨도 대조 대상이다 — 조용히 비어 있으면 알 수 없는 표들이다', () => {
    for (const t of ['settings', 'space_members', 'labels', 'page_labels', 'space_categories', 'audit_events']) {
      expect(BACKUP_COUNTED_TABLES).toContain(t);
    }
    // 세션은 **일부러 뺀다.** 복원 뒤 달라지는 것이 정상이고, 남아 있으면 오히려 문제다
    expect(BACKUP_COUNTED_TABLES).not.toContain('sessions');
  });

  it('**표 이름에 SQL을 적어 넣으면 거부한다** — 모르는 이름은 통과하지 못한다', () => {
    const evil = { "users; DROP TABLE users; SELECT count(*) FROM users": 1 };
    expect(() => backupCounts(evil)).toThrow(/모르는 표 이름/);
  });

  it('**목록이 늘어난 뒤에도 예전 백업을 복원할 수 있다** — 없는 키는 대조하지 않는다', () => {
    const old = { users: 3, pages: 7 };
    expect(backupCounts(old)).toEqual(old);
  });

  it('대조할 것이 하나도 없으면 거부한다 — 빈 대조는 통과가 아니다', () => {
    expect(() => backupCounts({})).toThrow(/하나도 없다/);
  });

  it('행 수가 숫자가 아니면 거부한다 — NaN은 어떤 비교에도 false라 대조를 건너뛴다', () => {
    const base = Object.fromEntries(BACKUP_COUNTED_TABLES.map((t) => [t, 0]));
    for (const bad of ['1', null, undefined, 1.5, -1, {}, [1]]) {
      expect(() => backupCounts({ ...base, users: bad })).toThrow(/users/);
    }
  });

  it('정상 값은 그대로 돌려준다', () => {
    const base = Object.fromEntries(BACKUP_COUNTED_TABLES.map((t, i) => [t, i]));
    expect(backupCounts(base)).toEqual(base);
  });
});

describe('backupCounts의 빈 입력', () => {
  it('`null`·`undefined`도 "대조할 것이 없다"로 거부한다 — 조용히 통과하지 않는다', () => {
    expect(() => backupCounts(undefined)).toThrow(/하나도 없다/);
    expect(() => backupCounts(null)).toThrow(/하나도 없다/);
  });
});
