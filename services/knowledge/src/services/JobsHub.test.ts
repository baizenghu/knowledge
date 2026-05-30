import { describe, it, expect } from 'vitest';
import { JobsHub } from './JobsHub';

describe('JobsHub', () => {
  it('emitStatus 按 jobId 路由,只通知对应订阅', () => {
    const hub = new JobsHub();
    const a: unknown[] = []; const b: unknown[] = [];
    const offA = hub.on('job-a', (h) => a.push(h));
    const offB = hub.on('job-b', (h) => b.push(h));
    hub.emitStatus('job-a', 'running');
    hub.emitStatus('job-b', 'succeeded');
    hub.emitStatus('job-a');           // 无 hint 也算一次 ping
    expect(a).toEqual(['running', undefined]);
    expect(b).toEqual(['succeeded']);
    offA(); offB();
  });

  it('off 返回的取消函数能解绑', () => {
    const hub = new JobsHub();
    const got: unknown[] = [];
    const off = hub.on('x', (h) => got.push(h));
    hub.emitStatus('x', 'running');
    off();
    hub.emitStatus('x', 'succeeded');
    expect(got).toEqual(['running']);
  });
});
