import { describe, expect, it } from 'vitest';
import { PoseControl } from './model';

function pose(): PoseControl {
  return new PoseControl({ initial: [0, 0, 0, 1, 0, 0, 1] });
}

describe('PoseControl', () => {
  it('单字段合法提交只改该字段，并触发一次 onChange', () => {
    const control = pose();
    const changes: unknown[] = [];
    control.onChange = (change) => changes.push(change.value);
    expect(control.commitField(0, '4.5')).toBe(true);
    expect(control.value).toEqual([4.5, 0, 0, 1, 0, 0, 1]);
    expect(control.valid).toBe(true);
    expect(changes).toEqual([[4.5, 0, 0, 1, 0, 0, 1]]);
  });

  it('非法输入不改值的数值、但记录该字段错误且整组 valid=false', () => {
    const control = pose();
    expect(control.commitField(1, 'abc')).toBe(false);
    expect(control.value[1]).toBe(0);
    expect(control.valid).toBe(false);
    expect(control.errors[1]).not.toBeNull();
  });

  it('某字段有错时，改另一个合法字段不会把整组洗成 valid', () => {
    const control = pose();
    expect(control.commitField(1, 'abc')).toBe(false);
    expect(control.commitField(2, '3')).toBe(true);
    expect(control.value[2]).toBe(3);
    // 关键回归：setValue 内部会置 valid=true，commitField 之后必须按全部字段重算。
    expect(control.valid).toBe(false);
    expect(control.errors[1]).not.toBeNull();
    expect(control.errors[2]).toBeNull();
  });

  it('程序写入长度不对时 valid=false（避免脏值被当成可回灌状态）', () => {
    const control = pose();
    control.setValue([1, 2, 3]);
    expect(control.valid).toBe(false);
  });
});
