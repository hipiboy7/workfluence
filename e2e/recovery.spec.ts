import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { cleanup, createAdmin, createMember, newAdmin } from './fixtures';

/**
 * **Phase 19 인수 기준 — 비밀번호를 잊었을 때** (P19_설계서_Recovery B.1·C.1, F-011). "비밀번호 찾기에서 표시 이름과 가입할 때 넣은 email을 적고 내 email로
 * 재설정 링크 받기를 누르면 그 email로 링크가 가고, 30분 안에 한 번 열어 새 비밀번호를 정하면 그 비밀번호로 로그인된다. email 칸 옆의 이메일이 기억이
 * 안나시나요?에서 아이디와 이름을 보내면 시스템 관리자의 알림에 확인 요청이 온다."
 *
 * **가짜 사내 메일 서버를 이 시험이 띄운다**(`E2E_MAIL_PORT`, 기본 3199 — 사용자가 준 사내 API의 모양, P18). 앱은 **메일을 켠 채** 떠 있어야 한다 —
 * `WF_MAIL_ENABLED=true` · `WF_MAIL_MOCK=false` · `WF_MAIL_API_URL=http://127.0.0.1:3199/api/v1/email/send` · `WF_PUBLIC_URL`(아무 주소 — 시험은 링크의 값만
 * 쓴다). 아니면 첫 단정이 그 까닭으로 실패한다 — 건너뛰지 않는다(`CLAUDE.md` 1.3절 "skip은 통과가 아니다")
 */
const MAIL_PORT = Number(process.env.E2E_MAIL_PORT ?? 3199);
const stamp = Date.now();
const member = { username: `e2e-reset-${stamp}`, displayName: `E2E 재설정${stamp}`, email: `e2e-reset-${stamp}@example.internal`, password: 'E2e-Reset-2026!' };
const ROOT = newAdmin('recovery-root');

type Mail = { subject: string; content: string; receivers: string; sender_name: string };
const mails: Mail[] = [];
let server: Server;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      if (req.method === 'POST' && req.url?.startsWith('/api/v1/email/send')) mails.push(JSON.parse(body) as Mail);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"message":"Email sent successfully"}');
    });
  });
  await new Promise<void>((ok) => server.listen(MAIL_PORT, '127.0.0.1', ok));
  await createMember(member);
  await createAdmin(ROOT, 'root');
});
test.afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  await cleanup([member.username, ROOT.username]);
});

test('내 email로 재설정 링크를 받아 새 비밀번호를 정하면 그 비밀번호로 로그인된다 — 링크는 한 번만', async ({ page, request }) => {
  const config = (await (await request.get('/api/auth/config')).json()) as { resetMailEnabled: boolean };
  expect(config.resetMailEnabled, `앱을 메일을 켠 채 띄운다 — WF_MAIL_ENABLED=true, WF_MAIL_MOCK=false, WF_MAIL_API_URL=http://127.0.0.1:${MAIL_PORT}/api/v1/email/send, WF_PUBLIC_URL`).toBe(true);

  await page.goto('/find-account');
  const form = page.locator('form').filter({ has: page.getByRole('heading', { name: '비밀번호 찾기' }) });
  await form.getByLabel('이름').fill(member.displayName);
  await form.getByLabel('email').fill(member.email);
  await form.getByRole('button', { name: '내 email로 재설정 링크 받기' }).click();
  await expect(form.getByText('요청을 받았다', { exact: false })).toBeVisible();

  // 그 계정의 email로 한 통 — 제목과 링크
  await expect.poll(() => mails.filter((m) => m.receivers === member.email).length, { timeout: 15_000 }).toBe(1);
  const mail = mails.find((m) => m.receivers === member.email)!;
  expect(mail.subject).toBe('[위키] 비밀번호 재설정');
  const token = /#t=([A-Za-z0-9_-]{43})/.exec(mail.content)?.[1] ?? '';
  expect(token).toHaveLength(43);

  // 링크를 연다 — 값은 읽자마자 주소에서 사라진다
  await page.goto(`/reset-password#t=${token}`);
  await expect(page.getByRole('heading', { name: '새 비밀번호 정하기' })).toBeVisible();
  await expect(page).toHaveURL(/\/reset-password$/);
  const next = 'E2e-Reset-New-2026!';
  await page.getByLabel('새 비밀번호', { exact: true }).fill(next);
  await page.getByLabel('새 비밀번호 확인', { exact: true }).fill(next);
  await page.getByRole('button', { name: '새 비밀번호로 정하기' }).click();
  await expect(page.getByText('새 비밀번호를 정했다', { exact: false })).toBeVisible();

  // 옛 비밀번호로는 안 되고 새 비밀번호로 된다
  await page.getByRole('link', { name: '로그인으로' }).first().click();
  await page.getByLabel('아이디').fill(member.username);
  await page.getByLabel('비밀번호').fill(member.password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('비밀번호').fill(next);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.getByRole('button', { name: '로그아웃' }).click();

  // 같은 링크는 한 번만
  await page.goto(`/reset-password#t=${token}`);
  await page.getByLabel('새 비밀번호', { exact: true }).fill('E2e-Reset-Again-2026!');
  await page.getByLabel('새 비밀번호 확인', { exact: true }).fill('E2e-Reset-Again-2026!');
  await page.getByRole('button', { name: '새 비밀번호로 정하기' }).click();
  await expect(page.getByRole('alert')).toContainText('링크가 맞지 않거나 기한이 지났다');
});

test('이메일이 기억이 안나시나요? — 아이디와 이름을 보내면 시스템 관리자의 알림에 확인 요청이 온다', async ({ page }) => {
  await page.goto('/find-account');
  await page.getByRole('link', { name: '이메일이 기억이 안나시나요?' }).click();
  await expect(page).toHaveURL(/\/find-account\/email$/);
  await expect(page.getByText(/시스템 관리자에게 확인을 요청/)).toBeVisible();
  await page.getByLabel('아이디').fill(member.username);
  await page.getByLabel('이름').fill(member.displayName);
  await page.getByRole('button', { name: '시스템 관리자에게 확인 요청' }).click();
  await expect(page.getByText('요청을 보냈다', { exact: false })).toBeVisible();

  await page.goto('/login');
  await page.getByLabel('아이디').fill(ROOT.username);
  await page.getByLabel('비밀번호').fill(ROOT.password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).not.toHaveURL(/\/login/);
  const said = `${member.displayName} (${member.username})님의 아이디·이름으로 email 확인이 요청됐다`;
  const bell = page.getByRole('button', { name: /^알림 — 안 읽은 것 \d+건$/ });
  await expect(bell).toBeVisible({ timeout: 35_000 });
  await bell.click();
  const item = page.getByRole('region', { name: '최근 알림' }).getByRole('listitem').filter({ hasText: said });
  await expect(item).toBeVisible();
  await item.getByRole('link', { name: '사용자 관리에서 보기' }).click();
  await expect(page).toHaveURL(/\/admin\/users\?q=/);
  await expect(page.getByRole('row').filter({ hasText: member.username })).toContainText(member.email);
});
