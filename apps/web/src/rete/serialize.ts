import { ClassicPreset } from 'rete';
import { parseGraph, type GraphIR, type NodeIR, type ParamBinding } from '@rosui/ir';
import type { EditorHandle } from './editor';
import { createNode, NODE_REGISTRY, type NodeKind, type RosuiNode } from './nodes';

/** 把 NODE_REGISTRY 的 type（如 Gain）反查为 kind（如 gain）；未知类型返回 undefined。 */
export function kindForType(type: string): NodeKind | undefined {
  const entry = (Object.entries(NODE_REGISTRY) as Array<[string, { readonly type: string }]>).find(
    ([, spec]) => spec.type.toLowerCase() === type.toLowerCase(),
  );
  return entry?.[0] as NodeKind | undefined;
}

/** 从单个 NodeIR 收集需要恢复到节点控件上的绑定值。 */
export function collectBindings(ir: NodeIR): ParamBinding[] {
  const bindingList = Object.values(ir.params);
  if (bindingList.length > 0) return bindingList;
  // 兼容空 params 的历史文档：至少要恢复该节点自己的默认值。
  const spec = NODE_REGISTRY[kindForType(ir.type) ?? ('' as NodeKind)];
  return spec
    ? [
        {
          node: ir.id,
          param: spec.inputKey,
          valueType: spec.valueType,
          mode: 'static',
          widget: spec.widget,
        },
      ]
    : [];
}

/**
 * 选择用于恢复节点的绑定：优先控件端口，Script 节点优先 code 绑定；
 * 其余绑定原样保留，交给节点 applyParamBinding 处理。
 */
export function bindingForNode(ir: NodeIR): ParamBinding | undefined {
  const spec = NODE_REGISTRY[kindForType(ir.type) ?? ('' as NodeKind)];
  const bindingList = collectBindings(ir);
  if (!spec) return bindingList[0];
  return (
    bindingList.find((binding) => binding.param === (ir.type === 'Script' ? 'code' : spec.inputKey)) ??
    bindingList.find((binding) => binding.param === spec.inputKey) ??
    bindingList[0]
  );
}

/** 导出当前编辑器状态为 GraphIR v1（完整 params / position / 端口）。 */
export function serializeGraph(handle: EditorHandle): GraphIR {
  return {
    version: 1,
    nodes: handle.editor.getNodes().map((node) => {
      const view = handle.area.nodeViews.get(node.id);
      const binding = node.toParamBinding();
      return {
        id: node.id,
        type: node.spec.type,
        position: view ? { x: view.position.x, y: view.position.y } : { x: 0, y: 0 },
        params: { [binding.param]: binding },
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

/** 恢复一个绑定值到节点：不触发 ROS 下发、不改运行时绑定表。 */
function restoreBinding(node: RosuiNode, binding: ParamBinding): void {
  if (typeof (node as RosuiNode & { applyParamBinding?: (b: ParamBinding) => void }).applyParamBinding === 'function') {
    (node as RosuiNode & { applyParamBinding: (b: ParamBinding) => void }).applyParamBinding(binding);
  }
}

/**
 * 加载 GraphIR v1 文档：先 zod 校验，再清空画布、按 type 重建节点/位置/值/连线。
 * 失败时抛错由调用方 toast；缺节点或缺端口的连线跳过，不让整张图加载失败。
 */
export async function loadGraph(handle: EditorHandle, input: unknown): Promise<void> {
  const ir = parseGraph(input);
  // Editor.clear() 走 noderemoved/connectionremoved 管道，area 会同步移除 DOM/视图，不泄漏。
  await handle.editor.clear();

  const nodes = new Map<string, RosuiNode>();
  for (const nodeIR of ir.nodes) {
    const kind = kindForType(nodeIR.type);
    if (!kind) continue;
    const node = createNode(kind, undefined);
    // Rete 的 node id 只能由 editor.addNode 生成；为了保留保存时的 id 引用与边端点，
    // 用 Object.defineProperty 覆盖只读 id（实例内部此前尚未使用 id，无副作用）。
    Object.defineProperty(node, 'id', { value: nodeIR.id, configurable: true });
    await handle.editor.addNode(node);
    const view = handle.area.nodeViews.get(node.id);
    if (view) await view.translate(nodeIR.position.x, nodeIR.position.y);
    const binding = bindingForNode(nodeIR);
    if (binding) {
      // 绑定里的 node 字段是保存时的引用（静态=节点 id，运行时=`节点:参数`），
      // 恢复时原样保留：节点 id 已按文件还原，运行时引用也留着供用户重新绑定。
      restoreBinding(node, binding);
    }
    nodes.set(nodeIR.id, node);
  }

  for (const edge of ir.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target || !source.outputs[edge.sourcePort] || !target.inputs[edge.targetPort]) continue;
    await handle.editor.addConnection(
      new ClassicPreset.Connection(source, edge.sourcePort, target, edge.targetPort) as never,
    );
  }
}
