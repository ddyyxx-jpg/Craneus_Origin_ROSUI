import { ClassicPreset } from 'rete';
import type { ParamConstraints, ParamValue, ParamValueType, ParamWidget } from '@rosui/ir';

export interface ControlChange {
  /** The validated value that should be written into the IR. */
  value: ParamValue;
  /** Raw committed text (kept locally even when invalid, for red-border feedback). */
  text: string;
  valid: boolean;
}

export type ControlValueChange = (change: ControlChange) => void;

export interface ControlBase {
  readonly id: string;
  readonly kind: ParamWidget;
  readonly constraints: ParamConstraints;
  readonly initial: ParamValue;
}

export interface NumberControlModel extends ControlBase {
  readonly kind: 'number';
  value?: number;
  text: string;
  valid: boolean;
  onChange?: ControlValueChange;
  setValue(value?: number): void;
  commitText(text: string): boolean;
}

export interface TextControlModel extends ControlBase {
  readonly kind: 'text';
  value: string;
  text: string;
  valid: boolean;
  onChange?: ControlValueChange;
  setValue(value: string): void;
  commitText(text: string): boolean;
}

export interface SelectControlModel extends ControlBase {
  readonly kind: 'select';
  value: string;
  text: string;
  valid: boolean;
  onChange?: ControlValueChange;
  setValue(value: string): void;
  commitText(text: string): boolean;
}

export interface BooleanControlModel extends ControlBase {
  readonly kind: 'boolean';
  value: boolean;
  text: string;
  valid: boolean;
  onChange?: ControlValueChange;
  setValue(value: boolean): void;
  commitText(text: string): boolean;
}

export const POSE_LABELS = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw'] as const;

export interface PoseControlModel extends ControlBase {
  readonly kind: 'pose';
  value: readonly number[];
  /** 各字段的待提交/错误文本；与 value 同步，单字段非法时保留原文用于红框提示。 */
  readonly fieldTexts: readonly string[];
  readonly errors: readonly (string | null)[];
  text: string;
  valid: boolean;
  onChange?: ControlValueChange;
  setValue(values: readonly number[]): void;
  commitField(index: number, text: string): boolean;
}

export type RosuiControl =
  | NumberControlModel
  | TextControlModel
  | SelectControlModel
  | BooleanControlModel
  | PoseControlModel;

export interface NumberOptions {
  initial?: number;
  min?: number;
  max?: number;
  step?: number;
  change?: ControlValueChange;
}

export interface TextOptions {
  initial?: string;
  minLength?: number;
  maxLength?: number;
  change?: ControlValueChange;
}

export interface SelectOptions {
  initial?: string;
  options: readonly string[];
  change?: ControlValueChange;
}

export interface BooleanOptions {
  initial?: boolean;
  change?: ControlValueChange;
}

export interface PoseOptions {
  initial?: readonly number[];
  labels?: readonly string[];
  change?: ControlValueChange;
}

/**
 * Built-in Rete InputControl subclass for numbers. It carries validation metadata
 * but still uses InputControl's own `change` protocol: `setValue()` invokes `change`.
 * The React renderer validates before calling setValue, so invalid input never
 * reaches this callback (and therefore never reaches the IR).
 */
