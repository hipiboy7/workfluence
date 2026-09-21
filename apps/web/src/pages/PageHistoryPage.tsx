import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { DocNode, PageVersionView, SpaceView, PageView } from '@workfluence/shared';
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

  return (
    <main className="shell">
      <p className="muted small"><Link to={`/pages/${id}`}>← 보기로</Link></p>
      <h1>버전 이력</h1>
      {error && <p className="badge fail" role="alert">{error}</p>}
      <section className="card">
        <ul>
          {versions.map((v) => (
            <li key={v.versionNo}>
              <strong>v{v.versionNo}</strong> {v.title} — {v.createdByName} · {new Date(v.createdAt).toLocaleString('ko-KR')}{' '}
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
