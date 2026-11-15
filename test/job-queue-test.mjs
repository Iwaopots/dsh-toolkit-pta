// job-queue 单元测试（vardiya 机制移植到 node:sqlite 的验证）。
// 用法：node test/job-queue-test.mjs <db-path>
// 只测队列本身，不连 mock、不碰真号；失败时 exit 1 并打印原因。
import { openJobQueue, AdaptivePoller, Semaphore, UnrecoverableError, parseCron, nextRun } from '../plugins/pta/cli/lib/job-queue.mjs';
import { rmSync } from 'node:fs';

const dbPath = process.argv[2] || '/tmp/pta-queue-test.sqlite';
rmSync(dbPath, { force: true });
rmSync(dbPath + '-wal', { force: true });
rmSync(dbPath + '-shm', { force: true });

const fails = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
}

const q = openJobQueue(dbPath);

// 1. 入队 + 幂等键去重（同一 dedup key 第二次返回已有任务）
const e1 = q.enqueue({ queue: 'run', name: 'a', payload: { x: 1 }, jobId: 'k1', maxAttempts: 3 });
check('enqueue returns job', !!e1.job?.id && e1.dedup === false, e1.job?.id);
const e1b = q.enqueue({ queue: 'run', name: 'a', payload: { x: 1 }, jobId: 'k1', maxAttempts: 3 });
check('dedup returns existing job', e1b.dedup === true && e1b.job.id === e1.job.id, `dedup=${e1b.dedup}`);

// 2. 定向认领 + 完成
const c1 = q.claim(e1.job.id);
check('claim by id', c1?.status === 'active' && c1.attempts === 1, JSON.stringify({ status: c1?.status, attempts: c1?.attempts }));
const c1again = q.claim(e1.job.id);
check('claim twice returns null', c1again === null, JSON.stringify(c1again));
q.complete(e1.job.id, { ok: true });
check('complete', q.getJob(e1.job.id)?.status === 'completed', q.getJob(e1.job.id)?.status);

// 3. 失败 → backoff delayed（run_at 在未来），到时 promote 回 pending
const e2 = q.enqueue({ queue: 'run', name: 'b', payload: {}, jobId: 'k2', maxAttempts: 3, backoff: { type: 'exponential', delayMs: 1000, maxDelayMs: 60000, jitter: false } });
q.claim(e2.job.id);
const f2 = q.fail({ id: e2.job.id, error: new Error('boom') });
check('fail goes delayed with backoff', f2.status === 'delayed' && f2.runAt > Date.now(), JSON.stringify({ status: f2.status, runAt: f2.runAt }));
check('promote before run_at does nothing', q.promoteDelayed(Date.now()) === 0, '');
check('promote after run_at revives', q.promoteDelayed(f2.runAt + 1) === 1, '');
check('promoted job is pending', q.getJob(e2.job.id)?.status === 'pending', q.getJob(e2.job.id)?.status);

// 4. UnrecoverableError → 直接 dead（不烧重试次数）
const e3 = q.enqueue({ queue: 'run', name: 'c', payload: {}, jobId: 'k3', maxAttempts: 3 });
q.claim(e3.job.id);
const f3 = q.fail({ id: e3.job.id, error: new UnrecoverableError('fatal') });
check('unrecoverable goes dead', f3.status === 'dead', f3.status);

// 5. attempts 满 → dead
const e4 = q.enqueue({ queue: 'run', name: 'd', payload: {}, jobId: 'k4', maxAttempts: 1 });
q.claim(e4.job.id);
const f4 = q.fail({ id: e4.job.id, error: new Error('x') });
check('max attempts reached goes dead', f4.status === 'dead', f4.status);

// 6. release：active → pending，attempts 扣回，不写 lastError
const e5 = q.enqueue({ queue: 'run', name: 'e', payload: {}, jobId: 'k5', maxAttempts: 3 });
q.claim(e5.job.id);
const r5 = q.release(e5.job.id);
check('release back to pending, attempts reverted', r5.status === 'pending' && r5.attempts === 0 && !r5.lastError, JSON.stringify({ status: r5.status, attempts: r5.attempts, lastError: r5.lastError }));

// 7. reclaimStale：用正确时间（心跳 30 秒前）回收失联 active 任务
const e6 = q.enqueue({ queue: 'run', name: 'f', payload: {}, jobId: 'k6', maxAttempts: 3 });
q.claim(e6.job.id);
const now = Date.now();
const reclaimed = q.reclaimStale(now + 61000, 30000);
check('reclaimStale revives stale active job', reclaimed === 1 && q.getJob(e6.job.id)?.status === 'pending', `reclaimed=${reclaimed} status=${q.getJob(e6.job.id)?.status}`);

