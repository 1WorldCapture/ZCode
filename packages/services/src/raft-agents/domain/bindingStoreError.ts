/**
 * 绑定存储损坏（fail-closed）：证据已保全（内容寻址备份）、原文件保留，等待用户
 * 手动恢复。类放 domain 层供 app（服务层定向提示）与 adapters（存储实现）共用。
 */
export class RaftBindingStoreCorruptError extends Error {
  constructor(
    readonly storePath: string,
    readonly backupPath?: string,
  ) {
    super(`raft bindings store is corrupt: ${storePath}`);
    this.name = "RaftBindingStoreCorruptError";
  }
}
