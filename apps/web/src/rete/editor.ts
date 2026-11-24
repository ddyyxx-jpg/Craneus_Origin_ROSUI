import { createRoot } from 'react-dom/client';
import { ClassicPreset, NodeEditor, type GetSchemes } from 'rete';
import { AreaPlugin, AreaExtensions } from 'rete-area-plugin';
import { ConnectionPlugin, Presets as ConnectionPresets } from 'rete-connection-plugin';
import { ReactPlugin, type ReactArea2D } from 'rete-react-plugin';
import type { GraphIR } from '@rosui/ir';
import { registerControls } from '../controls';
import { RosuiNode, createNode, type NodeKind } from './nodes';

type Schemes = GetSchemes<
  RosuiNode,
  ClassicPreset.Connection<ClassicPreset.Node, ClassicPreset.Node>
>;
type Extra = ReactArea2D<Schemes>;

export interface EditorHandle {
  editor: NodeEditor<Schemes>;
  area: AreaPlugin<Schemes, Extra>;
  destroy: () => void;
}

/** Create the Rete node editor with area, connection and React rendering plugins. */
export async function createEditor(container: HTMLElement): Promise<EditorHandle> {
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

  return {
    editor,
    area,
    destroy: () => {
      void area.destroy();
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
  return {
    version: 1,
    nodes: handle.editor.getNodes().map((node) => {
      const view = handle.area.nodeViews.get(node.id);
      return {
        id: node.id,
        type: node.spec.type,
        position: view ? { x: view.position.x, y: view.position.y } : { x: 0, y: 0 },
        params: { [node.spec.inputKey]: node.toParamBinding() },
      };
    }),
    edges: handle.editor.getConnections().map((connection) => ({
      id: connection.id,
      source: connection.source,
      sourcePort: String(connection.sourceOutput),
      target: connection.target,
      targetPort: String(connection.targetInput),
    })),
  };
}
