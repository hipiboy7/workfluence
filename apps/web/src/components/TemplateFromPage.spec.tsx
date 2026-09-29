// @vitest-environment happy-dom
import type { PageTemplateView, PageView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TemplateFromPage } from './TemplateFromPage';

/**
 * 컴포넌트 시험 — 페이지 보기 맨 아래의 템플릿 구획 (P6_설계서_Collab FR-740·743·745 · P17 설계서 J.5.3·J.5.4·J.5.10). 접힌 구획 안의 구획 폼이고 라벨은
 * 이름만이다. 같은 이름이면 새로 만들지 않고 그렇게 말한다. **지우기 전에 확인 대화로 묻는다** — 물리 삭제다. 서버는 가짜 `fetch`다
 */

const page = { id: 'p1', spaceId: 's1', title: '회의록', content: { type: 'doc', content: [] } } as unknown as PageView;
const tpl = (id: string, name: string, description: string | null = null): PageTemplateView => ({
  id,
  name,
  description,
  content: { type: 'doc', content: [] },
  updatedAt: '2026-09-27T00:00:00.000Z',
});
let list: PageTemplateView[] = [];
type Call = { method: string; url: string; body?: unknown };
let calls: Call[] = [];
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  list = [tpl('t1', '주간 회의록', '매주 쓰는 틀')];
  calls = [];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { name: string }) : undefined;
    calls.push({ method, url, body });
    if (method === 'GET' && url === '/api/templates') return Promise.resolve(json(200, list));
    if (method === 'POST' && url === '/api/templates') {
      // 같은 이름이면 있던 것을 돌려준다(멱등)
      const same = list.find((t) => t.name === body?.name);
      if (same) return Promise.resolve(json(200, same));
      const made = tpl(`t${list.length + 1}`, body?.name ?? '');
      list = [...list, made];
      return Promise.resolve(json(201, made));
    }
    if (method === 'DELETE' && url === '/api/templates/t1') {
      list = list.filter((t) => t.id !== 't1');
      return Promise.resolve(json(200, { ok: true }));
    }
    return Promise.reject(new Error(`시험에 없는 요청: ${method} ${url}`));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TemplateFromPage', () => {
  it('**접힌 구획 안의 구획 폼이고 라벨은 이름만이다** — 이름은 필수, 설명은 없어도 된다(도움말)', async () => {
    render(<TemplateFromPage page={page} />);
    const region = screen.getByRole('region', { name: '템플릿' });
    const details = region.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toMatch(/이 문서를 템플릿으로 저장/);
    const name = within(region).getByLabelText('이름');
    const desc = within(region).getByLabelText('설명');
    expect(name.hasAttribute('required')).toBe(true);
    expect(desc.hasAttribute('required')).toBe(false);
    expect(document.getElementById(desc.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(/없어도 된다/);
    await within(region).findByText('주간 회의록');
  });

  it('**만들면 완료 알림, 같은 이름이면 새로 만들지 않았다고 안내한다** — 둘 다 status', async () => {
    render(<TemplateFromPage page={page} />);
    await screen.findByText('주간 회의록');
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: '월간 보고' } });
    fireEvent.click(screen.getByRole('button', { name: '템플릿으로 저장' }));
    const made = await screen.findByRole('status');
    expect(made.textContent).toBe('"월간 보고" 템플릿을 만들었다.');
    expect(made.className).toBe('notice success');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: '월간 보고', description: null, content: page.content });

    await screen.findByText('월간 보고');
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: '주간 회의록' } });
    fireEvent.click(screen.getByRole('button', { name: '템플릿으로 저장' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('"주간 회의록"은 이미 있다. 내용을 바꾸려면 지우고 다시 만든다.'));
    expect(screen.getByRole('status').className).toBe('notice info');
  });

  it('**지우기 전에 묻는다** — 그만두면 지우지 않는다. 확정 단추는 "지우기"를 품지 않는다 (J.5.10)', async () => {
    render(<TemplateFromPage page={page} />);
    const remove = await screen.findByRole('button', { name: '주간 회의록 지우기' });
    fireEvent.click(remove);
    const dialog = await screen.findByRole('dialog', { name: '이 템플릿을 지울까요?' });
    expect(dialog.textContent).toContain('그것으로 만든 문서는 그대로다');
    expect(within(dialog).queryByRole('button', { name: /지우기/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '그만두기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: '주간 회의록 지우기' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '지운다' }));
    await waitFor(() => expect(screen.queryByText('주간 회의록')).toBeNull());
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/templates/t1']);
  });
});
