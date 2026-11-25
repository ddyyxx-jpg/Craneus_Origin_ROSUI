import { useEffect, useMemo, useState } from 'react';
import {
  bindingTypeFromRos,
  listRuntimeBindings,
  type BindingValueType,
  type ParamBindingDefinition,
} from './binding/bindings';
import type { ParamBindingRef, ParamValue, RosClient, RosStatus } from './ros';

export interface SelectedPort {
  instanceId: string;
  portKey: string;
  nodeType: string;
}

interface ParamRow {
  ref: ParamBindingRef;
  name: string;
  value: ParamValue | undefined;
  type: string;
}

function formatValue(value: ParamValue | undefined): string {
  if (value === undefined) return '—';
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  if (typeof value === 'number') return Number.isInteger(value) ? value.toFixed(1) : String(value);
  return String(value);
}

/** M4 A: 右侧参数浏览器 —— 连接后拉取参数名/当前值，订阅事件增量刷新（100ms 节流）。 */
export function ParamBrowser({
  client,
  status,
  selected,
  onBind,
  onUnbind,
  onTypeReject,
}: {
  client: RosClient;
  status: RosStatus;
  selected: SelectedPort | null;
  onBind: (ref: ParamBindingRef, valueType: BindingValueType) => void;
  onUnbind: (ref: ParamBindingRef) => void;
  onTypeReject: (reason: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const [rows, setRows] = useState<ParamRow[]>([]);
  const [bindingsVersion, setBindingsVersion] = useState(0);
  const connected = status === 'connected';

  useEffect(() => {
    if (!connected) {
      setRows([]);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refs = new Map<string, ParamBindingRef>();
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (disposed) return;
        void Promise.all(
          [...refs.values()].map(async (ref) => {
            const name = `${ref.node}:${ref.param}`;
            try {
              const result = await client.getParam(ref);
              return { ref, name, value: result.value, type: result.type } satisfies ParamRow;
            } catch {
              return { ref, name, value: undefined, type: 'unknown' } satisfies ParamRow;
            }
          }),
        ).then((next) => {
          if (!disposed) setRows(next);
        });
      }, 100);
    };
    void client.getParamNames().then((names) => {
      if (disposed) return;
      for (const name of names) {
        const colon = name.indexOf(':');
        if (colon < 0) continue;
        refs.set(name, { node: name.slice(0, colon), param: name.slice(colon + 1) });
      }
      refresh();
    });
    const unsubscribe = client.subscribeAllParamEvents(() => refresh());
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [client, connected]);

  const bindings = useMemo(() => {
    void bindingsVersion;
    return listRuntimeBindings();
  }, [bindingsVersion]);

  const grouped = useMemo(() => {
    const groups = new Map<string, ParamRow[]>();
    const needle = filter.trim().toLowerCase();
    for (const row of rows) {
      if (needle && !`${row.ref.node}:${row.ref.param}`.toLowerCase().includes(needle)) continue;
      const list = groups.get(row.ref.node) ?? [];
      list.push(row);
      groups.set(row.ref.node, list);
    }
    return [...groups.entries()];
  }, [rows, filter]);

  const boundRef = (ref: ParamBindingRef): ParamBindingDefinition | undefined => {
    if (!selected) return undefined;
    return bindings.find(
      (entry) =>
        entry.instanceId === selected.instanceId &&
        entry.nodeType === selected.nodeType &&
        entry.portKey === selected.portKey &&
        `${entry.definition.ref.node}:${entry.definition.ref.param}` ===
          `${ref.node}:${ref.param}`,
    )?.definition;
  };

  return (
    <aside className="param-panel" data-testid="param-browser">
      <div className="param-title">参数浏览器</div>
      <div className="param-selection" data-testid="selected-port">
        {selected ? `${selected.nodeType}.${selected.portKey}` : '未选中端口'}
      </div>
      <input
        className="param-filter"
        data-testid="param-filter"
        aria-label="参数过滤"
        placeholder="节点:参数 过滤"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="param-list">
        {!connected ? (
          <div className="param-empty">请先连接 ROS</div>
        ) : grouped.length === 0 ? (
          <div className="param-empty">无匹配参数</div>
        ) : (
          grouped.map(([node, params]) => (
            <div className="param-group" key={node}>
              <div className="param-group-title">{node}</div>
              {params.map((row) => {
                const active = boundRef(row.ref) !== undefined;
                return (
                  <div className="param-row" data-param={row.name} key={row.name}>
                    <span className="param-name">{row.ref.param}</span>
                    <span className="param-value">{formatValue(row.value)}</span>
                    {active ? (
                      <button
                        type="button"
                        data-testid="unbind-param"
                        data-param={row.name}
                        onClick={() => {
                          onUnbind(row.ref);
                          setBindingsVersion((version) => version + 1);
                        }}
                      >
                        解绑
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid="bind-param"
                        data-param={row.name}
                        onClick={() => {
                          if (!selected) {
                            onTypeReject('请先点击画布节点的标题或控件区选中端口');
                            return;
                          }
                          const valueType = bindingTypeFromRos(row.type);
                          if (!valueType) {
                            onTypeReject(`不支持的参数类型：${row.type}`);
                            return;
                          }
                          onBind(row.ref, valueType);
                          setBindingsVersion((version) => version + 1);
                        }}
                      >
                        绑定
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