export class NumberControl
  extends ClassicPreset.InputControl<'number', number>
  implements NumberControlModel
{
  readonly kind = 'number' as const;
  readonly constraints: ParamConstraints;
  readonly initial: number;
  text: string;
  valid = true;

  constructor(options: NumberOptions = {}) {
    const initial = options.initial ?? 0;
    // 不把 change 交给基类闭包：基类会记住构造时的回调，导致外部对 this.onChange 的包装（绑定层）
    // 对 number 控件失效。统一走 this.onChange，与 Text/Select/Boolean 一致。
    super('number', { initial });
    this.initial = initial;
    this.value = initial;
    this.text = String(initial);
    this.constraints = {
      ...(options.min === undefined ? {} : { min: options.min }),
      ...(options.max === undefined ? {} : { max: options.max }),
      ...(options.step === undefined ? {} : { step: options.step }),
    };
    this.onChange = options.change;
  }

  onChange?: ControlValueChange;

  override setValue(value?: number): void {
    const previous = this.value;
    super.setValue(value);
    this.value = value;
    this.text = String(this.value);
    this.valid = true;
    if (!Object.is(previous, value)) {
      this.onChange?.({ value: value as number, text: this.text, valid: true });
    }
  }

  commitText(text: string): boolean {
    const result = validateNumber(text, this.constraints);
    this.text = text;
    this.valid = result.valid;
    if (result.valid) {
      this.setValue(result.value);
    }
    return result.valid;
  }
}

export class TextControl extends ClassicPreset.Control implements TextControlModel {
  readonly kind = 'text' as const;
  readonly constraints: ParamConstraints;
  readonly initial: string;
  value: string;
  text: string;
  valid = true;
  onChange?: ControlValueChange;

  constructor(options: TextOptions = {}) {
    super();
    this.initial = options.initial ?? '';
    this.value = this.initial;
    this.text = this.initial;
    this.constraints = {
      ...(options.minLength === undefined ? {} : { min: options.minLength }),
      ...(options.maxLength === undefined ? {} : { max: options.maxLength }),
    };
    this.onChange = options.change;
  }

  setValue(value: string): void {
    this.value = value;
    this.text = value;
    this.valid = true;
    this.onChange?.({ value, text: value, valid: true });
  }

  commitText(text: string): boolean {
    const result = validateText(text, this.constraints);
    this.text = text;
    this.valid = result.valid;
    if (result.valid) {
      this.setValue(result.value);
    }
    return result.valid;
  }
}

export class SelectControl extends ClassicPreset.Control implements SelectControlModel {
  readonly kind = 'select' as const;
  readonly constraints: ParamConstraints;
  readonly initial: string;
  value: string;
  text: string;
  valid = true;
  onChange?: ControlValueChange;

  constructor(options: SelectOptions) {
    super();
    this.initial = options.initial ?? options.options[0] ?? '';
    this.value = this.initial;
    this.text = this.initial;
    this.constraints = { options: options.options };
    this.onChange = options.change;
  }

  setValue(value: string): void {
    this.value = value;
    this.text = value;
    this.valid = true;
    this.onChange?.({ value, text: value, valid: true });
  }

  commitText(text: string): boolean {
    const result = validateSelect(text, this.constraints.options ?? []);
    this.text = text;
    this.valid = result.valid;
    if (result.valid) {
      this.setValue(result.value);
    }
    return result.valid;
  }
}

export class BooleanControl extends ClassicPreset.Control implements BooleanControlModel {
  readonly kind = 'boolean' as const;
  readonly constraints: ParamConstraints = {};
  readonly initial: boolean;
  value: boolean;
  text: string;
  valid = true;
  onChange?: ControlValueChange;

  constructor(options: BooleanOptions = {}) {
    super();
    this.initial = options.initial ?? false;
    this.value = this.initial;
    this.text = String(this.initial);
    this.onChange = options.change;
  }

  setValue(value: boolean): void {
    this.value = value;
    this.text = String(value);
    this.valid = true;
    this.onChange?.({ value, text: this.text, valid: true });
  }

  commitText(text: string): boolean {
    this.text = text;
    if (text === 'true' || text === 'false') {
      this.setValue(text === 'true');
      return true;
    }
    this.valid = false;
    return false;
  }
}

/**
 * Pose 复杂控件：7 个独立字段，整体作为一个 double_array(7) 参数。
 * 继承 ClassicPreset.Control（不是单值 InputControl），每个字段通过 commitField 独立校验。
 */
