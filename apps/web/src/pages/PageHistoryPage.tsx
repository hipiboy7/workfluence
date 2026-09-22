import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { DocNode, PageDiffView, PageVersionView, SpaceView, PageView } from '@workfluence/shared';
import { api } from '../api';
import { Editor } from '../components/Editor';

/** 버전 이력·복원 (FR-344). 복원은 새 버전을 만든다 — 이력은 지워지지 않는다 */
export function PageHistoryPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [versions, setVersions] = useState<PageVersionView[]>([]);
  const [preview, setPreview] = useState<(PageVersionView & { content: DocNode }) | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<PageVersionView[]>(`/api/pages/${id}/versions`)
      .then(setVersions)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    api<PageView>(`/api/pages/${id}`)
      .then((p) => api<SpaceView>(`/api/spaces/${p.spaceId}`))
      .then((s) => setCanWrite(s.access.canWrite))
      .catch(() => setCanWrite(false));
  }, [id]);
  useEffect(load, [load]);

  // 비교할 두 버전. 하나만 고르면 "다음 것을 고르세요"로 남는다
  const [pick, setPick] = useState<number[]>([]);
  const [diff, setDiff] = useState<PageDiffView | null>(null);
  const toggle = (no: number): void => {
    setDiff(null);
    setPick((cur) => (cur.includes(no) ? cur.filter((x) => x !== no) : [...cur, no].slice(-2)));
  };
  const compare = (): void => {
    const [a, b] = [...pick].sort((x, y) => x - y);
    void api<PageDiffView>(`/api/pages/${id}/versions/${a}/diff/${b}`)
      .then(setDiff)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <main className="shell">
      <p className="muted small"><Link to={`/pages/${id}`}>← 보기로</Link></p>
      <h1>버전 이력</h1>
      {error && <p className="badge fail" role="alert">{error}</p>}

      <section className="card" aria-label="버전 비교">
        <h2>두 버전 비교</h2>
        <p className="muted small">
          아래 목록에서 <strong>두 개</strong>를 고르면 무엇이 바뀌었는지 볼 수 있다. 지금 고른 것:{' '}
          {pick.length ? pick.map((n) => `v${n}`).join(', ') : '없음'}
        </p>
        <button type="button" onClick={compare} disabled={pick.length !== 2}>
          비교하기
        </button>
        {diff && (
          <div className="diff">
            <p className="muted small">
              v{diff.from.versionNo} → v{diff.to.versionNo} · 변경 {diff.diff.modified} · 추가 {diff.diff.added} · 삭제 {diff.diff.removed}
              {diff.titleChanged && ' · 제목도 바뀌었다'}
            </p>
            {!diff.diff.changed && <p>두 버전의 내용이 같다.</p>}
            {diff.diff.blocks.map((b, i) => (
              <p key={i} className={`diff-${b.kind}`}>
                {b.kind === 'changed' && b.words
                  ? b.words.map((w, j) => (
                      <span key={j} className={`w-${w.kind}`}>
                        {w.text}{' '}
                      </span>
                    ))
                  : (b.after ?? b.before ?? '')}
              </p>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <ul>
          {versions.map((v) => (
            <li key={v.versionNo}>
              {/* **체크박스를 버전 뒤에 둔다.** 앞에 두면 목록 항목이 "비교 v1…"로 시작해
                  버전으로 항목을 찾던 기존 화면 테스트가 깨진다 — 읽는 순서도 이쪽이 자연스럽다 */}
              <strong>v{v.versionNo}</strong> {v.title} — {v.createdByName} · {new Date(v.createdAt).toLocaleString('ko-KR')}{' '}
              <label>
                <input type="checkbox" checked={pick.includes(v.versionNo)} onChange={() => toggle(v.versionNo)} /> 비교
              </label>{' '}
              <button
                type="button"
                onClick={() =>
                  void api<PageVersionView & { content: DocNode }>(`/api/pages/${id}/versions/${v.versionNo}`)
                    .then(setPreview)
                    .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                }
              >
                보기
              </button>
              {canWrite && (
                <button
                  type="button"
                  onClick={() =>
                    void api(`/api/pages/${id}/versions/${v.versionNo}/restore`, { method: 'POST' })
                      .then(() => nav(`/pages/${id}`))
                      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                  }
                >
                  이 버전으로 복원
                </button>
              )}
            </li>
          ))}
        </ul>
        <p className="muted small">복원해도 이력은 지워지지 않는다. 그 내용으로 **새 버전**이 하나 더 생긴다.</p>
      </section>
      {preview && (
        <section className="card">
          <h2>v{preview.versionNo} 미리보기</h2>
          <Editor value={preview.content} editable={false} />
        </section>
      )}
    </main>
  );
}
