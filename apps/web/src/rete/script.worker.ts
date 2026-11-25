/// <reference lib="webworker" />
// Script 节点的执行沙箱（仅隔离主线程，不是安全沙箱）：跑完把结果回传，主线程超时即 terminate。
self.onmessage = (event: MessageEvent<{ code: string; x: unknown }>) => {
  const { code, x } = event.data;
  try {
    const compiled = new Function('x', `"use strict";\n${code}`);
    const value: unknown = compiled(x);
    if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string') {
      self.postMessage({ ok: true, value });
      return;
    }
    self.postMessage({ ok: false, error: '结果必须是有限数字或字符串' });
  } catch (caught) {
    self.postMessage({
      ok: false,
      error: caught instanceof Error ? caught.message : String(caught),
    });
  }
};
