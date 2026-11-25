import { ClassicPreset } from 'rete';
import { runScript } from './scriptRunner';
import type { ParamBinding, ParamValueType, ParamWidget } from '@rosui/ir';
import {
  BooleanControl,
  NumberControl,
  PoseControl,
  SelectControl,
  TextControl,
  valueTypeForControl,
  type RosuiControl,
} from '../controls';
import { runtimeBindingFor } from '../binding/bindings';

export interface NodeSpec {
  type: string;
  label: string;
  inputKey: string;
  inputLabel: string;
  widget: ParamWidget;
  valueType: ParamValueType;
  initial: unknown;
  constraints?: Record<string, unknown>;
}

interface ParamDefinition {
  widget: ParamWidget;
  label: string;
  initial?: unknown;
  constraints?: Record<string, unknown>;
}

export function buildControl(
  _key: string,
  definition: ParamDefinition,
  onChange?: (value: unknown, valid: boolean) => void,
): RosuiControl {
  const common = {
    change: (change: { value: unknown; valid: boolean }) => onChange?.(change.value, change.valid),
  };
  switch (definition.widget) {
    case 'number': {
      const c = definition.constraints ?? {};
      return new NumberControl({
        ...common,
        initial: typeof definition.initial === 'number' ? definition.initial : 0,
        min: typeof c.min === 'number' ? c.min : undefined,
        max: typeof c.max === 'number' ? c.max : undefined,
        step: typeof c.step === 'number' ? c.step : undefined,
      });
    }
    case 'text':
      return new TextControl({
        ...common,
        initial: typeof definition.initial === 'string' ? definition.initial : '',
      });
    case 'select':
      return new SelectControl({
        ...common,
        initial: typeof definition.initial === 'string' ? definition.initial : '',
        options: Array.isArray(definition.constraints?.options)
          ? (definition.constraints.options as string[])
          : [],
      });
    case 'boolean':
      return new BooleanControl({
        ...common,
        initial: typeof definition.initial === 'boolean' ? definition.initial : false,
      });
    case 'pose': {
      const initial = Array.isArray(definition.initial)
        ? definition.initial.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
        : [];
      return new PoseControl({ ...common, initial });
    }
    default:
      throw new Error(`Unsupported widget: ${String(definition.widget)}`);
  }
}

/** M4 A: BindingValueType 的 'bool' 对应 IR 的 'boolean'。 */
function irValueType(valueType: string): ParamValueType {
  return valueType === 'bool' ? 'boolean' : (valueType as ParamValueType);
}

export class RosuiNode extends ClassicPreset.Node {
  readonly spec: NodeSpec;
  readonly control: RosuiControl;
  currentValue: unknown;

  constructor(
    spec: NodeSpec,
    onChange?: (node: RosuiNode, value: unknown, valid: boolean) => void,
  ) {
    super(spec.label);
    this.spec = spec;
    this.currentValue = spec.initial;
    this.control = buildControl(
      spec.inputKey,
      {
        widget: spec.widget,
        label: spec.inputLabel,
        initial: spec.initial,
        constraints: spec.constraints,
      },
      (value, valid) => {
        this.currentValue = value;
        onChange?.(this, value, valid);
      },
    );

    const socket = new ClassicPreset.Socket(spec.valueType);
    const input = new ClassicPreset.Input(socket, spec.inputLabel);
    // Every node's single param control is inline on its input port.
    input.addControl(this.control);
    this.addInput(spec.inputKey, input);
    this.addOutput('out', new ClassicPreset.Output(socket, 'out'));
  }

  toParamBinding(): ParamBinding {
    // M4 A: 运行时绑定在 IR 中以 mode:'runtime' 暴露，node/param 记录 ROS 目标，
    // 控件本地值另存 value；无运行期绑定时保持 M1-M3 的静态结构不变。
    const runtime = runtimeBindingFor(this.spec.type, this.spec.inputKey, this.id);
    return {
      node: runtime ? `${runtime.ref.node}:${runtime.ref.param}` : this.id,
      param: runtime ? this.spec.inputKey : this.spec.inputKey,
      valueType: runtime ? irValueType(runtime.valueType) : this.spec.valueType,
      mode: runtime ? 'runtime' : 'static',
      widget: this.spec.widget,
      value: this.currentValue as ParamBinding['value'],
      constraints: this.control.constraints,
    };
  }
}

/** M4 B: node that renders a live, scrollable DOMWidget panel of all runtime bindings. */
export class InspectorNode extends ClassicPreset.Node {
  readonly spec: NodeSpec = {
    type: 'Inspector',
    label: 'Inspector',
    inputKey: 'inspector',
    inputLabel: 'bindings',
    widget: 'json',
    valueType: 'string',
    initial: '',
  };

