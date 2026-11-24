import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ClassicPreset } from 'rete';
import { Drag, Presets as ReactPresets } from 'rete-react-plugin';
import type { GraphIR, ParamBinding } from '@rosui/ir';
import {
  BooleanControl,
  SelectControl,
  TextControl,
  validateNumber,
  validateSelect,
  validateText,
  type NumberControlModel,
  type RosuiControl,
} from './model';

/** Prevent canvas drag and stop keyboard events from reaching document-level shortcuts. */
function useControlEvents() {
  const ref = useRef<HTMLSpanElement | null>(null);
  Drag.useNoDrag(ref);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const swallow = (event: KeyboardEvent) => {
      if (event.key === ' ' || event.key === 'Spacebar') event.preventDefault();
      event.stopPropagation();
    };
    const stopPointer = (event: PointerEvent) => event.stopPropagation();
    element.addEventListener('keydown', swallow, true);
    element.addEventListener('keyup', swallow, true);
    element.addEventListener('pointerdown', stopPointer, true);
    return () => {
      element.removeEventListener('keydown', swallow, true);
      element.removeEventListener('keyup', swallow, true);
      element.removeEventListener('pointerdown', stopPointer, true);
    };
  }, []);

  return ref;
}

function errorFor(kind: RosuiControl['kind'], text: string, control: RosuiControl): string | null {
  switch (kind) {
    case 'number': {
      const result = validateNumber(text, control.constraints);
      return result.valid ? null : result.error;
    }
    case 'text': {
      const result = validateText(text, control.constraints);
      return result.valid ? null : result.error;
    }
    case 'select': {
      const result = validateSelect(text, control.constraints.options ?? []);
      return result.valid ? null : result.error;
    }
    case 'boolean':
      return null;
  }
}

function Feedback({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <span className="control-error" data-testid="control-error" role="alert">
      {error}
    </span>
  );
}

export function TextControlComponent({ data }: { data: TextControl }) {
  const ref = useControlEvents();
  const [text, setText] = useState(data.text);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(data.text), [data.text]);

  return (
    <span ref={ref} className="rosui-control" data-control-kind="text">
      <input
        type="text"
        className={error ? 'invalid' : undefined}
        data-testid="text-control"
        aria-label="text control"
        value={text}
        style={{ userSelect: 'all' }}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          setError(errorFor('text', next, data));
        }}
        onBlur={() => {
          if (!data.commitText(text)) setError(errorFor('text', text, data));
          else setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
      <Feedback error={error} />
    </span>
  );
}

export function SelectControlComponent({ data }: { data: SelectControl }) {
  const ref = useControlEvents();
  const [text, setText] = useState(data.text);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(data.text), [data.text]);

  return (
    <span ref={ref} className="rosui-control" data-control-kind="select">
      <select
        className={error ? 'invalid' : undefined}
        data-testid="select-control"
        aria-label="select control"
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (data.commitText(next)) setError(null);
          else setError(errorFor('select', next, data));
        }}
      >
        {(data.constraints.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <Feedback error={error} />
    </span>
  );
}

export function BooleanControlComponent({ data }: { data: BooleanControl }) {
  const ref = useControlEvents();
  return (
    <span ref={ref} className="rosui-control" data-control-kind="boolean">
      <button
        type="button"
        className={`toggle ${data.value ? 'on' : ''}`}
        data-testid="boolean-control"
        aria-label="boolean control"
        aria-pressed={data.value}
        onClick={() => {
          // Forcing a DOM render is required: Rete's element-level update doesn't re-mount
          // a control whose model stays the same reference.
          const next = !data.value;
          data.setValue(next);
          const button = ref.current?.querySelector('button');
          if (button) {
            button.setAttribute('aria-pressed', String(next));
            button.classList.toggle('on', next);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
      >
        <span className="toggle-knob" />
      </button>
    </span>
  );
}

/** Render a validated number control inline. Built-in InputControl handles `change` itself. */
export function NumberControlComponent({ data }: { data: NumberControlModel }) {
  const ref = useControlEvents();
  const [text, setText] = useState(data.text);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(data.text), [data.text]);

  return (
    <span ref={ref} className="rosui-control rosui-number-control" data-control-kind="number">
      <input
        type="text"
        inputMode="decimal"
        className={error ? 'invalid' : undefined}
        data-testid="number-control"
        aria-label="number control"
        value={text}
        style={{ userSelect: 'all' }}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          setError(errorFor('number', next, data));
        }}
        onBlur={() => {
          if (!data.commitText(text)) setError(errorFor('number', text, data));
          else setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
      <Feedback error={error} />
    </span>
  );
}

/** Read-only IR view used by e2e to verify that only valid values are exported. */
export function CurrentIR({ graph }: { graph: GraphIR | null }) {
  return (
    <pre className="ir-view" data-testid="current-ir">
      {graph ? JSON.stringify(graph, null, 2) : 'No graph yet'}
    </pre>
  );
}

/** Find a control value inside an IR document (test/debugging helper). */
export function findIRValue(graph: GraphIR, nodeId: string, param: string): ParamBinding | undefined {
  return graph.nodes.find((node) => node.id === nodeId)?.params[param];
}

/** The classic control renderer is generic over InputControl; the preset's Control
 *  payload is only typed as the base Control, so cast at the preset boundary. */
const ClassicControl = ReactPresets.classic.Control as unknown as (props: {
  data: ClassicPreset.Control;
}) => ReactElement;

/**
 * Register all custom control renderers. Built-in Rete InputControl MUST fall back
 * to ReactPresets.classic.Control, otherwise number/text controls disappear.
 */
export function registerControls() {
  return ReactPresets.classic.setup({
    customize: {
      control(ctx) {
        const payload = ctx.payload;
        if (payload instanceof TextControl) {
          return TextControlComponent as (props: { data: typeof payload }) => ReactElement;
        }
        if (payload instanceof SelectControl) {
          return SelectControlComponent as (props: { data: typeof payload }) => ReactElement;
        }
        if (payload instanceof BooleanControl) {
          return BooleanControlComponent as (props: { data: typeof payload }) => ReactElement;
        }
        if (payload instanceof ClassicPreset.InputControl) {
          return NumberControlComponent as (props: { data: typeof payload }) => ReactElement;
        }
        return ClassicControl;
      },
    },
  });
}
