import type { ControlValueChange } from '../controls';
import type { RosuiControl } from '../controls/model';
import type { ParamValue } from '../ros';
import type { BoundControl, WriteOrigin } from './useParamBinding';
import {
  beginProgrammaticWrite,
  bumpControlVersion,
  endProgrammaticWrite,
  isProgrammaticWrite,
  setControlBound,
  setControlReadonly,
} from './controlState';

export interface ControlAdapterOptions {
  nodeType: string;
  portKey: string;
  control: RosuiControl;
  /** 节点实例 id：同类型多节点靠它区分绑定 entry。 */
  nodeId?: string;
  /** 用户合法改值（控件自身校验通过后）→ 回灌 ROS。 */
  onUserChange: (
    nodeType: string,
    portKey: string,
    value: ParamValue,
    nodeId?: string,
  ) => void;
}

/**
 * 把画布内联控件包装成绑定控制器可操作的 BoundControl。
 * 关键点：程序写值（init/ros/rollback）用 control.setValue 会触发 onChange，
 * 这里用 WeakSet 标记屏蔽，避免被误当作用户改值回灌 setParam。
 */
export function createControlAdapter(options: ControlAdapterOptions): BoundControl {
  const { control, onUserChange } = options;
  setControlBound(control, true);

  const originalChange = control.onChange;
  const guardedChange: ControlValueChange = (change) => {
    if (isProgrammaticWrite(control)) return;
    // 只放行「标量」与「标量数组」（pose 的 double_array）；普通对象/null/对象数组一律拦下，
    // 避免将来的 json widget 把对象直接写进 ROS 参数。
    const isScalar = (v: unknown): boolean =>
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
    const value = change.value;
    const isScalarArray = Array.isArray(value) && value.every(isScalar);
    if (change.valid && (isScalar(value) || isScalarArray)) {
      onUserChange(options.nodeType, options.portKey, value as ParamValue, options.nodeId);
    }
    originalChange?.(change);
  };
  control.onChange = guardedChange;

  return {
    nodeType: options.nodeType,
    portKey: options.portKey,
    get value() {
      return (control as RosuiControl & { value?: ParamValue }).value ?? null;
    },
    setValue(value: ParamValue, _origin: WriteOrigin) {
      beginProgrammaticWrite(control);
      try {
        applyControlValue(control, value);
      } finally {
        endProgrammaticWrite(control);
      }
      // 程序写值也要更新 IR（last gain / JSON 面板），但不回灌 ROS。
      // M3：数组是合法 ParamValue，直接传入，而不是降成空字符串。
      const irValue =
        Array.isArray(value) && value.every((v) => typeof v === 'number' || typeof v === 'string')
          ? (value as import('@rosui/ir').ParamValue)
          : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            ? value
            : '';
      originalChange?.({ value: irValue, text: JSON.stringify(value), valid: true });
      bumpControlVersion(control);
    },
    setReadonly(readonly: boolean) {
      setControlReadonly(control, readonly);
    },
  };
}

function applyControlValue(control: RosuiControl, value: ParamValue): void {
  switch (control.kind) {
    case 'number':
      if (typeof value === 'number') control.setValue(value);
      break;
    case 'text':
      if (typeof value === 'string') control.setValue(value);
      break;
    case 'select':
      if (typeof value === 'string') control.setValue(value);
      break;
    case 'boolean':
      if (typeof value === 'boolean') control.setValue(value);
      break;
    case 'pose':
      if (
        Array.isArray(value) &&
        value.length === 7 &&
        value.every((v) => typeof v === 'number' && Number.isFinite(v))
      ) {
        control.setValue(value as number[]);
      }
      break;
  }
}
