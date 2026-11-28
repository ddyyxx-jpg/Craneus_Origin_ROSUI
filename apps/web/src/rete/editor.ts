import { createRoot } from 'react-dom/client';
import { ClassicPreset, NodeEditor, type GetSchemes } from 'rete';
import { AreaPlugin, AreaExtensions } from 'rete-area-plugin';
import { ConnectionPlugin, Presets as ConnectionPresets } from 'rete-connection-plugin';
import { ReactPlugin, type ReactArea2D } from 'rete-react-plugin';
import type { GraphIR } from '@rosui/ir';
import { registerControls } from '../controls';
import { RosuiNode, createNode, type NodeKind } from './nodes';
import { serializeGraph } from './serialize';
import {
  LOD_ENTER_THRESHOLD,
  getLod,
  resetLod,
  setLodZoom,
  updateNodeSize,
} from './lod';

type Schemes = GetSchemes<
  RosuiNode,
  ClassicPreset.Connection<ClassicPreset.Node, ClassicPreset.Node>
>;
type Extra = ReactArea2D<Schemes>;

export interface EditorHandle {
  editor: NodeEditor<Schemes>;
  area: AreaPlugin<Schemes, Extra>;
  /** 供 e2e 直接构造 ClassicPreset.Connection，避免在页面里裸 import('rete') 无法解析。 */
  Connection: typeof ClassicPreset.Connection;
  destroy: () => void;
  /** e2e/perf 用：按生产 addNode 路径批量添加混合类型节点与连线。 */
  addNodes: (count: number) => Promise<string[]>;
  /** e2e/perf 用：直接设置缩放（不经过鼠标滚轮动画）。 */
  setZoom: (zoom: number) => Promise<void>;
  /** P2-C：点空白/应用重置选中端口时清除节点视觉选中态。 */
  clearNodeSelection: () => void;
  /** T-032：返回当前选中节点 id 的副本数组。 */
  getSelectedNodeIds: () => string[];
  /** T-032：用给定 id 覆盖选中集合（仅保留图中真实存在的 id），并重放高亮。 */
  setSelectedNodeIds: (ids: readonly string[]) => void;
  /** DEV/e2e 专用：按生产 addNode 路径添加单个节点（不在 UI 暴露）。 */
  addNodeKind: (kind: NodeKind, x: number, y: number) => Promise<RosuiNode>;
}

