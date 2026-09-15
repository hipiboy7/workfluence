import type { PageSummary } from '@workfluence/shared';
import { useMemo } from 'react';
import { Link } from 'react-router';

type TreeNode = PageSummary & { children: TreeNode[] };

/** 평면 목록을 parentId 기준 트리로 만든다. 부모가 없는(삭제된) 노드는 루트에 붙인다. */
export function buildTree(pages: PageSummary[]): TreeNode[] {
  const byId = new Map<string, TreeNode>(pages.map((p) => [p.id, { ...p, children: [] }]));
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title, 'ko'));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

export function PageTree({ pages, spaceId, activeId }: { pages: PageSummary[]; spaceId: string; activeId?: string }) {
  const tree = useMemo(() => buildTree(pages), [pages]);
  if (!tree.length) return <p className="muted">페이지가 없다.</p>;
  return <TreeList nodes={tree} spaceId={spaceId} activeId={activeId} />;
}

function TreeList({ nodes, spaceId, activeId }: { nodes: TreeNode[]; spaceId: string; activeId?: string }) {
  return (
    <ul className="tree">
      {nodes.map((n) => (
        <li key={n.id}>
          <Link to={`/spaces/${spaceId}/pages/${n.id}`} className={n.id === activeId ? 'active' : undefined}>
            {n.title}
          </Link>
          {n.children.length > 0 && <TreeList nodes={n.children} spaceId={spaceId} activeId={activeId} />}
        </li>
      ))}
    </ul>
  );
}
