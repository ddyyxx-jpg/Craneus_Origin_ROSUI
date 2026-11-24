// dev-probe.ts 在 Node 下运行；本仓库没有 @types/node，也不允许改 package.json，
// 因此只声明脚本实际用到的 node:child_process 最小签名。UI 构建产物不会引用它。
declare const process: {
  exitCode?: number;
};

declare module 'node:child_process' {
  export interface ExecFileOptions {
    cwd?: string;
  }

  export type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

  export function execFile(
    file: string,
    args: readonly string[],
    callback: ExecFileCallback,
  ): void;
  export function execFile(
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: ExecFileCallback,
  ): void;
}
