/**
 * 绑定存储写互斥锁：所有会写绑定记录的入口共享同一把——service 的
 * create/remove/setDesiredState 与值守编排器的换代写（watchRuntime）。
 * 宿主装配时创建一次、注入两侧；各入口也可自建私有锁（互不相干时）。
 *
 * 约束（沿 raftAgentsService 既有语义）：锁内只做读-校验-写；登录等慢操作
 * （最长 45s）与 bridge 启动不得持锁，否则会把整个写入面卡死。
 */
export interface RaftStoreWriteLock {
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** promise 链实现：后进排队，前序失败不阻断后续（错误由各自调用方处理）。 */
export function createRaftStoreWriteLock(): RaftStoreWriteLock {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = chain.then(fn, fn);
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
