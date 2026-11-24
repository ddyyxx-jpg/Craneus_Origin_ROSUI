import { ClassicPreset } from 'rete';
import type { ParamBinding, ParamValueType, ParamWidget } from '@rosui/ir';
import {
  BooleanControl,
  NumberControl,
  SelectControl,
  TextControl,
  valueTypeForControl,
  type RosuiControl,
} from '../controls';

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
    default:
      throw new Error(`Unsupported widget: ${String(definition.widget)}`);
  }
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
    return {
      node: this.id,
      param: this.spec.inputKey,
      valueType: this.spec.valueType,
      mode: 'static',
      widget: this.spec.widget,
      value: this.currentValue as ParamBinding['value'],
      constraints: this.control.constraints,
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
} as const satisfies Record<string, NodeSpec>;

export type NodeKind = keyof typeof NODE_REGISTRY;

export function createNode(
  kind: NodeKind,
  onChange?: (node: RosuiNode, value: unknown, valid: boolean) => void,
): RosuiNode {
  return new RosuiNode(NODE_REGISTRY[kind], onChange);
}

export function paramValueType(widget: ParamWidget): ParamValueType {
  return valueTypeForControl(widget);
}
