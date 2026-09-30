import { DOCKER_BUNDLE_RPMS, DOCKER_KEY_FINGERPRINT, dockerKeyProblem, formatChecksums, formatPackages, rpmSignatureProblems } from '@workfluence/shared';
import type { ChecksumEntry, PackageRow } from '@workfluence/shared';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Docker 설치 묶음 (P20_설계서_Install D절, FR-2101 — 리눅스빌드 가이드 12-1절). 대상 RHEL 9 서버에 Docker가 없을 때만 들고 간다.
 *
 * 이 서버에 **깔린 판**의 RPM을 받는다 — 반입 묶음의 이미지를 이 판으로 만들고 띄워 봤기 때문이다. **아무것도 설치하지 않는다**(`dnf download`는
 * 파일만 받는다). 판정은 공유 `release.ts`가 한다 — 키 파일은 키 하나와 그 지문, 서명은 RPM마다 `digests signatures OK`.
 *
 * **어느 단계든 틀리면 까닭을 말하고 종료 코드 1로 멈춘다.** 처음 판(가이드에 적은 셸 명령)은 깔리지 않은 패키지의 `package … is not installed`를
 * 그대로 `dnf download`에 넘기고, 파일이 빠져도 부분 지문 목록으로 쌌다 — 현장의 `sha256sum -c`는 그것을 `OK`라고 한다(병합 전 자체 점검 8).
 */

/** Docker의 RHEL 저장소가 내놓는 공개키 — 묶음에 넣어 현장이 같은 키로 서명을 본다(반입 가이드 0.3절 ②) */
const DOCKER_KEY_URL = 'https://download.docker.com/linux/rhel/gpg';
/** 이 서버의 Red Hat 키 — Red Hat 부품의 서명을 본다. RHEL의 `redhat-release` 패키지가 둔다 */
const RED_HAT_KEY = '/etc/pki/rpm-gpg/RPM-GPG-KEY-redhat-release';
const RELEASE_FILE = '/etc/redhat-release';
const NEVRA = '%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}\n';
/** 자식 명령의 출력(`is not installed`·`digests signatures OK`)을 글자 그대로 판정하려고 영어로 돌린다 — 이 서버가 한국어 로캘이어도 같다 */
const ENV = { ...process.env, LC_ALL: 'C.UTF-8' };

/** 만든 임시 자리 — 멈출 때도 지운다(`process.exit`는 `finally`를 건너뛴다 — 반영분의 좁은 자체 점검 4) */
const temps: string[] = [];

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

function cleanTemps(): void {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
}

function fail(msg: string): never {
  cleanTemps();
  console.error(`[docker] 멈춘다 — ${msg}`);
  process.exit(1);
}

