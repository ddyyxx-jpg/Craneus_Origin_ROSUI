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
  /** 用户合法改值（控件自身校验通过后）→ 回灌 ROS。 */
  onUserChange: (nodeType: string, portKey: string, value: ParamValue) => void;
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
    if (change.valid && typeof change.value !== 'object') {
      onUserChange(options.nodeType, options.portKey, change.value as ParamValue);
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
      const irValue = typeof value === 'object' ? undefined : (value as string | number | boolean);
      originalChange?.({ value: irValue ?? '', text: String(value), valid: true });
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
  }
}
