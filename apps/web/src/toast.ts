export type FailureKind = 'connect' | 'load' | 'bind' | 'write' | 'type' | 'validate';
export interface FailureInput { kind: FailureKind; param?: string; reason: string; }
const KIND_LABEL: Record<FailureKind, string> = {
  connect: '连接失败', load: '加载失败', bind: '绑定失败',
  write: '写入被拒', type: '类型不匹配', validate: '参数错误',
};
export function formatFailure({ kind, param, reason }: FailureInput): string {
  const subject = param ? `${param} ` : '';
  return `${KIND_LABEL[kind]}：${subject}${reason}`;
}