  constructor() {
    super('Inspector');
  }

  toParamBinding(): ParamBinding {
    return {
      node: this.id,
      param: 'inspector',
      valueType: 'string',
      mode: 'static',
      widget: 'json',
      value: '',
    };
  }
}

/** M4 C: node with a locally editable JS expression and one number input/output. */
export class ScriptNode extends ClassicPreset.Node {
  readonly spec: NodeSpec = {
    type: 'Script',
    label: 'Script',
    inputKey: 'x',
    inputLabel: 'x',
    widget: 'number',
    valueType: 'double',
    initial: 1,
  };
  readonly control: NumberControl;
  code = 'return x * 2;';
  result: number | string | null = null;
  error: string | null = null;
  currentValue: unknown = 1;

  constructor(onChange?: (node: ScriptNode, value: unknown, valid: boolean) => void) {
    super('Script');
    this.control = new NumberControl({
      initial: 1,
      change: (change) => {
        if (!change.valid) return;
        this.currentValue = change.value;
        onChange?.(this, change.value, change.valid);
      },
    });
    const numberSocket = new ClassicPreset.Socket('double');
    const input = new ClassicPreset.Input(numberSocket, 'x');
    input.addControl(this.control);
    this.addInput('x', input);
    this.addOutput('out', new ClassicPreset.Output(numberSocket, 'out'));
  }

  /** 用户脚本在自己的 Worker 里执行，超时 terminate（见 scriptRunner.ts）；
   *  不是安全沙箱，别贴不可信代码。 */
  async run(): Promise<void> {
    this.error = null;
    const outcome = await runScript(this.code, this.control.value ?? 0);
    if (outcome.ok) {
      this.result = outcome.value;
      this.error = null;
    } else {
      this.result = null;
      this.error = outcome.error;
    }
  }

  toParamBinding(): ParamBinding {
    return {
      node: this.id,
      param: 'code',
      valueType: 'string',
      mode: 'static',
      widget: 'text',
      value: this.code,
    };
  }
}

export const NODE_REGISTRY = {
  gain: {
    type: 'Gain',
    label: 'Gain',
    inputKey: 'gain',
    inputLabel: 'gain',
    widget: 'number',
    valueType: 'double',
    initial: 1,
    constraints: { min: 0, max: 10, step: 0.1 },
  },
  threshold: {
    type: 'Threshold',
    label: 'Threshold',
    inputKey: 'value',
    inputLabel: 'value',
    widget: 'number',
    valueType: 'double',
    initial: 0.5,
    constraints: { min: 0, max: 1 },
  },
  label: {
    type: 'Label',
    label: 'Label',
    inputKey: 'name',
    inputLabel: 'name',
    widget: 'text',
    valueType: 'string',
    initial: 'rosui',
  },
  mode: {
    type: 'Mode',
    label: 'Mode',
    inputKey: 'mode',
    inputLabel: 'mode',
    widget: 'select',
    valueType: 'string',
    initial: 'normal',
    constraints: { options: ['low', 'normal', 'high'] },
  },
  switch: {
    type: 'Switch',
    label: 'Switch',
    inputKey: 'enabled',
    inputLabel: 'enabled',
    widget: 'boolean',
    valueType: 'boolean',
    initial: false,
  },
  pose: {
    type: 'Pose',
    label: 'Pose',
    inputKey: 'pose',
    inputLabel: 'pose',
    widget: 'pose',
    valueType: 'double_array',
    initial: [0, 0, 0, 0, 0, 0, 1],
  },
  inspector: {
    type: 'Inspector',
    label: 'Inspector',
    inputKey: 'inspector',
    inputLabel: 'bindings',
    widget: 'json',
    valueType: 'string',
    initial: '',
  },
  script: {
    type: 'Script',
    label: 'Script',
    inputKey: 'x',
    inputLabel: 'x',
    widget: 'number',
    valueType: 'double',
    initial: 1,
  },
} as const satisfies Record<string, NodeSpec>;

export type NodeKind = keyof typeof NODE_REGISTRY;

export function createNode(
  kind: NodeKind,
  onChange?: (node: RosuiNode, value: unknown, valid: boolean) => void,
): RosuiNode {
  if (kind === 'inspector') return new InspectorNode() as unknown as RosuiNode;
  if (kind === 'script') {
    // 脚本节点没有内联 ROS 控件；IR 的 value 存代码字符串。
    return new ScriptNode() as unknown as RosuiNode;
  }
  return new RosuiNode(NODE_REGISTRY[kind], onChange);
}

export function paramValueType(widget: ParamWidget): ParamValueType {
  return valueTypeForControl(widget);
}
