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
   * 采样单个节点的布局尺寸（offsetWidth/Height 不受 area transform 影响）。
   * 只在 render/resized 时调用，绝不在每帧读布局；
   * full 模式下尺寸变化要通知 Rete 重算 socket 位置，placeholder 模式则只刷新缓存。
   */
  const sampleNode = (id: string, element: HTMLElement): void => {
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const changed = updateNodeSize(id, width, height);
    if (changed && getLod() === 'full') {
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

  // M4 A: stamp node id on the rendered DOM so the canvas click handler can map a
  // clicked title/control region back to a specific node instance for binding.
  area.addPipe((context) => {
    if (context.type === 'render' && context.data.type === 'node') {
      context.data.element.setAttribute('data-node-id', context.data.payload.id);
    }
    if (context.type === 'nodepicked' && onNodePicked) {
      onNodePicked(context.data.id);
    }
    return context;
  });

  // M5 review #4：所有生产路径（addNode/loadGraph）都在 render 管道统一采样尺寸。
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
      if (getLod() === 'full' && zoom < LOD_ENTER_THRESHOLD) captureNodeSizesOnce();
      await area.area.zoom(zoom);
      setLodZoom(zoom);
    },
    addNodeKind: (kind: NodeKind, x: number, y: number) => addNode(handle, kind, x, y),
  };

  /** setZoom 跨阈值前同步锁定尺寸，复用 render 管道的采样逻辑。 */
  function captureNodeSizesOnce(): void {
    for (const node of editor.getNodes()) {
      const element = area.nodeViews.get(node.id)?.element;
      if (element) sampleNode(node.id, element);
    }
  }

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
