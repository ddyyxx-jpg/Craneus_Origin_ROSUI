import { describe, expect, it } from 'vitest';
import { formatFailure, type FailureKind } from './toast';

const KIND_PREFIX: Record<FailureKind, string> = {
  connect: '连接失败',
  load: '加载失败',
  bind: '绑定失败',
  write: '写入被拒',
  type: '类型不匹配',
  validate: '参数错误',
};

describe('formatFailure', () => {
  it('每种 kind 使用固定前缀，且不带 param 时前缀后紧跟 reason', () => {
    for (const kind of Object.keys(KIND_PREFIX) as FailureKind[]) {
      expect(formatFailure({ kind, reason: '具体原因' })).toBe(`${KIND_PREFIX[kind]}：具体原因`);
    }
  });

  it('param 紧跟前缀并保留 nodeType.portKey', () => {
    expect(formatFailure({ kind: 'type', param: 'Gain.gain', reason: '控件不接受 string 类型参数' })).toBe(
      '类型不匹配：Gain.gain 控件不接受 string 类型参数',
    );
    expect(formatFailure({ kind: 'write', param: 'Mode.mode', reason: '越界' })).toBe(
      '写入被拒：Mode.mode 越界',
    );
    expect(formatFailure({ kind: 'bind', param: 'Switch.switch', reason: '未注册' })).toBe(
      '绑定失败：Switch.switch 未注册',
    );
  });

  it('reason 原样保留，不改写标点或空白', () => {
    const reason = 'rollback probe: addConnection failed once';
    expect(formatFailure({ kind: 'load', reason })).toBe(`加载失败：${reason}`);
    expect(formatFailure({ kind: 'load', reason: '  原始  reason  ' })).toBe('加载失败：  原始  reason  ');
  });

  it('空 reason 产出前缀（param 存在时保留主题与尾随空格）', () => {
    expect(formatFailure({ kind: 'load', reason: '' })).toBe('加载失败：');
    expect(formatFailure({ kind: 'validate', param: '/rosui_demo:mode', reason: '' })).toBe(
      '参数错误：/rosui_demo:mode ',
    );
  });
});