/** Create the Rete node editor with area, connection and React rendering plugins. */
export async function createEditor(
  container: HTMLElement,
  onNodePicked?: (nodeId: string) => void,
): Promise<EditorHandle> {
  const editor = new NodeEditor<Schemes>();
  const area = new AreaPlugin<Schemes, Extra>(container);
  const connection = new ConnectionPlugin<Schemes, Extra>();
  // React 19: createRoot must be passed explicitly to ReactPlugin.
  const react = new ReactPlugin<Schemes, Extra>({ createRoot });

  connection.addPreset(ConnectionPresets.classic.setup());
  react.addPreset(registerControls());

  editor.use(area);
  area.use(connection);
  area.use(react);

  // Official extension: hides an input's inline control while connected, restores it on disconnect.
  AreaExtensions.showInputControl(area);

  /**
   * 采样单个节点的真实布局尺寸（offsetWidth/Height 不受 area transform 影响）。
   * 二轮评审 P1-B：只在 full 模式采样；placeholder 模式下节点 DOM 是简化占位，
   * 它的 offsetWidth/Height 来自占位自身尺寸或兜底常量，回写会覆盖跨阈值前锁定的 full 尺寸。
   * 低缩放新增且没有缓存的节点由 LodNode 按节点类型选默认占位尺寸，不在这里污染缓存。
   */
  const sampleNode = (id: string, element: HTMLElement): void => {
    if (getLod() !== 'full') return;
    const changed = updateNodeSize(id, element.offsetWidth, element.offsetHeight);
    if (changed) {
      void area.update('node', id).catch(() => undefined);
    }
  };
  const captureSizes = (): void => {
    for (const node of editor.getNodes()) {
      const element = area.nodeViews.get(node.id)?.element;
      if (element) sampleNode(node.id, element);
    }
  };

  // M5 LOD：zoomed 事件每帧都可能触发，用 rAF 合并到下一帧只 setState 一次。
  let zoomFrame = 0;
  area.addPipe((context) => {
    if (context.type === 'zoomed') {
      if (zoomFrame) cancelAnimationFrame(zoomFrame);
      zoomFrame = requestAnimationFrame(() => {
        zoomFrame = 0;
        const k = area.area.transform.k;
        // 跨越到占位前先锁定完整节点的真实尺寸，避免端口位置漂移。
        if (getLod() === 'full' && k < LOD_ENTER_THRESHOLD) captureSizes();
        setLodZoom(k);
      });
    }
    return context;
  });

  /**
   * 二轮评审 P2-C：本应用的“选中”是端口选择语义（nodepicked → App.selectNode → selectedPort），
   * Rete 的 node.selected 不会被 selectableNodes 写入。这里在 nodepicked 管道同步把选中态
   * 写到节点 DOM 的 class/data-selected；full（styled-components）和 placeholder（styles.css）
   * 都识别同一组标记，不再依赖 node.selected。
   * T-032：改为按 id 集合标记，兼容多选；仍然是轻量 DOM 桥接，不调用 area.update。
   * 单个节点标记是 render 热路径，必须 O(1) 只处理当前节点，否则 200 节点批量建图时
   * 每次全图扫描会把 LOD placeholder 首帧拖成 O(n²)；全图扫描只留给显式改选中集合/缩放切换。
   */
  const markNodeSelection = (id: string, element: HTMLElement, selected: boolean): void => {
    // 经典 preset 的根节点是 styled-components 的 [data-testid=node]（可能没有 .node-shell），
    // 自定义节点是 .node-shell，LOD placeholder 是 [data-testid=node-lod]。三者都覆盖，
    // 并把 id 透传到每个目标，方便后续 DOM 查询/点击映射。
    const targets: HTMLElement[] = [];
    const testNodes = Array.from(
      element.querySelectorAll<HTMLElement>('[data-testid="node"], [data-testid="node-lod"]'),
    );
    const shells = Array.from(element.querySelectorAll<HTMLElement>('.node-shell'));
    if (element.matches('[data-testid="node"], [data-testid="node-lod"], .node-shell')) targets.push(element);
    targets.push(...testNodes, ...shells);
    for (const target of targets) {
      target.setAttribute('data-node-id', id);
      target.classList.toggle('selected', selected);
      if (selected) target.setAttribute('data-selected', 'true');
      else target.removeAttribute('data-selected');
    }
  };

  /** 全图扫描只在显式改变选中集合/缩放切换时用；render 热路径走 markNodeSelection。 */
  const markSelectedNodes = (ids: ReadonlySet<string>): void => {
    for (const node of editor.getNodes()) {
      const element = area.nodeViews.get(node.id)?.element;
      if (!element) continue;
      markNodeSelection(node.id, element, ids.has(node.id));
    }
  };

  const selectedNodeIds = new Set<string>();
  const clearNodeSelection = (): void => {
    if (selectedNodeIds.size === 0) return;
    selectedNodeIds.clear();
    markSelectedNodes(selectedNodeIds);
  };

  // T-032：pointerdown 的修饰键 + window keydown/keyup 双信号跟踪 Ctrl/Meta，
  // 兼容某些路径下 pointerdown 事件不带修饰键信息的情况。
  let additive = false;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey) additive = true;
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (!event.ctrlKey && !event.metaKey) additive = false;
  };
  const onWindowBlur = (): void => {
    additive = false;
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onWindowBlur);

  // M4 A: stamp node id on the rendered DOM so the canvas click handler can map a
  // clicked title/control region back to a specific node instance for binding.
  area.addPipe((context) => {
    if (context.type === 'render' && context.data.type === 'node') {
      const id = context.data.payload.id;
      context.data.element.setAttribute('data-node-id', id);
      // render 会重建节点子树（full ↔ placeholder 切换时）；只重放当前节点，避免 O(n²)。
      markNodeSelection(id, context.data.element, selectedNodeIds.has(id));
    }
    if (context.type === 'pointerdown') {
      const event = context.data.event;
      // 事件里明确带了修饰键状态就以此为准，避免 keyup 迟到一帧造成误判。
      if (event.ctrlKey || event.metaKey) additive = true;
      else if (event.ctrlKey === false && event.metaKey === false) additive = false;
      // 点击空白画布取消端口选中：不碰 selectedPort 的业务绑定，只清节点视觉高亮。
      const target = event.target;
      if (target instanceof Element && !target.closest('.node-shell, [data-testid="node"], [data-testid="node-lod"]')) {
        selectedNodeIds.clear();
        markSelectedNodes(selectedNodeIds);
      }
    }
    if (context.type === 'nodepicked') {
      const id = context.data.id;
      if (additive) {
        if (selectedNodeIds.has(id)) selectedNodeIds.delete(id);
        else selectedNodeIds.add(id);
      } else {
        selectedNodeIds.clear();
        selectedNodeIds.add(id);
      }
      // 延后到 React 完成重渲染后写 DOM，避免 area.update 把标记清掉。
      requestAnimationFrame(() => markSelectedNodes(selectedNodeIds));
      if (onNodePicked) onNodePicked(id);
    }
    return context;
  });

  // M5 review #4：所有生产路径（addNode/loadGraph）都在 render 管道统一采样尺寸；
  // 二轮 P1-B：sampleNode 内部只认 full 模式，placeholder 的 render/resized 不再回写尺寸缓存。
  // noderesized 补采动态改宽高的节点；二者均不是逐帧事件。
  area.addPipe((context) => {
    if (context.type === 'render' && context.data.type === 'node') {
      sampleNode(context.data.payload.id, context.data.element);
    }
    if (context.type === 'noderesized') {
      const element = area.nodeViews.get(context.data.id)?.element;
      if (element) sampleNode(context.data.id, element);
    }
    return context;
  });


  const handle: EditorHandle = {
    editor,
    area,
    Connection: ClassicPreset.Connection,
    destroy: () => {
      if (zoomFrame) cancelAnimationFrame(zoomFrame);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onWindowBlur);
      resetLod();
      void area.destroy();
    },
    addNodes: async (count: number) => {
      // 走与工具栏完全相同的 addNode 生产路径：混合节点类型 + 真实连线。
      const kinds: NodeKind[] = ['gain', 'pose', 'inspector', 'script'];
      const ids: string[] = [];
      // Inspector 没有输入/输出 socket，连线只在其余三类节点之间建立。
      const connectable: RosuiNode[] = [];
      for (let i = 0; i < count; i += 1) {
        const kind = kinds[i % kinds.length]!;
        const node = await handle.addNodeKind(
          kind,
          120 + (i % 20) * 200,
          120 + Math.floor(i / 20) * 150,
        );
        ids.push(node.id);
        if (kind !== 'inspector') connectable.push(node);
      }
      // 相邻可连接节点成对连线：200 节点图含 150 个可连接节点 → 149 条真实连线。
      for (let i = 1; i < connectable.length; i += 1) {
        const source = connectable[i - 1]!;
        const target = connectable[i]!;
        const sourceOutput = Object.keys(source.outputs)[0];
        const targetInput = Object.keys(target.inputs)[0];
        if (sourceOutput && targetInput) {
          await editor.addConnection(
            new ClassicPreset.Connection(source, sourceOutput, target, targetInput) as never,
          );
        }
      }
      return ids;
    },
    setZoom: async (zoom: number) => {
      // 同步入口（e2e 用）：立刻采样一次，避免依赖 rAF 的异步时机。
      if (getLod() === 'full' && zoom < LOD_ENTER_THRESHOLD) captureSizes();
      await area.area.zoom(zoom);
      setLodZoom(zoom);
      // render 管道会重放；这里补一次全图扫描，确保切换后 placeholder/full 都同步。
      requestAnimationFrame(() => markSelectedNodes(selectedNodeIds));
    },
    clearNodeSelection,
    getSelectedNodeIds: () => [...selectedNodeIds],
    setSelectedNodeIds: (ids: readonly string[]) => {
      selectedNodeIds.clear();
      const existing = new Set(editor.getNodes().map((node) => node.id));
      for (const id of ids) {
        if (existing.has(id)) selectedNodeIds.add(id);
      }
      markSelectedNodes(selectedNodeIds);
    },
    addNodeKind: (kind: NodeKind, x: number, y: number) => addNode(handle, kind, x, y),
  };

  return handle;
}

