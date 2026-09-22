import { describe, expect, it } from 'vitest';
import { shouldSaveVersion, type SaveDecision } from './realtime';
import type { DocNode } from '@workfluence/shared';

/**
 * A등급 — **테스트 먼저** (3절, P6_설계서_Collab C.2절 ⑤).
 *
 * `page_versions`는 append-only다 (6절). **잘못 만든 버전은 지울 수 없다.**
 * 그래서 "만든다"보다 **"안 만든다"를 훨씬 많이 확인한다.**
 */

const doc = (text: string): DocNode => ({
  type: 'doc',
  attrs: { schemaVersion: 1 },
  content: text ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : [{ type: 'paragraph' }],
});

const why = (d: SaveDecision): string => (d.save ? 'save' : d.reason);

describe('shouldSaveVersion — 안 만드는 쪽 (FR-707·708)', () => {
  it('**아직 타이핑 중이면 만들지 않는다**', () => {
    const d = shouldSaveVersion({ next: doc('새 내용'), previous: doc('옛 내용'), idleMs: 1_000, idleThresholdMs: 5_000 });
    expect(why(d)).toBe('아직 편집 중');
  });

  it('**내용이 같으면 만들지 않는다** — 커서만 움직여도 변경이 오기 때문이다', () => {
    const d = shouldSaveVersion({ next: doc('같은 내용'), previous: doc('같은 내용'), idleMs: 60_000, idleThresholdMs: 5_000 });
    expect(why(d)).toBe('내용이 그대로');
  });

  it('속성 순서만 달라도 같다고 본다', () => {
    const a: DocNode = { type: 'doc', attrs: { schemaVersion: 1 }, content: [{ type: 'heading', attrs: { level: 2, textAlign: 'left' }, content: [{ type: 'text', text: 'x' }] }] };
    const b: DocNode = { type: 'doc', attrs: { schemaVersion: 1 }, content: [{ type: 'heading', attrs: { textAlign: 'left', level: 2 }, content: [{ type: 'text', text: 'x' }] }] };
    expect(why(shouldSaveVersion({ next: b, previous: a, idleMs: 60_000, idleThresholdMs: 5_000 }))).toBe('내용이 그대로');
  });

  it('**스키마 검증을 통과하지 못하면 만들지 않는다** (FR-708)', () => {
    const bad = { type: 'doc', attrs: { schemaVersion: 1 }, content: [{ type: 'iframe' }] } as DocNode;
    const d = shouldSaveVersion({ next: bad, previous: doc('이전'), idleMs: 60_000, idleThresholdMs: 5_000 });
    expect(d.save).toBe(false);
    expect(why(d)).toContain('문서 검증 실패');
  });

  it('검증 실패 사유를 함께 준다 — 로그만 남기므로 사유가 없으면 고칠 수 없다', () => {
    const bad = { type: 'paragraph' } as DocNode;
    const d = shouldSaveVersion({ next: bad, previous: doc('이전'), idleMs: 60_000, idleThresholdMs: 5_000 });
    expect(d.save).toBe(false);
    if (!d.save) expect(d.errors.length).toBeGreaterThan(0);
  });

  it('**빈 문서로 덮어쓰지 않는다** — 연결이 끊기며 빈 상태가 올라오면 내용이 사라진다', () => {
    const d = shouldSaveVersion({ next: doc(''), previous: doc('지워지면 안 되는 내용'), idleMs: 60_000, idleThresholdMs: 5_000 });
    expect(why(d)).toBe('빈 문서로 덮어쓰지 않는다');
  });
});

describe('shouldSaveVersion — 만드는 쪽 (FR-706)', () => {
  it('충분히 조용하고 내용이 바뀌었으면 만든다', () => {
    const d = shouldSaveVersion({ next: doc('고친 내용'), previous: doc('옛 내용'), idleMs: 5_000, idleThresholdMs: 5_000 });
    expect(d.save).toBe(true);
  });

  it('직전 내용이 없으면(첫 저장) 빈 문서가 아닌 한 만든다', () => {
    expect(shouldSaveVersion({ next: doc('첫 내용'), previous: null, idleMs: 9_000, idleThresholdMs: 5_000 }).save).toBe(true);
  });

  it('**직전이 없고 새 것도 비었으면 만들지 않는다**', () => {
    expect(shouldSaveVersion({ next: doc(''), previous: null, idleMs: 9_000, idleThresholdMs: 5_000 }).save).toBe(false);
  });

  it('일부러 비운 것은 만든다 — 강제 저장은 빈 문서 보호를 넘는다', () => {
    const d = shouldSaveVersion({ next: doc(''), previous: doc('있던 내용'), idleMs: 0, idleThresholdMs: 5_000, force: true });
    expect(d.save).toBe(true);
  });

  it('강제 저장도 **검증은 못 건너뛴다** — 깨진 문서가 정본이 되면 안 된다', () => {
    const bad = { type: 'doc', content: [{ type: 'iframe' }] } as DocNode;
    expect(shouldSaveVersion({ next: bad, previous: doc('이전'), idleMs: 0, idleThresholdMs: 5_000, force: true }).save).toBe(false);
  });

  it('강제 저장도 **같은 내용이면 만들지 않는다** — 창을 닫을 때마다 버전이 늘면 안 된다', () => {
    expect(shouldSaveVersion({ next: doc('같음'), previous: doc('같음'), idleMs: 0, idleThresholdMs: 5_000, force: true }).save).toBe(false);
  });
});

describe('shouldSaveVersion — 마크만 달라도 변경이다', () => {
  const plain: DocNode = { type: 'doc', attrs: { schemaVersion: 1 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '중요' }] }] };
  const bold: DocNode = { type: 'doc', attrs: { schemaVersion: 1 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '중요', marks: [{ type: 'bold' }] }] }] };

  it('글자는 같고 **굵게만 씌워도** 버전을 만든다 — 텍스트 비교만 하면 놓친다', () => {
    expect(shouldSaveVersion({ next: bold, previous: plain, idleMs: 9_000, idleThresholdMs: 5_000 }).save).toBe(true);
  });

  it('같은 마크끼리는 만들지 않는다', () => {
    expect(shouldSaveVersion({ next: bold, previous: bold, idleMs: 9_000, idleThresholdMs: 5_000 }).save).toBe(false);
  });

  it('마크 속성이 다르면 변경이다 — 링크 주소만 바뀐 경우', () => {
    const l = (href: string): DocNode => ({ type: 'doc', attrs: { schemaVersion: 1 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '여기', marks: [{ type: 'link', attrs: { href } }] }] }] });
    expect(shouldSaveVersion({ next: l('/b'), previous: l('/a'), idleMs: 9_000, idleThresholdMs: 5_000 }).save).toBe(true);
  });
});
