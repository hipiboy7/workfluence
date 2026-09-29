import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { can, type SpaceView } from '@workfluence/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { EmptyState, Field, Loading, Notice, Page, PageHeader, StatusBadge } from '../components/ui';

/**
 * 홈 — 내 스페이스 목록 (FR-340 · P17 설계서 J.6 기본 문맥). 버튼 노출은 응답의 access를 쓴다 (FR-345).
 *
 * 인사말·역할·메뉴 링크·로그아웃·비밀번호 변경은 한 틀의 위 막대로, 관리 링크는 왼쪽 칸으로 옮겼다(J.3.2·J.3.3) — 본문에 되풀이하면 한 화면에
 * 같은 이름의 링크가 둘이 되어 사람도 시험도 헷갈린다(J.8-1). 제품 이름도 위 막대가 말하므로 h1은 "스페이스"다.
 * 안 읽은 알림 수(FR-505)는 모든 화면의 알림 영역이 보인다 — 예전에는 이 머리말에만 있었다 (P17 F-010 8번, `NotificationBell`)
 */
export function SpacesPage() {
  const { me } = useAuth();
  const [rows, setRows] = useState<SpaceView[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([api<SpaceView[]>('/api/spaces?scope=personal'), api<SpaceView[]>('/api/spaces?scope=team')])
      .then(([p, t]) => setRows([...p, ...t]))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  if (!me) return null;
  // 위임까지 함께 넘긴다 — 판정은 서버의 가드와 같은 `can()` (P11 D.1)
  const principal = { id: me.id, role: me.role, grants: me.grants };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/spaces', { method: 'POST', json: { name, kind: 'team' } });
      setName('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // 분류는 붙은 공간이 하나라도 있을 때만 열을 둔다 — 아무도 쓰지 않으면 빈 열이 늘어설 뿐이다
  const withCategory = rows?.some((s) => s.categoryName) ?? false;

  return (
    <Page>
      <PageHeader title="스페이스" description="내 개인 스페이스와 Crew로 들어간 팀 스페이스다." />
      {error && <Notice kind="error">{error}</Notice>}

      {can(principal, 'space.create') && (
        <>
          <h2 id="sp-create-title">팀 스페이스 만들기</h2>
          {/* 칸 하나 + 단추 한 줄 (J.5.4) — 라벨 '이름'은 시험이 찾는 이름이다 */}
          <form className="inline-form" aria-labelledby="sp-create-title" onSubmit={create}>
            <Field id="sp-name" label="이름" required>
              <input id="sp-name" className="w-m" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <button type="submit" className="primary">
              만들기
            </button>
          </form>
        </>
      )}

      <h2 id="sp-list-title">내 스페이스</h2>
      {rows === null ? (
        !error && <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="아직 스페이스가 없다." description="팀 스페이스를 만들거나, 팀 스페이스의 주인에게 Crew로 넣어 달라고 부탁한다." />
      ) : (
        // 진짜 표 (J.5.5) — 예전에는 한 줄에 글을 이어 붙인 목록이었다
        <table aria-labelledby="sp-list-title">
          <thead>
            <tr>
              <th scope="col">이름</th>
              <th scope="col">종류</th>
              <th scope="col">키</th>
              {withCategory && <th scope="col">분류</th>}
              <th scope="col" className="num">
                Crew
              </th>
              <th scope="col">상태</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link to={`/spaces/${s.id}`}>{s.name}</Link>
                </td>
                <td>
                  <StatusBadge kind="neutral">{s.kind === 'personal' ? '개인' : '팀'}</StatusBadge>
                </td>
                <td className="mono">{s.key}</td>
                {withCategory && <td>{s.categoryName ?? <span className="muted">없음</span>}</td>}
                <td className="num">{s.memberCount}</td>
                <td>{s.status === 'active' ? <StatusBadge kind="ok">활성</StatusBadge> : <StatusBadge kind="paused">중지</StatusBadge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
