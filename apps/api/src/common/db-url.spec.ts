import { describe, expect, it } from 'vitest';
import { describeDatabaseUrl } from './db-url';

describe('describeDatabaseUrl', () => {
  it('어디에 붙는지 알려 준다 — 정리 명령이 지우기 전에 말해야 하는 것', () => {
    expect(describeDatabaseUrl('postgres://wf:secret@db.example.internal:5432/workfluence')).toBe(
      'db.example.internal:5432/workfluence (사용자 wf)',
    );
  });

  it('**비밀번호를 담지 않는다** — 이 문자열은 로그로 나간다', () => {
    const out = describeDatabaseUrl('postgres://wf:p4ssw0rd-do-not-log@127.0.0.1:5433/workfluence');
    expect(out).not.toContain('p4ssw0rd');
    expect(out).toContain('127.0.0.1:5433');
  });

  it('포트가 없으면 기본 포트로 적는다', () => {
    expect(describeDatabaseUrl('postgres://wf@host/db')).toBe('host:5432/db (사용자 wf)');
  });

  it('사용자가 없어도 터지지 않는다', () => {
    expect(describeDatabaseUrl('postgres://host:5432/db')).toContain('사용자 ?');
  });

  it('읽을 수 없는 문자열이면 **그렇다고 말한다** — 조용히 빈 문자열을 내지 않는다', () => {
    expect(describeDatabaseUrl('그냥 글자')).toBe('(접속 문자열을 읽을 수 없다)');
  });
});