export class PoseControl extends ClassicPreset.Control implements PoseControlModel {
  readonly kind = 'pose' as const;
  readonly constraints: ParamConstraints = {};
  readonly initial: readonly number[];
  readonly labels: readonly string[];
  value: readonly number[];
  fieldTexts: readonly string[];
  errors: readonly (string | null)[];
  text: string;
  valid = true;
  onChange?: ControlValueChange;

  constructor(options: PoseOptions = {}) {
    super();
    const initial = options.initial ?? [0, 0, 0, 0, 0, 0, 1];
    this.initial = [...initial];
    this.labels = options.labels ?? [...POSE_LABELS];
    this.value = [...initial];
    this.fieldTexts = initial.map((v) => String(v));
    this.errors = this.fieldTexts.map(() => null);
    this.text = JSON.stringify(this.value);
    this.onChange = options.change;
  }

  setValue(values: readonly number[]): void {
    const next = [...values];
    const changed = next.length !== this.value.length || next.some((v, i) => !Object.is(v, this.value[i]));
    this.value = next;
    this.fieldTexts = next.map((v) => String(v));
    this.errors = next.map(() => null);
    this.text = JSON.stringify(next);
    this.valid = true;
    if (changed) this.onChange?.({ value: next, text: this.text, valid: true });
  }

  commitField(index: number, text: string): boolean {
    if (index < 0 || index >= this.value.length) return false;
    const result = validateNumber(text, {});
    const nextTexts = [...this.fieldTexts];
    const nextErrors = [...this.errors];
    nextTexts[index] = text;
    nextErrors[index] = result.valid ? null : result.error;
    this.fieldTexts = nextTexts;
    this.errors = nextErrors;
    this.valid = nextErrors.every((error) => error === null) && this.value.length === 7;
    if (result.valid) {
      const next = [...this.value];
      next[index] = result.value;
      this.setValue(next);
      // setValue 会统一刷新 fieldTexts/errors；只保留其余字段的真实报错状态。
      this.errors = nextErrors.map((error, i) => (i === index ? null : error));
      this.fieldTexts = nextTexts;
    }
    return result.valid;
  }
}

export function validateNumber(
  raw: string,
  constraints: ParamConstraints,
): { valid: true; value: number } | { valid: false; error: string } {
  const text = raw.trim();
  if (text === '') return { valid: false, error: 'number required' };
  const value = Number(text);
  if (!Number.isFinite(value)) return { valid: false, error: 'must be a finite number' };
  if (constraints.min !== undefined && value < constraints.min) {
    return { valid: false, error: `must be ≥ ${constraints.min}` };
  }
  if (constraints.max !== undefined && value > constraints.max) {
    return { valid: false, error: `must be ≤ ${constraints.max}` };
  }
  if (constraints.step !== undefined && constraints.step > 0) {
    const origin = constraints.min ?? 0;
    const steps = (value - origin) / constraints.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) {
      return { valid: false, error: `must be a multiple of ${constraints.step}` };
    }
  }
  return { valid: true, value };
}

export function validateText(
  raw: string,
  constraints: ParamConstraints,
): { valid: true; value: string } | { valid: false; error: string } {
  if (raw.trim() === '') return { valid: false, error: 'text must not be empty' };
  if (constraints.min !== undefined && raw.length < constraints.min) {
    return { valid: false, error: `min length ${constraints.min}` };
  }
  if (constraints.max !== undefined && raw.length > constraints.max) {
    return { valid: false, error: `max length ${constraints.max}` };
  }
  return { valid: true, value: raw };
}

export function validateSelect(
  raw: string,
  options: readonly string[],
): { valid: true; value: string } | { valid: false; error: string } {
  return options.includes(raw)
    ? { valid: true, value: raw }
    : { valid: false, error: `choose one of: ${options.join(' | ')}` };
}

export function valueTypeForControl(kind: ParamWidget): ParamValueType {
  switch (kind) {
    case 'number':
      return 'double';
    case 'pose':
      return 'double_array';
    case 'text':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'select':
      return 'string';
    default:
      return 'string';
  }
}