/** 명령을 돌려 표준 출력을 돌려준다. `allowFail`이면 종료 코드가 0이 아니어도 돌려준다 — `rpm -K`는 서명이 틀리면 1이지만 판정은 출력이 한다 */
function run(cmd: string, args: string[], allowFail = false): string {
  const r = spawnSync(cmd, args, { env: ENV, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.error) fail(`${cmd}를 돌리지 못했다 — ${r.error.message}`);
  if (r.status !== 0 && !allowFail) fail(`${cmd} ${args.join(' ')} — 종료 코드 ${r.status}`);
  return r.stdout;
}

/** 이 서버에 깔린 판(NEVRA). **하나라도 없으면 멈춘다** — 없는 것을 받을 수는 없다 */
function installed(names: readonly string[]): string[] {
  const lines = run('rpm', ['-q', '--qf', NEVRA, ...names], true)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const missing = lines.filter((l) => l.endsWith(' is not installed'));
  if (missing.length) fail(`이 서버에 깔려 있지 않다 — ${missing.join(' · ')} (Docker CE를 Docker의 RHEL 저장소로 깐 서버에서 만든다, 리눅스빌드 가이드 1절)`);
  if (lines.length !== names.length) fail(`rpm -q가 ${names.length}줄 대신 ${lines.length}줄을 냈다 — ${lines.join(' · ')}`);
  return lines;
}

/** 받는다. **받은 파일이 기대한 것과 하나라도 다르면 멈춘다**(아키텍처까지 적어 i686이 섞이지 않게 한다 — T-096) */
function download(dir: string, nevras: readonly string[]): string[] {
  mkdirSync(dir, { recursive: true });
  run('dnf', ['download', '-q', '--destdir', dir, ...nevras]);
  const got = readdirSync(dir).filter((f) => f.endsWith('.rpm')).sort();
  const want = nevras.map((n) => `${n}.rpm`).sort();
  if (got.join('\n') !== want.join('\n')) fail(`받은 RPM이 다르다 — 기대 ${want.join(' · ')} / 받음 ${got.join(' · ')}`);
  return want;
}

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

function main(): void {
  const release = readFileSync(RELEASE_FILE, 'utf8').trim();
  const name = `docker-rhel9-${new Date().toISOString().slice(0, 10)}`;
  const root = join('.local', 'release');
  const out = join(root, name);
  console.log(`[docker] 이 서버: ${release}`);

  const top = installed(DOCKER_BUNDLE_RPMS.top);
  const deps = installed(DOCKER_BUNDLE_RPMS.deps);
  console.log(`[docker] 판 — ${top.join(' · ')}`);
  console.log(`[docker] deps/ — ${deps.join(' · ')}`);

  // 앞 실행의 것을 모두 치운다 — 디렉토리만 지우면 옛 tar와 지문이 서로 맞는 채 남아, 이번 실행이 멈춰도 옛 묶음을 들고 가게 된다(좁은 자체 점검 4)
  const tar = join(root, `${name}.tar`);
  for (const f of [out, tar, `${tar}.sha256`]) rmSync(f, { recursive: true, force: true });
  const topFiles = download(out, top);
  const depFiles = download(join(out, 'deps'), deps).map((f) => `deps/${f}`);
  const rpms = [...topFiles, ...depFiles];

  // 키 — **키가 하나이고 그 지문이 Docker의 것**(첫 키만 보면 키를 더 붙인 파일이 지나간다 — 보안 검토 S1)
  const key = join(out, 'docker-ce.gpg');
  run('curl', ['-fsS', '-o', key, DOCKER_KEY_URL]);
  const home = tempDir('wf-gpg-');
  const colons = run('gpg', ['--homedir', home, '--quiet', '--batch', '--show-keys', '--with-colons', key]);
  const keyProblem = dockerKeyProblem(colons);
  if (keyProblem) fail(keyProblem);
  console.log(`[docker] 키 — 하나, 지문 ${DOCKER_KEY_FINGERPRINT}`);

  // 서명 — **임시 RPM DB**로 본다(이 서버의 설정에 아무것도 남기지 않는다). 서명이 없는 RPM(`digests OK`)도 거절한다(보안 검토 S1)
  const db = tempDir('wf-rpmdb-');
  run('rpm', ['--dbpath', db, '--import', key, RED_HAT_KEY]);
  const paths = rpms.map((f) => join(out, f));
  const problems = rpmSignatureProblems(run('rpm', ['--dbpath', db, '-K', ...paths], true), paths);
  cleanTemps();
  if (problems.length) fail(`서명이 맞지 않는다\n  ${problems.join('\n  ')}`);
  console.log(`[docker] 서명 — ${paths.length}/${paths.length} digests signatures OK (임시 RPM DB)`);

  // 부품 목록 — 첫 줄은 이 서버의 RHEL 판(현장이 `deps/`를 쓸지 정한다), 다음부터 판·라이선스·만든 곳(CLAUDE.md 7절의 라이선스 목록)
  const rows: PackageRow[] = rpms.map((f) => {
    const [license = '', vendor = ''] = run('rpm', ['-qp', '--nosignature', '--qf', '%{LICENSE}\t%{VENDOR}', join(out, f)]).split('\t');
    return { file: f, license, vendor };
  });
  writeFileSync(join(out, 'PACKAGES.txt'), formatPackages(release, rows));

  const sums: ChecksumEntry[] = [...rpms, 'docker-ce.gpg', 'PACKAGES.txt'].map((f) => ({ file: f, sha256: sha256(join(out, f)) }));
  writeFileSync(join(out, 'SHA256SUMS'), formatChecksums(sums));

  // 반입 묶음과 같은 모양 — 맨 위 디렉토리 하나(반입 가이드 0.3절 ①이 그 한 겹을 벗겨 푼다). 파일 주인은 숫자 0으로 — 만든 계정의 이름이 묶음에 남지 않게
  run('tar', ['--owner=0', '--group=0', '--numeric-owner', '-cf', tar, '-C', root, name]);
  const first = run('tar', ['-tf', tar]).split('\n')[0];
  if (first !== `${name}/`) fail(`tar의 첫 줄이 ${name}/가 아니다 — ${first}`);
  const digest = sha256(tar);
  writeFileSync(`${tar}.sha256`, `${digest}  ${name}.tar\n`);

  console.log(`[docker] 완료 — ${tar} · ${(statSync(tar).size / 1024 / 1024).toFixed(0)}MB · RPM ${topFiles.length} + deps/ ${depFiles.length}`);
  console.log(`[docker] 지문 — ${digest}  ${name}.tar (반입 신청서처럼 매체와 따로 가는 기록에도 적는다 — 반입 가이드 0.1절)`);
}

main();
