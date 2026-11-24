import { z } from 'zod';

// ---------------------------------------------------------------------------
// GraphIR v1 — static type definitions
// ---------------------------------------------------------------------------

export type ParamValueType = 'double' | 'integer' | 'boolean' | 'string' | 'string_array';
export type ParamMode = 'static' | 'runtime';
export type ParamWidget = 'number' | 'text' | 'boolean' | 'select' | 'pose' | 'json';

/** 参数当前值：与 ROS 参数标量类型对齐（string_array 用字符串数组）。 */
export type ParamValue = number | string | boolean | readonly (number | string)[];

export interface ParamConstraints {
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
  unit?: string;
}

/** A parameter binding: either a literal value or a reference to another node's param. */
export interface ParamBinding {
  node: string;
  param: string;
  valueType: ParamValueType;
  mode: ParamMode;
  widget: ParamWidget;
  value?: ParamValue;
  constraints?: ParamConstraints;
}

export interface NodeIR {
  id: string;
  type: string;
  position: { x: number; y: number };
  params: Record<string, ParamBinding>;
}

export interface EdgeIR {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
}

/** GraphIR v1 document. */
export interface GraphIR {
  version: 1;
  nodes: NodeIR[];
  edges: EdgeIR[];
}

// ---------------------------------------------------------------------------
// zod schema (runtime validation)
// ---------------------------------------------------------------------------

const paramValueTypeSchema = z.enum(['double', 'integer', 'boolean', 'string', 'string_array']);
const paramModeSchema = z.enum(['static', 'runtime']);
const paramWidgetSchema = z.enum(['number', 'text', 'boolean', 'select', 'pose', 'json']);

const paramConstraintsSchema = z
  .object({
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    step: z.number().positive().optional(),
    options: z.array(z.string()).optional(),
    unit: z.string().optional(),
  })
  .strict();

export const paramBindingSchema = z
  .object({
    node: z.string().min(1),
    param: z.string().min(1),
    valueType: paramValueTypeSchema,
    mode: paramModeSchema,
    widget: paramWidgetSchema,
    value: z
      .union([z.number().finite(), z.string(), z.boolean(), z.array(z.union([z.number(), z.string()]))])
      .optional(),
    constraints: paramConstraintsSchema.optional(),
  })
  .strict();

export const nodeIRSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    position: z
      .object({ x: z.number().finite(), y: z.number().finite() })
      .strict(),
    params: z.record(paramBindingSchema),
  })
  .strict();

export const edgeIRSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    sourcePort: z.string().min(1),
    target: z.string().min(1),
    targetPort: z.string().min(1),
  })
  .strict();

export const graphIRSchema = z
  .object({
    version: z.literal(1),
    nodes: z.array(nodeIRSchema),
    edges: z.array(edgeIRSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// parseGraph
// ---------------------------------------------------------------------------

export class GraphIRParseError extends Error {
  readonly issues: readonly z.ZodIssue[];

  constructor(issues: readonly z.ZodIssue[]) {
    const first = issues[0];
    const detail = first
      ? `${first.path.join('.') || '<root>'}: ${first.message}`
      : 'unknown validation error';
    super(`Invalid GraphIR: ${detail}`);
    this.name = 'GraphIRParseError';
    this.issues = issues;
  }
}

/**
 * Parse and validate an unknown value as a GraphIR v1 document.
 * Throws GraphIRParseError with all zod issues when validation fails.
 */
export function parseGraph(input: unknown): GraphIR {
  const result = graphIRSchema.safeParse(input);
  if (!result.success) {
    throw new GraphIRParseError(result.error.issues);
  }
  return result.data;
}
