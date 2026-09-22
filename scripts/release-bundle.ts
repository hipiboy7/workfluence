import { RELEASE_REQUIRED_FILES, formatChecksums, formatManifest } from '@workfluence/shared';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 반입 묶음 (P5_설계서_Release B절, FR-600~609).
 *
 * **사람이 파일을 모으면 빠뜨린다.** 반입은 한 번에 한 묶음만 들어가고, 빠진 것이 있으면
 * 폐쇄망 안에서 되돌릴 방법이 없다 — 그래서 목록을 코드가 들고 있다.
 *
 * **인터넷을 쓰지 않는다** (FR-607). 이미 받아 둔 이미지와 설치된 의존성만 쓴다.
 */
const IMAGES = ['workfluence-app:latest', 'postgres:17', 'nginx:1.27-alpine'] as const;

const sh = (cmd: string, args: string[], capture = false): string => {
  const r = execFileSync(cmd, args, { maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
  return capture ? r.toString().trim() : '';
};

function main(): void {
  const out = resolve(process.argv[2] ?? join('.local', 'release', new Date().toISOString().slice(0, 10)));
  mkdirSync(out, { recursive: true });
  const gitSha = sh('git', ['rev-parse', '--short', 'HEAD'], true);
  const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
  console.log(`[release] ${out} — ${version} / ${gitSha}`);

  // 이미지 세 개를 **하나의 tar로** 묶는다. 셋을 따로 두면 하나만 빠뜨린 채 반입된다
  console.log('[release] 이미지 저장 중…');
  sh('docker', ['save', '-o', join(out, 'images.tar'), ...IMAGES]);

  copyFileSync('deploy/compose.yml', join(out, 'compose.yml'));
  copyFileSync('deploy/nginx.conf', join(out, 'nginx.conf'));
  copyFileSync('docs/운영가이드_반입.md', join(out, '반입절차.md'));

  // `.env` 템플릿에는 **값이 하나도 없다** (FR-606). 키와 설명만 간다
  const template = readFileSync('.env.example', 'utf8')
    .split('\n')
    .map((l) => (/^[A-Z_]+=/.test(l) ? `${l.split('=')[0]}=` : l))
    .join('\n');
  writeFileSync(join(out, 'env.template'), `# 폐쇄망에서 값을 채운다. 비어 있는 키는 기동 시 스키마가 잡는다\n${template}`);

  // SBOM·라이선스 — 설치된 의존성에서 만든다. 네트워크를 쓰지 않는다
  console.log('[release] SBOM 생성 중…');
  const licenses = JSON.parse(sh('pnpm', ['licenses', 'list', '--prod', '--json'], true)) as Record<
    string,
    { name: string; version: string; versions?: string[] }[]
  >;
  const components: { type: string; name: string; version: string; licenses: { license: { id: string } }[] }[] = [];
  const lines: string[] = [];
  for (const [license, pkgs] of Object.entries(licenses)) {
    for (const p of pkgs) {
      const v = p.versions?.[0] ?? p.version ?? '?';
      components.push({ type: 'library', name: p.name, version: v, licenses: [{ license: { id: license } }] });
      lines.push(`${license.padEnd(16)} ${p.name}@${v}`);
    }
  }
  writeFileSync(
    join(out, 'sbom.cdx.json'),
    JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, metadata: { component: { type: 'application', name: 'workfluence', version } }, components }, null, 2) + '\n',
  );
  writeFileSync(join(out, 'LICENSES.txt'), `workfluence ${version} (${gitSha}) — production 의존성 ${components.length}개\n\n${lines.sort().join('\n')}\n`);

  writeFileSync(join(out, 'MANIFEST.txt'), formatManifest({ version, gitSha, builtAt: new Date().toISOString(), images: [...IMAGES] }));

  // 체크섬은 **마지막에**. SHA256SUMS 자신은 목록에 넣지 않는다
  const files = readdirSync(out).filter((f) => f !== 'SHA256SUMS');
  writeFileSync(
    join(out, 'SHA256SUMS'),
    formatChecksums(files.sort().map((f) => ({ file: f, sha256: createHash('sha256').update(readFileSync(join(out, f))).digest('hex') }))),
  );

  const missing = RELEASE_REQUIRED_FILES.filter((f) => !readdirSync(out).includes(f));
  if (missing.length) throw new Error(`묶음에 빠진 것이 있다: ${missing.join(', ')}`);

  const bytes = readdirSync(out).reduce((n, f) => n + statSync(join(out, f)).size, 0);
  console.log(`[release] 완료 — ${readdirSync(out).length}개 파일 · ${(bytes / 1024 / 1024).toFixed(0)}MB`);
  console.log(`[release] 반입 직전·직후에 'pnpm release:verify ${out}'를 돌린다`);
}

main();
