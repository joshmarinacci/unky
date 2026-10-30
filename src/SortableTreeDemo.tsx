import { useState } from 'react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, GripVertical, RotateCcw } from 'lucide-react';

type Node = { id: string; title: string; kind: 'folder' | 'file'; children?: Node[] };
const initialTree: Node[] = [
  { id: 'projects', title: 'Projects', kind: 'folder', children: [
    { id: 'atlas', title: 'Atlas redesign', kind: 'folder', children: [
      { id: 'brief', title: 'product-brief.md', kind: 'file' },
      { id: 'research', title: 'Research', kind: 'folder', children: [{ id: 'interviews', title: 'interviews.md', kind: 'file' }, { id: 'survey', title: 'survey-results.csv', kind: 'file' }] },
      { id: 'mockups', title: 'mockups.fig', kind: 'file' },
    ] },
    { id: 'garden', title: 'Garden planner', kind: 'folder', children: [{ id: 'plants', title: 'plant-catalog.json', kind: 'file' }, { id: 'notes', title: 'notes.md', kind: 'file' }] },
  ] },
  { id: 'writing', title: 'Writing', kind: 'folder', children: [{ id: 'draft', title: 'the-shape-of-things.md', kind: 'file' }, { id: 'ideas', title: 'Ideas', kind: 'folder', children: [{ id: 'seeds', title: 'seeds.md', kind: 'file' }] }] },
  { id: 'readme', title: 'welcome.txt', kind: 'file' },
];

function locate(nodes: Node[], id: string, parentId: string | null = null, depth = 0): { node: Node; parentId: string | null; depth: number } | undefined {
  for (const node of nodes) {
    if (node.id === id) return { node, parentId, depth };
    const found = node.children && locate(node.children, id, node.id, depth + 1);
    if (found) return found;
  }
}
function contains(node: Node, id: string): boolean { return node.id === id || !!node.children?.some(child => contains(child, id)); }
function remove(nodes: Node[], id: string): { nodes: Node[]; node?: Node } {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return { nodes: [...nodes.slice(0, i), ...nodes.slice(i + 1)], node: nodes[i] };
    if (nodes[i].children) {
      const result = remove(nodes[i].children!, id);
      if (result.node) { const next = [...nodes]; next[i] = { ...next[i], children: result.nodes }; return { nodes: next, node: result.node }; }
    }
  }
  return { nodes };
}
function flatten(nodes: Node[], expanded?: Set<string>, depth = 0, parentId: string | null = null): { node: Node; depth: number; parentId: string | null }[] {
  return nodes.flatMap(node => [{ node, depth, parentId }, ...(node.kind === 'folder' && (!expanded || expanded.has(node.id)) ? flatten(node.children ?? [], expanded, depth + 1, node.id) : [])]);
}
function placeAtDepth(tree: Node[], activeId: string, overId: string, depth: number, after: boolean): Node[] {
  const active = locate(tree, activeId), over = locate(tree, overId);
  if (!active || !over || contains(active.node, overId)) return tree;
  if (active.parentId === over.parentId && depth === active.depth) {
    const siblings = active.parentId ? locate(tree, active.parentId)?.node.children ?? [] : tree;
    const oldIndex = siblings.findIndex(node => node.id === activeId);
    const overIndex = siblings.findIndex(node => node.id === overId);
    const moved = arrayMove(siblings, oldIndex, Math.max(0, Math.min(siblings.length - 1, overIndex + (after ? 1 : 0))));
    return active.parentId ? updateNode(tree, active.parentId, node => ({ ...node, children: moved })) : moved;
  }
  const removed = remove(tree, activeId);
  const flat = flatten(removed.nodes);
  const overIndex = flat.findIndex(item => item.node.id === overId);
  const targetDepth = Math.max(0, Math.min(depth, over.depth));
  const targetParent = targetDepth === 0 ? null : flat.slice(0, overIndex + 1).reverse().find(item => item.depth === targetDepth - 1 && item.node.kind === 'folder');
  if (targetDepth > 0 && !targetParent) return tree;
  const siblings = targetDepth === 0 ? removed.nodes : locate(removed.nodes, targetParent!.node.id)?.node.children ?? [];
  const targetIndex = siblings.findIndex(node => node.id === overId);
  const insertIndex = targetIndex < 0 ? siblings.length : Math.min(siblings.length, targetIndex + (after ? 1 : 0));
  const nextSiblings = [...siblings.slice(0, insertIndex), active.node, ...siblings.slice(insertIndex)];
  return targetDepth === 0 ? nextSiblings : updateNode(removed.nodes, targetParent!.node.id, node => ({ ...node, children: nextSiblings }));
}
function updateNode(nodes: Node[], id: string, update: (node: Node) => Node): Node[] {
  return nodes.map(node => node.id === id ? update(node) : node.children ? { ...node, children: updateNode(node.children, id, update) } : node);
}

