import { emptyDocument, type DocNode, type PageView } from '@workfluence/shared';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiError } from '../api';
import { Editor } from '../components/Editor';

/** 새 페이지(/spaces/:spaceId/new?parentId=) 와 기존 페이지 편집(/pages/:pageId/edit)을 한 화면이 처리한다 */
export function PageEditorPage() {
  const { spaceId, pageId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [initial, setInitial] = useState<DocNode | null>(pageId ? null : emptyDocument());
  const [page, setPage] = useState<PageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const docRef = useRef<DocNode>(emptyDocument());

  useEffect(() => {
    if (!pageId) return;
    api<PageView>(`/api/pages/${pageId}`)
      .then((p) => {
        setPage(p);
        setTitle(p.title);
        setInitial(p.content);
        docRef.current = p.content;
      })
      .catch((e: Error) => setError(e.message));
  }, [pageId]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setConflict(null);
    try {
      if (pageId && page) {
        // baseVersionNo = 편집을 시작한 시점의 버전. 다르면 서버가 409를 준다 (CLAUDE.md 6절)
        const updated = await api<PageView>(`/api/pages/${pageId}`, {
          method: 'PUT',
          json: { title, content: docRef.current, baseVersionNo: page.currentVersionNo },
        });
        navigate(`/spaces/${updated.spaceId}/pages/${updated.id}`);
      } else if (spaceId) {
        const created = await api<PageView>('/api/pages', {
          method: 'POST',
          json: { spaceId, parentId: params.get('parentId') ?? null, title, content: docRef.current },
        });
        navigate(`/spaces/${spaceId}/pages/${created.id}`);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const body = e.body as { message?: { currentVersionNo?: number } } | undefined;
        setConflict(body?.message?.currentVersionNo ?? -1);
      } else {
        setError(e instanceof Error ? e.message : '저장 실패');
      }
    } finally {
      setSaving(false);
    }
  };

  const reloadLatest = async () => {
    if (!pageId) return;
    const p = await api<PageView>(`/api/pages/${pageId}`);
    setPage(p);
    setConflict(null);
  };

  if (!initial) return <p className="muted">{error ?? '불러오는 중…'}</p>;

  return (
    <div className="editor-page">
      <div className="editor-head">
        <input className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="페이지 제목" />
        <div className="actions">
          <button type="button" onClick={() => navigate(-1)} disabled={saving}>
            취소
          </button>
          <button type="button" className="primary" onClick={save} disabled={saving || !title.trim()}>
            {saving ? '저장 중…' : pageId ? `저장 (v${page?.currentVersionNo ?? '?'} 기준)` : '만들기'}
          </button>
        </div>
      </div>
      {conflict !== null && (
        <div className="notice warn">
          다른 사용자가 먼저 저장했다 (현재 서버 버전 v{conflict}). 내 편집 내용은 화면에 그대로 있다.
          <button type="button" onClick={reloadLatest}>
            최신 버전을 기준으로 다시 저장 준비
          </button>
          <span className="muted"> 이후 저장을 누르면 내 내용이 v{conflict} 위에 새 버전으로 올라간다.</span>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <Editor content={initial} onChange={(doc) => (docRef.current = doc)} />
    </div>
  );
}
