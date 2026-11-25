import { useEffect, useMemo, useRef, useState } from 'react';
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

  const eventValues = useRef(new Map<string, ParamValue | undefined>());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  // 默认收起：连接后一次性拉全量参数会打爆 rosapi（每个参数一次 getParam），
  // 还会拖慢绑定层的初值拉取。展开时才加载，收起时不发任何请求。
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!connected || !open) {
      setRows([]);
      eventValues.current.clear();
      return;
    }
    let disposed = false;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    setLoadError(null);
    const flush = (): void => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        if (!disposed) setRows((prev) => [...prev]);
      }, 100);
    };
    const refs = new Map<string, ParamBindingRef>();
    void client
      .getParamNames()
      .then(async (names) => {
        if (disposed) return;
        for (const name of names) {
          const colon = name.indexOf(':');
          if (colon < 0) continue;
          refs.set(name, { node: name.slice(0, colon), param: name.slice(colon + 1) });
        }
        // 并发 getParam 会打爆 rosapi：35 个参数一起发，后几个经常超时变 unknown。
        // 限制在 4 个并发，慢一点但稳。
        const entries = [...refs.entries()];
        const rows: ParamRow[] = new Array(entries.length);
        let cursor = 0;
        const worker = async (): Promise<void> => {
          for (;;) {
            const index = cursor;
            cursor += 1;
            const entry = entries[index];
            if (!entry) return;
            const [name, ref] = entry;
            try {
              const result = await client.getParam(ref);
              rows[index] = { ref, name, value: result.value, type: result.type };
            } catch {
              rows[index] = { ref, name, value: undefined, type: 'unknown' };
            }
            if (disposed) return;
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        return rows;
      })
      .then((initial) => {
        if (disposed || !initial) return;
        setRows(initial);
        // 个别行 getParam 失败（rosapi 忙/瞬断）时不要永久停在 unknown：退避重试 3 次。
        let pendingRefs = initial
          .filter((row) => row.type === 'unknown')
          .map((row) => refs.get(row.name))
          .filter((ref): ref is ParamBindingRef => ref !== undefined);
        void (async () => {
          for (let attempt = 1; attempt <= 3 && pendingRefs.length > 0; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
            if (disposed) return;
            const fixed = new Map<string, { value: ParamValue; type: string }>();
            await Promise.all(
              pendingRefs.map(async (ref) => {
                try {
                  const result = await client.getParam(ref);
                  fixed.set(`${ref.node}:${ref.param}`, { value: result.value, type: result.type });
                } catch {
                  /* 保留 unknown，交给下一轮 */
                }
              }),
            );
            if (disposed || fixed.size === 0) continue;
            setRows((prev) =>
              prev.map((row) => {
                const next = fixed.get(`${row.ref.node}:${row.ref.param}`);
                return next ? { ...row, value: next.value, type: next.type } : row;
              }),
            );
            pendingRefs = pendingRefs.filter((ref) => !fixed.has(`${ref.node}:${ref.param}`));
          }
        })();
      })
      .catch((caught: unknown) => {
        if (disposed) return;
        setLoadError(`参数列表拉取失败：${caught instanceof Error ? caught.message : String(caught)}`);
      });
    // 事件里已经带值：直接用，别每来一条事件就对全部参数 getParam 一轮（参数多会打爆 rosbridge）。
    /** 运行中新出现的参数：补一行（类型只能 getParam 一次拿到），之后走事件值。 */
    const addDiscovered = (name: string, value: ParamValue): void => {
      if (refs.has(name)) return;
      const colon = name.indexOf(':');
      if (colon < 0) return;
      const ref: ParamBindingRef = { node: name.slice(0, colon), param: name.slice(colon + 1) };
      refs.set(name, ref);
      eventValues.current.set(name, value);
      void client
        .getParam(ref)
        .then((result) => {
          if (disposed) return;
          setRows((prev) =>
            prev.some((row) => row.name === name)
              ? prev
              : [...prev, { ref, name, value: result.value, type: result.type }],
          );
        })
        .catch(() => undefined);
    };

    const unsubscribe = client.subscribeAllParamEvents((evt) => {
      let touched = false;
      for (const entry of [...evt.newParameters, ...evt.changedParameters]) {
        const name = `${evt.node}:${entry.name}`;
        if (!refs.has(name)) {
          addDiscovered(name, entry.value);
          continue;
        }
        eventValues.current.set(name, entry.value);
        touched = true;
      }
      for (const entry of evt.deletedParameters) {
        const name = `${evt.node}:${entry.name}`;
        if (!refs.has(name)) continue;
        eventValues.current.set(name, undefined);
        touched = true;
      }
      if (touched) flush();
    });
    return () => {
      disposed = true;
      if (flushTimer) clearTimeout(flushTimer);
      unsubscribe();
    };
  }, [client, connected, open, reloadToken]);

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
      <div className="param-title">
        参数浏览器
        <button
          type="button"
          className="param-toggle"
          data-testid="param-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? '收起' : '展开'}
        </button>
      </div>
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
        {!open ? (
          <div className="param-empty">已收起（展开后加载参数）</div>
        ) : !connected ? (
          <div className="param-empty">请先连接 ROS</div>
        ) : loadError ? (
          <div className="param-error" data-testid="param-error" role="alert">
            <div>{loadError}</div>
            <button type="button" data-testid="param-retry" onClick={() => setReloadToken((value) => value + 1)}>
              重试
            </button>
          </div>
        ) : grouped.length === 0 ? (
          <div className="param-empty">无匹配参数</div>
        ) : (
          grouped.map(([node, params]) => (
            <div className="param-group" key={node}>
              <div className="param-group-title">{node}</div>
              {params.map((row) => {
                const active = boundRef(row.ref) !== undefined;
                return (
                  <div className="param-row" data-testid="param-row" data-param={row.name} key={row.name}>
                    <span className="param-name">{row.ref.param}</span>
                    <span className="param-value">
                      {formatValue(
                        eventValues.current.has(row.name)
                          ? eventValues.current.get(row.name)
                          : row.value,
                      )}
                    </span>
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
                        disabled={row.type === 'unknown'}
                        title={row.type === 'unknown' ? '参数类型拉取失败，稍后自动重试' : undefined}
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
