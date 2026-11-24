/**
 * 控件绑定态的外部注册表（按控件实例索引）。
 * 绑定层无需修改 M1 的控件模型类，React 渲染器通过订阅拿到状态。
 */
export interface ControlBindingState {
  readonly bound: boolean;
  readonly readonly: boolean;
  /** 程序写值版本号；递增时 React 控件重新从 model 读取 text/value。 */
  readonly version: number;
}

const stateByControl = new WeakMap<object, ControlBindingState>();
const listenersByControl = new WeakMap<object, Set<(state: ControlBindingState) => void>>();

function stateOf(control: object): ControlBindingState {
  return stateByControl.get(control) ?? { bound: false, readonly: false, version: 0 };
}

function update(control: object, patch: Partial<ControlBindingState>): void {
  const next = { ...stateOf(control), ...patch };
  stateByControl.set(control, next);
  listenersByControl.get(control)?.forEach((cb) => cb(next));
}

export function setControlBound(control: object, bound: boolean): void {
  update(control, { bound });
}

export function setControlReadonly(control: object, readonly: boolean): void {
  update(control, { readonly });
}

/** 程序写值后调用，通知 React 控件从 model 重新读取显示值。 */
export function bumpControlVersion(control: object): void {
  update(control, { version: stateOf(control).version + 1 });
}

export function getControlBindingState(control: object): ControlBindingState {
  return stateOf(control);
}

export function subscribeControlBindingState(
  control: object,
  cb: (state: ControlBindingState) => void,
): () => void {
  let set = listenersByControl.get(control);
  if (!set) {
    set = new Set();
    listenersByControl.set(control, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
  };
}

/** 程序写值标记：在 setValue 期间屏蔽 onChange → setParam 回灌。 */
const suppressed = new WeakSet<object>();

export function beginProgrammaticWrite(control: object): void {
  suppressed.add(control);
}

export function endProgrammaticWrite(control: object): void {
  suppressed.delete(control);
}

export function isProgrammaticWrite(control: object): boolean {
  return suppressed.has(control);
}
