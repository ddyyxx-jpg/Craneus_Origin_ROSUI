import { createRoot } from 'react-dom/client';
import { ClassicPreset, NodeEditor, type GetSchemes } from 'rete';
import { AreaPlugin, AreaExtensions } from 'rete-area-plugin';
import { ConnectionPlugin, Presets as ConnectionPresets } from 'rete-connection-plugin';
import { ReactPlugin, type ReactArea2D } from 'rete-react-plugin';
import type { GraphIR } from '@rosui/ir';
import { registerControls } from '../controls';
import { RosuiNode, createNode, type NodeKind } from './nodes';
import { serializeGraph } from './serialize';
import { LOD_THRESHOLD, captureNodeSizes, getLod, resetLod, setLodZoom } from './lod';

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
  /** e2e/perf 用：批量添加节点（不进绑定层，不影响生产逻辑）。 */
  addNodes: (count: number) => Promise<string[]>;
  /** e2e/perf 用：直接设置缩放（不经过鼠标滚轮动画）。 */
  setZoom: (zoom: number) => Promise<void>;
}

/** Create the Rete node editor with area, connection and React rendering plugins. */
export async function createEditor(
  container: HTMLElement,
  onNodePicked?: (nodeId: string) => void,
  /** M5 perf：批量加节点后回传数量，供状态栏判定首帧完成。 */
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

  /** 记录节点的布局尺寸（offsetWidth/Height 不受 area transform 缩放影响）。 */
  const captureSizes = (): void => {
    captureNodeSizes(
      editor.getNodes().flatMap((node) => {
        const element = area.nodeViews.get(node.id)?.element;
        if (!element) return [];
        return [{ id: node.id, width: element.offsetWidth, height: element.offsetHeight }];
      }),
    );
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
        if (getLod() === 'full' && k < LOD_THRESHOLD) captureSizes();
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

  return {
    editor,
    area,
    Connection: ClassicPreset.Connection,
    destroy: () => {
      if (zoomFrame) cancelAnimationFrame(zoomFrame);
      resetLod();
      void area.destroy();
    },
    addNodes: async (count: number) => {
      // 先记录完整渲染下的尺寸：占位模式使用相同外框，避免缩放来回时连线端点漂移。
      if (getLod() === 'full' && area.area.transform.k >= LOD_THRESHOLD) captureSizes();
      // 先切占位再批量建点，避免 200 个真实控件同时挂载。
      if (area.area.transform.k < LOD_THRESHOLD) setLodZoom(area.area.transform.k);
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const node = createNode('gain');
        await editor.addNode(node);
        await area.translate(node.id, {
          x: 120 + (i % 20) * 200,
          y: 120 + Math.floor(i / 20) * 150,
        });
        ids.push(node.id);
      }
      return ids;
    },
    setZoom: async (zoom: number) => {
      // 同步入口（e2e 用）：立刻采样一次，避免依赖 rAF 的异步时机。
      if (getLod() === 'full' && zoom < LOD_THRESHOLD) captureSizes();
      await area.area.zoom(zoom);
      setLodZoom(zoom);
    },
  };
}

let nodeCounter = 0;

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
