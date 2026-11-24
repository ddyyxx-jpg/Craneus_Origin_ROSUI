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

export type RosuiControl =
  | NumberControlModel
  | TextControlModel
  | SelectControlModel
  | BooleanControlModel;

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
    super('number', {
      initial,
      change: (value) => options.change?.({ value, text: String(value), valid: true }),
    });
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
    super.setValue(value);
    this.value = value;
    this.text = String(this.value);
    this.valid = true;
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