// 8. failStalePending：从未开始的 pending 任务记 dead
const e7 = q.enqueue({ queue: 'run', name: 'g', payload: {}, jobId: 'k7', maxAttempts: 1 });
const swept = q.failStalePending('run', 0, 'never started');
check('failStalePending marks never-started dead', swept >= 1 && q.getJob(e7.job.id)?.status === 'dead', `swept=${swept}`);

// 9. backoff 指数：delayMs * 2^(attempt-1)，有上限
const e8 = q.enqueue({ queue: 'run', name: 'h', payload: {}, jobId: 'k8', maxAttempts: 5, backoff: { type: 'exponential', delayMs: 1000, maxDelayMs: 5000, jitter: false } });
q.claim(e8.job.id);
const f8a = q.fail({ id: e8.job.id, error: new Error('x') });
check('backoff attempt 1 = 1000ms', f8a.runAt - Date.now() >= 900 && f8a.runAt - Date.now() <= 1100, `delay=${f8a.runAt - Date.now()}`);
q.promoteDelayed(f8a.runAt + 1);
// 注意：promote 用的是模拟的未来时间，claim 也要用同一未来时间，
// 否则 run_at 在真实时间里还没到，claim 会正确拒绝。
q.claim(e8.job.id, f8a.runAt + 2);
const f8b = q.fail({ id: e8.job.id, error: new Error('x') });
check('backoff attempt 2 = 2000ms', f8b.runAt - Date.now() >= 1900 && f8b.runAt - Date.now() <= 2100, `delay=${f8b.runAt - Date.now()}`);
q.promoteDelayed(f8b.runAt + 1);
q.claim(e8.job.id, f8b.runAt + 2);
const f8c = q.fail({ id: e8.job.id, error: new Error('x') });
check('backoff attempt 3 = 4000ms', f8c.runAt - Date.now() >= 3900 && f8c.runAt - Date.now() <= 4100, `delay=${f8c.runAt - Date.now()}`);
q.promoteDelayed(f8c.runAt + 1);
q.claim(e8.job.id, f8c.runAt + 2);
const f8d = q.fail({ id: e8.job.id, error: new Error('x') });
check('backoff attempt 4 capped at maxDelayMs', f8d.runAt - Date.now() >= 4900 && f8d.runAt - Date.now() <= 5100, `delay=${f8d.runAt - Date.now()}`);

// 10. AdaptivePoller：命中回最小延迟，空命中 ×2 退避到上限
const p = new AdaptivePoller({ minMs: 10, maxMs: 1000 });
p.onHit();
check('poller hit resets to min', p.delayMs === 10, `delayMs=${p.delayMs}`);
p.onMiss(); p.onMiss(); p.onMiss();
check('poller miss doubles', p.delayMs === 80, `delayMs=${p.delayMs}`);
for (let i = 0; i < 10; i++) p.onMiss();
check('poller miss caps at max', p.delayMs === 1000, `delayMs=${p.delayMs}`);

// 11. FIFO 信号量：满了就排队，按顺序放行
const sem = new Semaphore(1);
const order = [];
const t1 = sem.acquire().then(() => { order.push('a'); sem.release(); });
const t2 = sem.acquire().then(() => { order.push('b'); sem.release(); });
const t3 = sem.acquire().then(() => { order.push('c'); sem.release(); });
await Promise.all([t1, t2, t3]);
check('semaphore FIFO order', order.join('') === 'abc', order.join(''));
check('semaphore tryAcquire on free', sem.tryAcquire() === true, '');
sem.release();

// 12. cron 解析：5 字段 + 别名，下次运行正确
const spec = parseCron('0 0 * * *');
const next = nextRun(spec, new Date('2026-11-16T03:00:00Z'));
check('cron next run is next midnight', next?.toISOString() === '2026-11-17T00:00:00.000Z', next?.toISOString());
const daily = parseCron('@daily');
const nextD = nextRun(daily, new Date('2026-11-16T12:00:00Z'));
check('@daily = midnight', nextD?.toISOString() === '2026-11-17T00:00:00.000Z', nextD?.toISOString());

// 13. counts 汇总
const counts = q.counts('run');
check('counts sum matches', counts.completed + counts.pending + counts.delayed + counts.dead + counts.active >= 8, JSON.stringify(counts));

q.close();
if (fails.length) {
  console.log(`\nQUEUE TEST: ${fails.length} failed: ${fails.join(', ')}`);
  process.exit(1);
}
console.log('\nQUEUE_TEST_OK');