function SortableRow({ node, depth, expanded, toggle }: { node: Node; depth: number; expanded: boolean; toggle: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: node.id, data: { kind: node.kind } });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? .35 : 1, paddingLeft: 13 + depth * 24 };
  return <div ref={setNodeRef} style={style} className="tree-row" {...attributes} {...listeners}>
    <button className="tree-chevron" aria-label={node.kind === 'folder' ? `${expanded ? 'Collapse' : 'Expand'} ${node.title}` : 'File'} onClick={event => { event.stopPropagation(); toggle(); }} onPointerDown={event => event.stopPropagation()}>
      {node.kind === 'folder' ? expanded ? <ChevronDown size={15}/> : <ChevronRight size={15}/> : <span className="chevron-spacer"/>}
    </button>
    <span className={`tree-node-icon ${node.kind}`}>{node.kind === 'folder' ? expanded ? <FolderOpen size={17}/> : <Folder size={17}/> : <FileText size={16}/>}</span>
    <span className="tree-node-title">{node.title}</span>
    <span className="tree-grip" aria-hidden="true"><GripVertical size={16}/></span>
  </div>;
}

export default function SortableTreeDemo() {
  const [tree, setTree] = useState(initialTree);
  const [expanded, setExpanded] = useState(new Set(['projects', 'atlas', 'research', 'garden', 'writing', 'ideas']));
  const [dragOrigin, setDragOrigin] = useState<{ id: string; depth: number } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const toggle = (id: string) => setExpanded(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const handleDragStart = ({ active }: DragStartEvent) => {
    const found = locate(tree, String(active.id));
    if (found) setDragOrigin({ id: String(active.id), depth: found.depth });
  };
  const handleDragEnd = ({ active, over, delta }: DragEndEvent) => {
    if (over && dragOrigin) setTree(current => placeAtDepth(current, String(active.id), String(over.id), Math.max(0, dragOrigin.depth + Math.round(delta.x / 24)), delta.y > 0));
    setDragOrigin(null);
  };
  return <main className="tree-demo">
    <header className="demo-topbar"><a className="demo-brand" href="/"><span className="demo-brand-mark">◉</span> My Browser <span className="demo-slash">/</span> Experiments</a><span className="demo-pill">dnd-kit playground</span></header>
    <section className="demo-content">
      <div className="demo-heading"><div><p className="demo-eyebrow">INTERACTION LAB <span>01</span></p><h1>Nested tree</h1><p className="demo-subtitle">Move things around. Give your ideas a new home.</p></div><button className="reset-tree" onClick={() => { setTree(initialTree); setExpanded(new Set(['projects', 'atlas', 'research', 'garden', 'writing', 'ideas'])); }}><RotateCcw size={14}/> Reset tree</button></div>
      <div className="tree-card"><div className="tree-card-head"><div><strong>Workspace</strong><span>3 folders <i/> 8 items</span></div><span className="tree-menu-dots">···</span></div>
        <div className="tree-guide"><span>NAME</span><span>TYPE</span></div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}><div className={`tree-list ${dragOrigin ? 'is-dragging' : ''}`}><SortableContext items={flatten(tree, expanded).map(item => item.node.id)} strategy={verticalListSortingStrategy}>{flatten(tree, expanded).map(({ node, depth }) => <SortableRow key={node.id} node={node} depth={depth} expanded={expanded.has(node.id)} toggle={() => toggle(node.id)}/>)}</SortableContext></div></DndContext>
        <footer className="tree-card-foot"><span><GripVertical size={13}/> Drag a row to reorder</span><span>Drag horizontally to change depth</span></footer>
      </div>
      <p className="demo-note">Folders open and close with the chevrons. Drag vertically to reorder and horizontally to change the nesting depth as you move.</p>
    </section>
  </main>;
}
