import { describe, expect, it } from 'vitest';
import { loadToast } from './loadToast';

describe('loadToast', () => {
  it('两类提示同时存在时合并展示，互不覆盖', () => {
    expect(loadToast(2, 1)).toBe('2 个运行期绑定未恢复；已加载脚本节点，运行前请确认来源');
  });

  it('只有运行期绑定失败时只显示绑定提示', () => {
    expect(loadToast(1, 0)).toBe('1 个运行期绑定未恢复');
  });

  it('只有脚本节点时只显示来源提示', () => {
    expect(loadToast(0, 1)).toBe('已加载脚本节点，运行前请确认来源');
  });

  it('两者都没有时清空提示', () => {
    expect(loadToast(0, 0)).toBe('');
  });
});
