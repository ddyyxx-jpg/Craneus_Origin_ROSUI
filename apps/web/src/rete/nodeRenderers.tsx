import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Drag, Presets as ReactPresets, type ClassicScheme, type RenderEmit } from 'rete-react-plugin';
import { listRuntimeBindings, type ParamBindingDefinition } from '../binding/bindings';
import { getSharedClient } from '../ros';
import { InspectorNode, ScriptNode } from './nodes';
import { classicNodeRenderer, withCustomNodeLod, withNodeLod } from './LodNode';

/** T-032：脚本失焦 / Ctrl+Enter 执行后作为一个提交边界。 */
const SCRIPT_COMMIT_EVENT = 'rosui:script-committed';

/** 订阅所有参数事件，100ms 节流刷新参数值（不依赖具体参数 ref）。 */
function useParamValues(refs: readonly ParamBindingDefinition['ref'][]) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const refsKey = refs.map((ref) => `${ref.node}:${ref.param}`).join('|');
  useEffect(() => {
    const client = getSharedClient();
    if (client.status !== 'connected') return;
    const list = refsKey ? refsKey.split('|') : [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (disposed) return;
        void Promise.all(
          list.map(async (name) => {
            const colon = name.indexOf(':');
            const ref = { node: name.slice(0, colon), param: name.slice(colon + 1) };
            try {
              const result = await client.getParam(ref);
              return [name, result.value] as const;
            } catch {
              return [name, undefined] as const;
            }
          }),
        ).then((entries) => {
          if (disposed) return;
          setValues(Object.fromEntries(entries));
        });
      }, 100);
    };
    const unsubscribe = client.subscribeAllParamEvents(() => refresh());
    refresh();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [refsKey]);
  return values;
}

function formatValue(value: unknown): string {
  if (value === undefined) return '—';
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  if (typeof value === 'number') return Number.isInteger(value) ? value.toFixed(1) : String(value);
  return String(value);
}

/** M4 B：节点内嵌的运行时绑定监视面板。 */
export function InspectorNodeComponent({
  data,
}: {
  data: InspectorNode;
}) {
  const bindings = listRuntimeBindings();
  const refs = bindings.map((entry) => entry.definition.ref);
  const values = useParamValues(refs);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 200);
    return () => clearInterval(timer);
  }, []);
  void tick;
  const selected = data.selected || false;
  return (
    <div className="node-shell" data-testid="node" data-node-id={data.id} data-node-kind="Inspector" data-selected={selected ? 'true' : undefined}>
      <div className="title" data-testid="title">{data.label}</div>
      <div
        className="inspector-panel"
        data-testid="inspector-panel"
        // 滚轮/指针事件不进画布：否则面板滚不动、画布反被缩放（Rete 监听 area 的 wheel）。
        onWheel={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {bindings.length === 0 ? (
          <div className="inspector-empty">暂无运行时绑定</div>
        ) : (
          bindings.map((entry, index) => {
            const name = `${entry.definition.ref.node}:${entry.definition.ref.param}`;
            return (
              <div className="inspector-row" data-testid="inspector-row" key={`${name}:${index}`}>
                <span className="inspector-port">{entry.nodeType}.{entry.portKey}</span>
                <span className="inspector-ref">{name}</span>
                <span className="inspector-value">{formatValue(values[name])}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** M4 C：节点内可编辑 JS 代码，失焦 / Ctrl+Enter 时在浏览器本地执行（无沙箱）。 */
export function ScriptNodeComponent({
  data,
  emit,
}: {
  data: ScriptNode;
  emit: RenderEmit<ClassicScheme>;
}) {
  const [code, setCode] = useState(data.code);
  const [version, setVersion] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  Drag.useNoDrag(textareaRef);
  const selected = data.selected || false;
  const run = (): void => {
    data.code = code;
    void data.run()
      .then(() => setVersion((value) => value + 1))
      .finally(() => window.dispatchEvent(new CustomEvent(SCRIPT_COMMIT_EVENT, { detail: data.id })))
      .catch(() => undefined);
  };
  useEffect(() => {
    setCode(data.code);
  }, [data.code]);
  return (
    <div className="node-shell" data-testid="node" data-node-id={data.id} data-node-kind="Script" data-selected={selected ? 'true' : undefined}>
      <div className="title" data-testid="title">{data.label}</div>
      <div className="output" data-testid="output-out">
        <span className="output-title" data-testid="output-title">out</span>
        <ReactPresets.classic.RefSocket
          name="output-socket"
          side="output"
          socketKey="out"
          nodeId={data.id}
          emit={emit}
          payload={data.outputs.out!.socket}
        />
      </div>
      <div className="input" data-testid="input-x">
        <ReactPresets.classic.RefSocket
          name="input-socket"
          side="input"
          socketKey="x"
          nodeId={data.id}
          emit={emit}
          payload={data.inputs.x!.socket}
        />
        <span className="input-title" data-testid="input-title">x</span>
        <ReactPresets.classic.RefControl name="input-control" emit={emit} payload={data.control} />
      </div>
      <textarea
        ref={textareaRef}
        className="script-editor"
        data-testid="script-editor"
        aria-label="script editor"
        spellCheck={false}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        onBlur={run}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            run();
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
      />
      {data.error ? (
        <div className="script-error" data-testid="script-error" role="alert" key={`e${version}`}>
          {data.error}
        </div>
      ) : (
        <div className="script-result" data-testid="script-result" key={`r${version}`}>
          out: {data.result === null ? '—' : formatValue(data.result)}
        </div>
      )}
    </div>
  );
}

/** Preset customize.node: only Inspector/Script use custom rendering; others stay classic. */
export function customNode(
  data: { payload: unknown },
): ((props: { data: unknown; emit: RenderEmit<ClassicScheme> }) => ReactElement) | null {
  const payload = data.payload;
  if (payload instanceof InspectorNode) {
    return withCustomNodeLod((props) => (
      <InspectorNodeComponent data={props.data as unknown as InspectorNode} />
    )) as (props: { data: unknown; emit: RenderEmit<ClassicScheme> }) => ReactElement;
  }
  if (payload instanceof ScriptNode) {
    return withCustomNodeLod((props) => (
      <ScriptNodeComponent data={props.data as unknown as ScriptNode} emit={props.emit} />
    )) as (props: { data: unknown; emit: RenderEmit<ClassicScheme> }) => ReactElement;
  }
  // Preset does NOT fall back when customize.node returns null — must return classic Node.
  return withNodeLod(classicNodeRenderer) as (
    props: { data: unknown; emit: RenderEmit<ClassicScheme> },
  ) => ReactElement;
}
