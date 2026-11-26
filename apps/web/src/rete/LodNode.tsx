import { type ReactElement } from 'react';
import { Presets as ReactPresets, type ClassicScheme, type RenderEmit } from 'rete-react-plugin';
import { useLod, placeholderSize } from './lod';
import type { RosuiNode } from './nodes';

type NodeData = ClassicScheme['Node'] & { width?: number; height?: number };
type ClassicNodeComponent = (props: {
  data: NodeData;
  emit: RenderEmit<ClassicScheme>;
}) => ReactElement;

const ClassicNode = ReactPresets.classic.Node as unknown as ClassicNodeComponent;
const RefSocket = ReactPresets.classic.RefSocket as unknown as (props: {
  name: string;
  side: 'input' | 'output';
  socketKey: string;
  nodeId: string;
  emit: RenderEmit<ClassicScheme>;
  payload: unknown;
  'data-testid': string;
}) => ReactElement;

/** 占位尺寸回退值：实测经典节点 180×119，保证首帧也不塌陷。 */
const FALLBACK_SIZE = { width: 180, height: 119 };

/** 读取自定义节点类型标签，供占位标题使用。 */
function nodeKind(data: NodeData): string {
  const spec = (data as unknown as RosuiNode).spec;
  return spec?.type ?? 'Node';
}

/**
 * 缩放低于占位阈值时的节点：保留标题与输入/输出 socket DOM，隐藏真实控件。
 *
 * 不卸载 Rete 的 NodeView，只切 React 子树，因此 socket 在
 * SocketsPositionsStorage 中仍唯一。占位根节点复用 classic 的
 * node-shell/node/selected DOM 布局类，socket 几何与 full 模式逐像素一致。
 */
function PlaceholderNode({
  data,
  emit,
}: {
  data: NodeData;
  emit: RenderEmit<ClassicScheme>;
}): ReactElement {
  const size = placeholderSize(data.id) ?? FALLBACK_SIZE;
  const selected = (data as unknown as { selected?: boolean }).selected === true;
  const inputs = Object.entries(data.inputs);
  const outputs = Object.entries(data.outputs);
  return (
    <div
      className={`node-shell node node-lod node-lod-placeholder${selected ? ' selected' : ''}`}
      data-testid="node-lod"
      data-node-id={data.id}
      data-node-kind={nodeKind(data)}
      data-selected={selected ? 'true' : undefined}
      style={{ width: `${size.width}px`, height: `${size.height}px` }}
    >
      <div className="title" data-testid="title">{data.label}</div>
      {outputs.map(([key, output]) =>
        output ? (
          <div className="output" key={`out:${key}`} data-testid={`output-${key}`}>
            <span className="output-title" data-testid="output-title">{output.label}</span>
            <RefSocket
              name="output-socket"
              side="output"
              socketKey={key}
              nodeId={data.id}
              emit={emit}
              payload={output.socket}
              data-testid="output-socket"
            />
          </div>
        ) : null,
      )}
      {inputs.map(([key, input]) =>
        input ? (
          <div className="input" key={`in:${key}`} data-testid={`input-${key}`}>
            <RefSocket
              name="input-socket"
              side="input"
              socketKey={key}
              nodeId={data.id}
              emit={emit}
              payload={input.socket}
              data-testid="input-socket"
            />
            <span className="input-title" data-testid="input-title">{input.label}</span>
          </div>
        ) : null,
      )}
    </div>
  );
}

/**
 * 自定义节点（Inspector/Script）的 LOD 包装：full 透传原组件，
 * placeholder 走与尺寸一致的端口占位组件。
 */
export function withCustomNodeLod(
  renderFull: (props: { data: NodeData; emit: RenderEmit<ClassicScheme> }) => ReactElement,
): (props: { data: NodeData; emit: RenderEmit<ClassicScheme> }) => ReactElement {
  return function LodWrappedCustomNode(props): ReactElement {
    const lod = useLod();
    return lod === 'placeholder' ? <PlaceholderNode {...props} /> : renderFull(props);
  };
}

/** 所有节点共用的 LOD 包装：full 走原渲染器，placeholder 走端口占位。 */
export function withNodeLod(
  renderFull: (props: { data: NodeData; emit: RenderEmit<ClassicScheme> }) => ReactElement,
): (props: { data: NodeData; emit: RenderEmit<ClassicScheme> }) => ReactElement {
  return function LodWrappedNode(props): ReactElement {
    const lod = useLod();
    if (lod === 'placeholder') return <PlaceholderNode {...props} />;
    return renderFull(props);
  };
}

export function classicNodeRenderer(props: {
  data: NodeData;
  emit: RenderEmit<ClassicScheme>;
}): ReactElement {
  return <ClassicNode {...props} />;
}
