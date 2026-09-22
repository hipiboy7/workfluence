/**
 * 반입 묶음의 형식 (A등급, P5_설계서_Release D절, FR-601~604).
 *
 * 순수 함수다 — 파일을 읽지 않는다. 읽고 쓰는 것은 스크립트가 하고, **무엇이 올바른
 * 형식인가**만 여기서 정한다. 반입 심사에서 이 판정이 틀리면 손상된 묶음을 통과시킨다.
 */

export type ChecksumEntry = { file: string; sha256: string };

/**
 * 묶음이 반드시 갖춰야 할 것 (FR-601). **사람이 모으면 빠뜨린다.**
 *
 * `images.tar`가 **빠져 있었다.** 가장 중요한 파일인데 체크섬 목록에 우연히 들어 있는
 * 것으로만 간접 확인됐다 — 체크섬을 만드는 쪽이 파일을 못 찾아 건너뛰면 필수 검사도
 * 같이 조용해진다. 있어야 하는 것은 **있어야 한다고 적어 두는 쪽**에서 판정한다.
 */
export const RELEASE_REQUIRED_FILES = [
  'MANIFEST.txt',
  'SHA256SUMS',
  'images.tar',
  'compose.yml',
  'nginx.conf',
  'env.template',
  'sbom.cdx.json',
  'LICENSES.txt',
  '반입절차.md',
] as const;

/**
 * 백업 묶음이 반드시 갖춰야 할 것. **`BACKUP.json`이 여기 들어 있는 것이 중요하다.**
 *
 * 예전에는 체크섬을 `dump.pgc`·`attachments.tar`에만 걸고 `BACKUP.json`은 그 뒤에 썼다.
 * 그 파일은 **대조 근거**(표별 행 수)를 담는데 정작 무결성 검사 밖에 있었다 —
 * 근거를 담은 파일을 검사하지 않으면 대조 자체가 의미를 잃는다.
 */
export const BACKUP_REQUIRED_FILES = ['dump.pgc', 'attachments.tar', 'BACKUP.json'] as const;

/**
 * 백업이 행 수를 세는 표 — **목록은 여기 한 곳에만 있다.**
 *
 * 예전에는 백업이 이 목록을 코드에 적고, 복원은 **`BACKUP.json`의 키에서 읽어** 그것을
 * SQL에 그대로 넣었다. 백업 파일을 고칠 수 있는 사람(백업 공유 폴더·반입 매체)이 키 이름에
 * SQL을 적어 넣으면 **복원할 때 DB 관리자 권한으로 실행된다.** 표 이름 같은 식별자는
 * 파일에서 오면 안 된다 — 우리가 정한 목록에서만 온다.
 *
 * 순서는 의미가 없다. **여기 없는 표는 대조되지 않는다** — `pg_dump`는 전부 담지만
 * "복원 뒤에 그대로인지"를 확인하지 않으므로, 조용히 비어 있어도 알 수 없다.
 * `sessions`만 일부러 뺐다. 복원 뒤 달라지는 것이 정상이고, 오히려 남아 있으면
 * 옛 세션이 되살아나는 것이라 대조 대상이 아니다.
 */
export const BACKUP_COUNTED_TABLES = [
  'users',
  'spaces',
  'space_members',
  'space_categories',
  'pages',
  'page_versions',
  'attachments',
  'comments',
  'labels',
  'page_labels',
  'audit_events',
  'notifications',
  'settings',
] as const;

/**
 * **필수 파일이 체크섬 목록에 올라 있는지** 본다.
 *
 * 체크섬 검사는 "목록에 적힌 것"만 본다. 그래서 `SHA256SUMS`가 **비어 있으면 아무것도
 * 검사하지 않고 통과한다** — 옮기다 잘린 체크섬 파일은 그 줄들을 잃은 채 통과한다.
 * 실제로 `release-verify`가 `필수 9개 · 체크섬 0개 일치`로 종료 코드 0을 낼 수 있었다.
 *
 * **목록에 없는 것이 통과하는 검사는 검사하지 않는 것과 구분되지 않는다** (T-029와 같은 판단).
 */
export function unlistedRequired(expected: readonly ChecksumEntry[], required: readonly string[]): string[] {
  const listed = new Set(expected.map((e) => e.file));
  return required.filter((f) => !listed.has(f)).map((f) => `${f}: 체크섬 목록에 없다`);
}

/**
 * `BACKUP.json`에서 읽은 행 수를 **숫자로만** 받는다.
 *
 * 숫자가 아니면 `NaN`이 되고, `NaN`은 어떤 비교에도 `false`라서 **"모자라다"도 "넘친다"도
 * 아닌 것이 되어 대조를 통째로 건너뛴다.** 조용히 통과하는 길을 막는다.
 */
