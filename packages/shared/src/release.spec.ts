import { describe, expect, it } from 'vitest';
import {
  BACKUP_COUNTED_TABLES,
  BACKUP_REQUIRED_FILES,
  DOCKER_BUNDLE_RPMS,
  DOCKER_KEY_FINGERPRINT,
  RELEASE_REQUIRED_FILES,
  backupCounts,
  dockerKeyProblem,
  formatChecksums,
  formatManifest,
  formatPackages,
  parseChecksums,
  parseManifest,
  rpmSignatureProblems,
  unlistedRequired,
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

  it('**운영 문서가 묶음에 있다** — 폐쇄망에서는 저장소를 열 수 없고, 반입 가이드가 운영 가이드의 절을 가리킨다 (P13 FR-1402)', () => {
    for (const doc of ['docs/운영가이드_반입.md', 'docs/운영가이드_운영이관.md', 'docs/운영가이드_장애대응.md', 'docs/사용자가이드_사용법.md', 'docs/학습가이드_시스템이해.md']) {
      expect(RELEASE_REQUIRED_FILES, doc).toContain(doc);
    }
    // 맨 위의 반입 절차는 그대로 — 받는 사람이 처음 여는 파일이다
    expect(RELEASE_REQUIRED_FILES).toContain('반입절차.md');
  });

  it('**사내 CA 자리(`ca/README.md`)가 묶음에 있다** — 없으면 첫 기동에서 도커가 `ca/`를 root 소유로 만들어, 현장에서 인증서를 넣을 때 `Permission denied`다 (P11 검토)', () => {
    expect(RELEASE_REQUIRED_FILES).toContain('ca/README.md');
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

/**
 * **목록에 없는 것이 통과하는 검사는 검사하지 않는 것과 구분되지 않는다.**
 *
 * 체크섬 검사는 "적힌 것"만 본다. 그래서 `SHA256SUMS`가 비어 있으면 아무것도 검사하지
 * 않고 통과했다 — 반입 검사가 `필수 9개 · 체크섬 0개 일치`로 종료 코드 0을 냈다.
 */
describe('unlistedRequired (코드 리뷰 1)', () => {
  const sums = [{ file: 'a.tar', sha256: 'a'.repeat(64) }];

  it('체크섬 목록이 비어 있으면 필수 파일 전부를 올린다', () => {
    expect(unlistedRequired([], ['a.tar', 'b.txt'])).toEqual(['a.tar: 체크섬 목록에 없다', 'b.txt: 체크섬 목록에 없다']);
  });

  it('목록에 있는 것은 올리지 않는다', () => {
    expect(unlistedRequired(sums, ['a.tar'])).toEqual([]);
  });

  it('일부만 빠져도 그것만 올린다 — **잘린 체크섬 파일이 이 모양이다**', () => {
    expect(unlistedRequired(sums, ['a.tar', 'b.txt'])).toEqual(['b.txt: 체크섬 목록에 없다']);
  });

  it('필수 목록이 비면 올릴 것이 없다', () => {
    expect(unlistedRequired(sums, [])).toEqual([]);
  });
});

describe('verifyChecksums가 이상한 파일 이름에 터지지 않는다 (코드 리뷰 11)', () => {
  it('`__proto__`·`constructor` 같은 이름도 "묶음에 없다"로 말한다', () => {
    for (const name of ['__proto__', 'constructor', 'toString']) {
      const out = verifyChecksums([{ file: name, sha256: 'a'.repeat(64) }], {});
      expect(out).toEqual([`${name}: 묶음에 없다`]);
    }
  });
});

/**
 * Docker 설치 묶음 (P20_설계서_Install D절, FR-2101) — 대상 RHEL 9 서버에 Docker가 없을 때만 들고 간다.
 * 현장에는 Node가 없어 반입 가이드 0.3절 ②는 같은 판정을 셸 한 줄씩으로 한다 — 여기는 묶음을 **만드는 쪽**의 판정이다.
 */
describe('Docker 묶음에 싣는 RPM (FR-2101)', () => {
  it('맨 위는 Docker의 넷과 Docker가 늘 요구하는 container-selinux다', () => {
    expect([...DOCKER_BUNDLE_RPMS.top].sort()).toEqual(
      ['container-selinux', 'containerd.io', 'docker-ce', 'docker-ce-cli', 'docker-compose-plugin'].sort(),
    );
  });

  it('**`deps/`는 firewalld가 없는 서버에 모자란 넷이다** — 처음 판은 모든 서버에 이미 있는 셋을 골랐다(병합 전 자체 점검 1)', () => {
    expect([...DOCKER_BUNDLE_RPMS.deps].sort()).toEqual(['iptables-nft', 'jansson', 'libnftnl', 'nftables'].sort());
    for (const gone of ['iptables-libs', 'libnetfilter_conntrack', 'libnfnetlink']) {
      expect(DOCKER_BUNDLE_RPMS.deps as readonly string[]).not.toContain(gone);
    }
  });

  it('두 자리에 같은 이름이 없다', () => {
    const top = new Set<string>(DOCKER_BUNDLE_RPMS.top);
    expect(DOCKER_BUNDLE_RPMS.deps.filter((n) => top.has(n))).toEqual([]);
  });
});

describe('dockerKeyProblem — 묶음의 키 파일 (병합 전 보안 검토 S1)', () => {
  const fpr = DOCKER_KEY_FINGERPRINT.replace(/\s+/g, '');
  const pub = 'pub:-:4096:1:C52FEB6B621E9F35:1487791233:::-:::escaESCA::::::23::0:';
  const uid = 'uid:-::::1487792760::0000::Docker Release (CE rpm) <docker@docker.com>::::::::::0:';
  const one = [pub, `fpr:::::::::${fpr}:`, uid, ''].join('\n');

  it('키가 하나이고 그 지문이 Docker의 것이면 통과(null)', () => {
    expect(dockerKeyProblem(one)).toBeNull();
  });

  it('지문은 gpg가 사람에게 보이는 모양(네 자리씩 띄어 쓴 것) 그대로 적혀 있다 — 공백을 빼면 40자다', () => {
    expect(fpr).toMatch(/^[0-9A-F]{40}$/);
  });

  it('**키를 하나 더 붙인 파일은 거절한다** — 첫 키의 지문만 보면 통과하는데 `rpm --import`는 키를 전부 들인다', () => {
    const two = one + [pub.replace('C52FEB6B621E9F35', 'A'.repeat(16)), `fpr:::::::::${'A'.repeat(40)}:`, ''].join('\n');
    expect(dockerKeyProblem(two)).toMatch(/2개/);
  });

  it('지문이 다르면 거절한다', () => {
    const other = [pub, `fpr:::::::::${'B'.repeat(40)}:`, uid, ''].join('\n');
    expect(dockerKeyProblem(other)).toMatch(/지문/);
  });

  it('부속 키의 지문(`sub` 뒤의 `fpr`)은 보지 않는다 — 주 키의 지문이 판정한다', () => {
    const withSub = [pub, `fpr:::::::::${fpr}:`, uid, 'sub:-:4096:1:1111222233334444:1487791233::::::e::::::23:', `fpr:::::::::${'C'.repeat(40)}:`, ''].join('\n');
    expect(dockerKeyProblem(withSub)).toBeNull();
  });

  it('키가 없으면(빈 출력·키 파일이 아니다) 거절한다 — 판정할 것이 없는 것은 통과가 아니다', () => {
    expect(dockerKeyProblem('')).toMatch(/없다/);
    expect(dockerKeyProblem('garbage\n')).toMatch(/없다/);
  });

  it('소문자로 적힌 지문도 같은 키로 본다', () => {
    expect(dockerKeyProblem(one.replace(fpr, fpr.toLowerCase()))).toBeNull();
  });
});

describe('rpmSignatureProblems — `rpm -K`의 판정 (병합 전 보안 검토 S1)', () => {
  const files = ['a.rpm', 'deps/b.rpm'];
  const ok = (f: string) => `${f}: digests signatures OK`;

  it('RPM마다 `digests signatures OK` 한 줄이면 통과(빈 목록)', () => {
    expect(rpmSignatureProblems([ok('a.rpm'), ok('deps/b.rpm'), ''].join('\n'), files)).toEqual([]);
  });

  it('**서명이 없는 RPM(`digests OK`)을 거절한다** — 종료 코드 0이고 `NOT OK`도 없어, `NOT OK`를 찾는 판정은 통과시킨다', () => {
    const out = rpmSignatureProblems([ok('a.rpm'), 'deps/b.rpm: digests OK', ''].join('\n'), files);
    expect(out).toEqual(['deps/b.rpm: 서명이 맞지 않는다 (digests OK)']);
  });

  it('서명이 틀리거나 키가 없으면(`SIGNATURES NOT OK`) 거절한다', () => {
    const out = rpmSignatureProblems(['a.rpm: digests SIGNATURES NOT OK', ok('deps/b.rpm'), ''].join('\n'), files);
    expect(out).toEqual(['a.rpm: 서명이 맞지 않는다 (digests SIGNATURES NOT OK)']);
  });

  it('**결과가 없는 RPM도 거절한다** — 보지 않은 것은 통과가 아니다', () => {
    expect(rpmSignatureProblems(ok('a.rpm') + '\n', files)).toEqual(['deps/b.rpm: 서명 결과가 없다']);
    expect(rpmSignatureProblems('', files)).toEqual(['a.rpm: 서명 결과가 없다', 'deps/b.rpm: 서명 결과가 없다']);
  });

  it('목록 밖의 줄(오류 문장 등)도 문제로 올린다', () => {
    const out = rpmSignatureProblems([ok('a.rpm'), ok('deps/b.rpm'), 'error: c.rpm: not an rpm package', ''].join('\n'), files);
    expect(out).toEqual(['error: c.rpm: not an rpm package']);
  });

  it('줄 끝의 공백·CR은 판정에 끼지 않는다', () => {
    expect(rpmSignatureProblems(`${ok('a.rpm')}  \r\n${ok('deps/b.rpm')}\r\n`, files)).toEqual([]);
  });
});

describe('formatPackages — 묶음의 부품 목록 PACKAGES.txt (FR-2101)', () => {
  const release = 'Red Hat Enterprise Linux release 9.6 (Plow)';
  const rows = [
    { file: 'docker-ce-29.6.1-1.el9.x86_64.rpm', license: 'Apache-2.0', vendor: 'Docker' },
    { file: 'deps/nftables-1.0.9-3.el9.x86_64.rpm', license: 'GPLv2', vendor: 'Red Hat, Inc.' },
  ];

  it('**첫 줄은 묶음을 만든 서버의 RHEL 판 그대로다** — 현장이 `cat /etc/redhat-release`와 견준다(반입 가이드 0.3절 ④)', () => {
    expect(formatPackages(release, rows).split('\n')[0]).toBe(release);
  });

  it('RPM마다 파일·라이선스·만든 곳을 탭으로 가른 한 줄이고, 끝은 줄바꿈이다', () => {
    expect(formatPackages(release, rows)).toBe(
      `${release}\ndocker-ce-29.6.1-1.el9.x86_64.rpm\tApache-2.0\tDocker\ndeps/nftables-1.0.9-3.el9.x86_64.rpm\tGPLv2\tRed Hat, Inc.\n`,
    );
  });

  it('판이 한 줄이 아니거나 비었으면, 또는 RPM이 없으면 거절한다', () => {
    expect(() => formatPackages('a\nb', rows)).toThrow(/판/);
    expect(() => formatPackages('  ', rows)).toThrow(/판/);
    expect(() => formatPackages(release, [])).toThrow(/RPM/);
  });

  it('칸에 탭·줄바꿈이 들어 있으면 거절한다 — 한 줄에 한 RPM이라는 모양이 깨진다', () => {
    expect(() => formatPackages(release, [{ ...rows[0], license: 'GPL\tv2' }])).toThrow(/칸/);
    expect(() => formatPackages(release, [{ ...rows[0], vendor: 'Red\nHat' }])).toThrow(/칸/);
  });
});
