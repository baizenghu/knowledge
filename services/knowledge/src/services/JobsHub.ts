/**
 * JobsHub — 按 jobId 路由的纯唤醒 ping。
 * 设计:hub 只发"该 job 变了"的 ping(statusHint 仅可选提示),
 * 订阅方(SSE 端点)收到后应自行 re-read DB 推真实状态(DB 是事实源)。
 * 订阅者数量不定 → setMaxListeners(0)。
 */
import { EventEmitter } from "node:events";

export class JobsHub {
  private readonly em = new EventEmitter();
  constructor() { this.em.setMaxListeners(0); }
  emitStatus(jobId: string, statusHint?: string): void {
    this.em.emit(jobId, statusHint);
  }
  /** 返回解绑函数 */
  on(jobId: string, listener: (statusHint?: string) => void): () => void {
    this.em.on(jobId, listener);
    return () => this.em.off(jobId, listener);
  }
}