export function backupCounts(raw: unknown): Record<string, number> {
  const src = (raw ?? {}) as Record<string, unknown>;
  const known = new Set<string>(BACKUP_COUNTED_TABLES);
  const out: Record<string, number> = {};

  // **모르는 이름은 거부한다.** 이것이 주입을 막는 곳이다 — 통과한 이름만 질의에 쓰인다
  for (const k of Object.keys(src)) {
    if (!known.has(k)) throw new Error(`BACKUP.json에 모르는 표 이름이 있다: ${JSON.stringify(k)}`);
  }

  // **없는 키는 대조하지 않는다.** 표 목록이 늘어난 뒤에도 예전 백업을 복원할 수 있어야
  // 한다 — 여기서 실패시키면 "되살릴 수 있었던 백업"을 못 쓰게 만든다. 대조가 좁아지는
  // 것은 조용한 실패가 아니다: 복원이 무엇을 대조했는지 출력한다
  for (const t of BACKUP_COUNTED_TABLES) {
    if (!(t in src)) continue;
    const v = src[t];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      throw new Error(`BACKUP.json의 ${t} 행 수가 숫자가 아니다: ${JSON.stringify(v)}`);
    }
    out[t] = v;
  }
  if (Object.keys(out).length === 0) throw new Error('BACKUP.json에 대조할 행 수가 하나도 없다');
  return out;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** `sha256sum`과 같은 서식으로 쓴다 — 우리 도구가 없어도 표준 도구로 검사할 수 있어야 한다 */
export function formatChecksums(entries: readonly ChecksumEntry[]): string {
  return entries.map((e) => `${e.sha256}  ${e.file}`).join('\n') + '\n';
}

/**
 * 읽는다. **서식이 깨진 줄은 조용히 넘기지 않는다** — 검사 파일이 상했는데 검사가
 * 통과하면 검사가 있는 것이 없는 것보다 나쁘다.
 */
export function parseChecksums(text: string): ChecksumEntry[] {
  const out: ChecksumEntry[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([0-9a-f]+)\s+(.+)$/.exec(line);
    if (!m || !SHA256.test(m[1])) throw new Error(`체크섬 파일 ${i + 1}번째 줄의 서식이 잘못됐다: ${line}`);
    out.push({ file: m[2], sha256: m[1] });
  }
  return out;
}

/**
 * 대조. 돌려주는 것은 **사람이 읽을 문제 목록**이고, 비었으면 통과다.
 *
 * 목록에 없는 파일이 더 있는 것은 문제가 아니다(절차서·README가 함께 온다).
 * **목록에 있는데 없는 것은 문제다** — 반입이 불완전하다는 뜻이다.
 */
export function verifyChecksums(expected: readonly ChecksumEntry[], actual: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const e of expected) {
    // **`Object.hasOwn`으로 본다.** 이름이 `__proto__`·`constructor`인 줄이 있으면 평범한
    // 객체에서 **상속된 값**이 잡혀 `undefined`가 아니게 되고, 그 뒤 `.slice`에서 터진다.
    // 이 입력은 반입 매체에서 온다 — 터지는 것보다 "묶음에 없다"로 말하는 것이 맞다
    const got = Object.hasOwn(actual, e.file) ? actual[e.file] : undefined;
    if (typeof got !== 'string') problems.push(`${e.file}: 묶음에 없다`);
    else if (got !== e.sha256) problems.push(`${e.file}: 체크섬이 다르다 (기대 ${e.sha256.slice(0, 12)}…, 실제 ${got.slice(0, 12)}…)`);
  }
  return problems;
}

export type Manifest = { version: string; gitSha: string; builtAt: string; images: string[] };

const MANIFEST_KEYS = ['version', 'gitSha', 'builtAt'] as const;

export function formatManifest(m: Manifest): string {
  return [
    '# workfluence 반입 묶음',
    `version=${m.version}`,
    `gitSha=${m.gitSha}`,
    `builtAt=${m.builtAt}`,
    ...m.images.map((i) => `image=${i}`),
    '',
  ].join('\n');
}

/** **버전과 sha가 없으면 거부한다.** 무엇을 반입했는지가 나중에 유일한 단서다 (FR-603) */
export function parseManifest(text: string): Manifest {
  const kv: Record<string, string> = {};
  const images: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i);
    const value = line.slice(i + 1);
    if (key === 'image') images.push(value);
    else kv[key] = value;
  }
  for (const k of MANIFEST_KEYS) {
    if (!kv[k]) throw new Error(`매니페스트에 ${k}가 없다`);
  }
  return { version: kv.version, gitSha: kv.gitSha, builtAt: kv.builtAt, images };
}
