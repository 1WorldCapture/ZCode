/**
 * 异步读取的请求序号守卫（纯逻辑，供组件与单测共用；SPEC「二期 R3」）。
 *
 * 记忆面板连续切换文件时，旧请求的慢响应不得覆盖新选择的文件内容：
 * 每次发起读取 begin() 取一个新序号，响应到达时 isCurrent(token) 为假即丢弃。
 */
export function createReadSequenceGuard(): {
  begin: () => number;
  isCurrent: (token: number) => boolean;
} {
  let latest = 0;
  return {
    begin(): number {
      latest += 1;
      return latest;
    },
    isCurrent(token: number): boolean {
      return token === latest;
    },
  };
}