let nodeCounter = 0;

/** 生产路径：工具栏 +Gain/+Pose/+Inspector/+Script 都走这里，render 管道统一采样尺寸。 */
export async function addNode(
  handle: EditorHandle,
  kind: NodeKind,
  x: number,
  y: number,
  onChange?: (node: RosuiNode, value: unknown, valid: boolean) => void,
): Promise<RosuiNode> {
  const node = createNode(kind, onChange);
  await handle.editor.addNode(node);
  await handle.area.translate(node.id, { x, y });
  nodeCounter += 1;
  return node;
}

/** Backwards-compatible alias kept for the existing M1 spec. */
export async function addGainNode(
  handle: EditorHandle,
  x: number,
  y: number,
  onChange?: (value: number) => void,
): Promise<RosuiNode> {
  return addNode(handle, 'gain', x, y, (_node, value) => {
    if (typeof value === 'number') onChange?.(value);
  });
}

export async function connect(
  handle: EditorHandle,
  source: string,
  sourceOutput: string,
  target: string,
  targetInput: string,
): Promise<void> {
  const sourceNode = handle.editor.getNode(source);
  const targetNode = handle.editor.getNode(target);
  if (!sourceNode || !targetNode) throw new Error('Cannot connect: node not found');
  await handle.editor.addConnection(
    new ClassicPreset.Connection(sourceNode, sourceOutput, targetNode, targetInput) as never,
  );
}

/** Export the current editor state into a GraphIR v1 document. */
export function toGraphIR(handle: EditorHandle): GraphIR {
  return serializeGraph(handle);
}
