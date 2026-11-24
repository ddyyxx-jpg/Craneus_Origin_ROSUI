import { createRoot } from 'react-dom/client';
import { NodeEditor, ClassicPreset, type GetSchemes } from 'rete';
import { AreaPlugin, AreaExtensions } from 'rete-area-plugin';
import { ConnectionPlugin, Presets as ConnectionPresets } from 'rete-connection-plugin';
import { ReactPlugin, Presets as ReactPresets, type ReactArea2D } from 'rete-react-plugin';
import type { GraphIR } from '@rosui/ir';

type Schemes = GetSchemes<
  ClassicPreset.Node,
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
  react.addPreset(ReactPresets.classic.setup<Schemes, Extra>());

  editor.use(area);
  area.use(connection);
  area.use(react);

  // Official extension: hides an input's inline control while connected, restores it on disconnect.
  // It internally listens to connectioncreated / connectionremoved and refreshes via area.update('node', id).
  AreaExtensions.showInputControl(area);

  return {
    editor,
    area,
    destroy: () => {
      void area.destroy();
    },
  };
}

/** A Gain node: one `gain` number input with inline control, one `out` output. */
export class GainNode extends ClassicPreset.Node {
  constructor(initialGain = 1, onChange?: (value: number) => void) {
    super('Gain');

    const socket = new ClassicPreset.Socket('number');
    const input = new ClassicPreset.Input(socket, 'gain');
    const control = new ClassicPreset.InputControl('number', {
      initial: initialGain,
      change: (value) => onChange?.(value),
    });

    // Important: inline control belongs to the input port, not the node.
    input.addControl(control);
    this.addInput('gain', input);
    this.addOutput('out', new ClassicPreset.Output(socket, 'out'));
  }
}

/** Add a Gain node at the given canvas position. */
export async function addGainNode(
  handle: EditorHandle,
  x: number,
  y: number,
  onChange?: (value: number) => void,
): Promise<GainNode> {
  const node = new GainNode(1, onChange);
  await handle.editor.addNode(node);
  await handle.area.translate(node.id, { x, y });
  return node;
}

/** Connect two nodes' ports. */
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
    new ClassicPreset.Connection(sourceNode, sourceOutput, targetNode, targetInput),
  );
}

/** Export the current editor state into a GraphIR v0 document. */
export function toGraphIR(handle: EditorHandle): GraphIR {
  return {
    version: 1,
    nodes: handle.editor.getNodes().map((node) => {
      const view = handle.area.nodeViews.get(node.id);
      return {
        id: node.id,
        type: node.label || 'Unknown',
        position: view ? { x: view.position.x, y: view.position.y } : { x: 0, y: 0 },
        params: Object.fromEntries(
          Object.keys(node.inputs).map((key) => [
            key,
            {
              node: node.id,
              param: key,
              valueType: 'double' as const,
              mode: 'static' as const,
              widget: 'number' as const,
            },
          ]),
        ),
      };
    }),
    edges: handle.editor.getConnections().map((connection) => ({
      id: connection.id,
      source: connection.source,
      sourcePort: connection.sourceOutput,
      target: connection.target,
      targetPort: connection.targetInput,
    })),
  };
}
