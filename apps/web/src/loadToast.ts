/**
 * 加载成功后的提示文案：运行期绑定失败与脚本来源提示互不覆盖，同时出现时用分号合并。
 * 纯函数，便于单测覆盖「两者都有 / 只有其一 / 都没有」四种组合。
 */
export function loadToast(failedBindings: number, scriptCodeCount: number): string {
  const parts: string[] = [];
  if (failedBindings > 0) parts.push(`${failedBindings} 个运行期绑定未恢复`);
  if (scriptCodeCount > 0) parts.push('已加载脚本节点，运行前请确认来源');
  return parts.join('；');
}
