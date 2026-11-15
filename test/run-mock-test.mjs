// Mock 全链路测试：起 mock PTA 服务 → 建 mock 账号 → CLI + 面板驱动
// （注册表动作：启动/暂停/继续/停止/测活/设置/导出）→ 核对状态/审计/看板。
// 只用 mock 账号，绝不碰真号。
// 用法：node test/run-mock-test.mjs
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const CLI = new URL('../plugins/pta/cli/pta.mjs', import.meta.url).pathname;
const MOCK = new URL('./mock-pta.mjs', import.meta.url).pathname;
const PORT = 18765;
const SERVE_PORT = 18767;
const STATE = '/tmp/pta-mock-test';
// mock 密码每轮随机生成（mock 接受任意非空密码）：仓库里不留任何字面密码，
// 哪怕是 mock 用的假密码；最后的 grep 用同一变量核对它没落盘。
const MOCK_PASS = randomUUID().slice(0, 12);

const env = {
  ...process.env,
  PTA_STATE_DIR: STATE,
  PTA_BASE_URL: `http://127.0.0.1:${PORT}`,
  PTA_PASSPORT_URL: `http://127.0.0.1:${PORT}`,
  DEEPSEEK_API_BASE: `http://127.0.0.1:${PORT}`,
  DEEPSEEK_API_KEY: 'mock-key',
  PTA_CREDENTIAL_CMD: '',
};

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function cli(args, input = '') {
  // 不用 execFile 的 input 选项：本机 Node 上它写不进子进程 stdin
  // （实测子进程收不到数据、readline 也收不到，直接挂到超时）。
  // 改用 spawn 手动写 stdin + end。
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli timeout: node ${CLI} ${args.join(' ')}`));
    }, 600000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Command failed: node ${CLI} ${args.join(' ')}\n${stdout}\n${stderr}`));
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

// cli 的“允许失败”版：返回 {stdout, stderr, code}，不抛错。
// 用于预期非零退出的场景（如 run 失败 1 题时 exit 2），再从 stdout 里抽 summary。
async function cliAllowFail(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli timeout: node ${CLI} ${args.join(' ')}`));
    }, 600000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

// 从 CLI 的 run 输出里抽出最后一段美化 JSON（run 先打日志、最后打印 summary）。
// 不能用 split('\n').pop()：美化 JSON 的最后一行是单独的 "}"，不是合法 JSON。
function extractSummary(stdout) {
  const m = stdout.match(/\n(\{[\s\S]*\})\s*$/);
  if (!m) throw new Error(`no JSON summary in CLI output: ${stdout.slice(-300)}`);
  return JSON.parse(m[1]);
}

async function waitHealth() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function post(path, body) {
  const r = await fetch(`http://127.0.0.1:${SERVE_PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

async function getState() {
  return (await fetch(`http://127.0.0.1:${SERVE_PORT}/api/state`)).json();
}

// 等任务到某个状态（timeout 秒内），返回最后一次 job。
async function waitJobStatus(want, timeoutSec = 300) {
  const t0 = Date.now();
  let last = null;
  while ((Date.now() - t0) / 1000 < timeoutSec) {
    const s = await getState();
    last = s.job;
    if (last && want.includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}

async function main() {
  rmSync(STATE, { recursive: true, force: true });
  const mock = spawn('node', [MOCK, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  mock.stdout.on('data', (d) => process.stdout.write(`[mock] ${d}`));
  mock.stderr.on('data', (d) => process.stderr.write(`[mock:err] ${d}`));
  let serve = null;
  try {
    if (!await waitHealth()) throw new Error('mock server did not come up');

    // 1. 自检 + 登录（mock 账号）
    let out = await cli(['doctor']);
    check('doctor', out.stdout.includes('"accounts": 0'), out.stdout.trim().slice(0, 120));
    out = await cli(['login', '--user', 'mock@pta.test', '--label', 'mock', '--password-stdin'], MOCK_PASS + '\n');
    const loginJson = JSON.parse(out.stdout.trim().split('\n').pop());
    check('login mock account', loginJson.ok === true && loginJson.status === 'ready', JSON.stringify(loginJson));
    const accountId = loginJson.id;

    // 2. 题集列表（PS-MOCK-2 故意没有 exam，用来测自动建 exam；PS-MOCK-3 用来测待复核）
    out = await cli(['problem-sets']);
    check('problem-sets lists 4 sets', out.stdout.includes('PS-MOCK-1') && out.stdout.includes('PS-MOCK-EXAM') && out.stdout.includes('PS-MOCK-2') && out.stdout.includes('PS-MOCK-3'), out.stdout.trim());

    // 3. 正式考试题集必须被拒绝（CLI）
    out = await cli(['run', '--problem-set', 'PS-MOCK-EXAM', '--pace', 'fast', '--yes']);
    check('exam set refused', out.stdout.includes('REFUSED'), out.stdout.trim().slice(0, 300));

    // 4. 起面板服务（serve 的 stdout/stderr 落盘，便于崩溃诊断）
    const { createWriteStream } = await import('node:fs');
    serve = spawn('node', [CLI, 'serve', '--port', String(SERVE_PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    serve.stdout.pipe(createWriteStream('/tmp/pta-serve-out.log'));
    serve.stderr.pipe(createWriteStream('/tmp/pta-serve-err.log'));
    await new Promise((r) => setTimeout(r, 1500));

    // 5. 注册表：5 组、34 个动作（账号 7、题集 7、做题 7、监控 7、管理 6；
    // 删账号已按用户 03:17 要求恢复进面板，双重确认）
    const reg = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/api/registry`)).json();
    check('registry has 5 groups', reg.groups?.length === 5, JSON.stringify(reg.groups?.map((g) => g.id)));
    check('registry has 34 actions', reg.actions?.length === 34, `got ${reg.actions?.length}`);
    check('registry has account.delete', reg.actions.some((a) => a.id === 'account.delete'), reg.actions.map((a) => a.id).join(','));
    check('registry marks dangerous actions confirm', reg.actions.filter((a) => a.confirm).length >= 9, `confirm actions: ${reg.actions.filter((a) => a.confirm).map((a) => a.id).join(',')}`);

    // 6. 面板 HTML 含控制台与分组按钮
    const page = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/`)).text();
    check('panel renders console', page.includes('控制台') && page.includes('__REGISTRY__') && page.includes('完成作业'), page.slice(0, 150));

    // 7. 一键测活
    let r = await post('/api/account/ping', { account: accountId });
    check('account ping alive', r.ok === true && r.alive === true, JSON.stringify(r));

    // 8. 面板一键完成作业（全链路，fast 档）+ 幂等键
    const RUN_KEY = 'test-key-run-1';
    r = await post('/api/run', { account: accountId, problemSet: 'PS-MOCK-1', pace: 'fast', mode: 'all', yes: true, idempotencyKey: RUN_KEY });
    check('panel run starts', r.ok === true && !!r.jobId, JSON.stringify(r));
    // 同一个幂等键重复提交：返回同一个任务，不建新任务
    const rDup = await post('/api/run', { account: accountId, problemSet: 'PS-MOCK-1', pace: 'fast', mode: 'all', yes: true, idempotencyKey: RUN_KEY });
    check('same idempotency key returns same job', rDup.ok === true && rDup.jobId === r.jobId && rDup.dedup === true, JSON.stringify(rDup));
    // 运行中换一个 key 再点一次应被拒（409）
    const r2 = await post('/api/run', { account: accountId, problemSet: 'PS-MOCK-1', pace: 'fast', mode: 'all', yes: true, idempotencyKey: 'test-key-run-2' });
    check('second run while busy rejected', r2.ok === false, JSON.stringify(r2));
    // 看板 JSON 里能看到任务在跑
    let snap = await getState();
    check('state shows running job', snap.job?.status === 'running', JSON.stringify(snap.job?.status));
    const job = await waitJobStatus(['done', 'failed', 'stopped'], 300);
    check('panel run finished done', job?.status === 'done', JSON.stringify(job?.status) + ' ' + (job?.error || ''));
    snap = await getState();
    const setState = snap.accounts[0]?.sets?.find((s) => s.psid === 'PS-MOCK-1');
    check('panel run: 7/7 accepted', setState?.accepted === 7 && setState?.total === 7, JSON.stringify({ accepted: setState?.accepted, total: setState?.total }));

    // 9. 暂停 / 继续 / 停止：复位后重跑，中间暂停再继续，最后停止
    await fetch(`http://127.0.0.1:${PORT}/test/reset`, { method: 'POST' });
    r = await post('/api/run', { account: accountId, problemSet: 'PS-MOCK-1', pace: 'fast', mode: 'all', yes: true });
    check('second panel run starts', r.ok === true, JSON.stringify(r));
    await new Promise((x) => setTimeout(x, 5000));
    r = await post('/api/pause', {});
    check('pause works', r.ok === true && r.status === 'paused', JSON.stringify(r));
    snap = await getState();
    check('state shows paused', snap.job?.status === 'paused', JSON.stringify(snap.job?.status));
    r = await post('/api/resume', {});
    check('resume works', r.ok === true && r.status === 'running', JSON.stringify(r));
    r = await post('/api/stop', {});
    check('stop works', r.ok === true, JSON.stringify(r));
    const stopped = await waitJobStatus(['stopped', 'done', 'failed'], 120);
    check('job ends stopped', stopped?.status === 'stopped', JSON.stringify(stopped?.status));

    // 10. 停掉后能再跑完（失败重试 = 只做错题/未完成）
    r = await post('/api/run', { account: accountId, problemSet: 'PS-MOCK-1', pace: 'fast', mode: 'all', yes: true });
    check('third panel run starts', r.ok === true, JSON.stringify(r));
    const job3 = await waitJobStatus(['done', 'failed', 'stopped'], 300);
    check('third run done', job3?.status === 'done', JSON.stringify(job3?.status));
    snap = await getState();
    const set3 = snap.accounts[0]?.sets?.find((s) => s.psid === 'PS-MOCK-1');
    check('after re-run: 7/7 accepted', set3?.accepted === 7, JSON.stringify({ accepted: set3?.accepted }));

    // 10a. jobs 端点：单任务查询 + 失败重试（只跑未通过题）
    const jobRec = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/api/jobs/${job3.id}`)).json();
    check('job record readable', jobRec.ok === true && jobRec.job?.status === 'done', JSON.stringify(jobRec.job?.status));
    r = await post(`/api/jobs/${job3.id}/retry`, {});
    check('job retry starts new job', r.ok === true && !!r.jobId && r.jobId !== job3.id, JSON.stringify(r));
    const jobRetry = await waitJobStatus(['done', 'failed', 'stopped'], 300);
    check('job retry done', jobRetry?.status === 'done', JSON.stringify(jobRetry?.status));

    // 10b. 账号启用 / 停用：停用后 run 应失败（不跑任务），再启用恢复
    r = await post('/api/account/toggle-enabled', { account: accountId });
    check('account toggle off', r.ok === true && r.enabled === false, JSON.stringify(r));
    r = await post('/api/run', { account: accountId, problemSet: 'PS-MOCK-1', pace: 'fast', mode: 'all', yes: true, idempotencyKey: 'test-key-disabled' });
    check('run on disabled account starts job', r.ok === true && !!r.jobId, JSON.stringify(r));
    const jobDisabled = await waitJobStatus(['failed', 'done', 'stopped'], 120);
    check('disabled account run fails', jobDisabled?.status === 'failed' && /disabled/.test(jobDisabled?.error || ''), JSON.stringify({ status: jobDisabled?.status, error: jobDisabled?.error }));
    r = await post('/api/account/toggle-enabled', { account: accountId });
    check('account toggle on', r.ok === true && r.enabled === true, JSON.stringify(r));

    // 10c. 单题详情
    const detail = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/api/problem?account=${accountId}&psid=PS-MOCK-1&problem=P5`)).json();
    check('problem detail works', detail.ok === true && detail.problem?.type === 'PROGRAMMING' && detail.problem?.status === 'PROBLEM_ACCEPTED', JSON.stringify(detail.problem?.type) + ' ' + JSON.stringify(detail.problem?.status));

    // 10d. SSE 推送：首帧应为 snapshot
    const evRes = await fetch(`http://127.0.0.1:${SERVE_PORT}/api/events`);
    const reader = evRes.body.getReader();
    const first = await reader.read();
    reader.cancel();
    const firstText = new TextDecoder().decode(first.value || new Uint8Array());
    check('SSE first frame is snapshot', /event: snapshot/.test(firstText) && /"accounts"/.test(firstText), firstText.slice(0, 200));

    // 10e. 删账号端点在面板上（用户 03:17 要求恢复，双重确认）：
    // 无 confirm 时 400；正式删除放到最后（第 15 节，用 mock2 账号删，免得动主账号）。
    const delNoConfirm = await fetch(`http://127.0.0.1:${SERVE_PORT}/api/account/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: accountId }) });
    check('panel account delete without confirm rejected (400)', delNoConfirm.status === 400, `status ${delNoConfirm.status}`);

    // 11. 节律档位切换 + 设置
    r = await post('/api/pace', { pace: 'slow' });
    check('pace switch works', r.ok === true && r.pace === 'slow', JSON.stringify(r));
    r = await post('/api/settings', { maxFixes: 2, model: 'deepseek-chat' });
    check('settings save works', r.ok === true && r.settings?.maxFixes === 2, JSON.stringify(r.settings));

    // 12. 审计日志与报告
    const audit = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/api/audit?account=${accountId}`)).json();
    const actions = (audit.audit || []).map((e) => e.action);
    check('audit has run_start/run_end', actions.includes('run_start') && actions.includes('run_end'), actions.join(','));
    check('audit has submitted + judged', actions.includes('submitted') && actions.includes('judged'), actions.join(','));
    check('audit has exam_refused', actions.includes('exam_refused'), actions.join(','));
    check('audit has code_varied', actions.includes('code_varied'), actions.join(','));
    const report = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/api/report?account=${accountId}`)).text();
    check('report exports', report.includes('PTA 作业报告') && report.includes('PS-MOCK-1'), report.slice(0, 120));

    // 13. CLI 再跑一次：已全部通过，应全部跳过
    out = await cli(['run', '--problem-set', 'PS-MOCK-1', '--pace', 'fast', '--yes']);
    const summary = extractSummary(out.stdout);
    check('CLI re-run: 7 total, 7 accepted, 7 skipped', summary.problems.total === 7 && summary.problems.accepted === 7 && summary.problems.skipped === 7, JSON.stringify(summary.problems));

    // 13a. 单题跳过：复位后跳过 P5 再跑，应 6/7 且 P5 仍未答；取消跳过再跑，7/7
    await fetch(`http://127.0.0.1:${PORT}/test/reset`, { method: 'POST' });
    r = await post('/api/problem/skip', { account: accountId, problemSet: 'PS-MOCK-1', problem: 'P5', skip: true });
    check('skip problem P5', r.ok === true && r.skipped?.includes('P5'), JSON.stringify(r));
    r = await post('/api/run', { account: accountId, problemSet: 'PS-MOCK-1', pace: 'fast', mode: 'all', yes: true, idempotencyKey: 'test-key-skip-1' });
    check('skip run starts', r.ok === true, JSON.stringify(r));
    const jobSkip = await waitJobStatus(['done', 'failed', 'stopped'], 300);
    check('skip run done', jobSkip?.status === 'done', JSON.stringify(jobSkip?.status));
    snap = await getState();
    const setSkip = snap.accounts[0]?.sets?.find((s) => s.psid === 'PS-MOCK-1');
    const p5 = setSkip?.problems?.find((p) => p.id === 'P5');
    check('skip run: 6/7, P5 still unanswered', setSkip?.accepted === 6 && p5?.status === 'PROBLEM_NO_ANSWER', JSON.stringify({ accepted: setSkip?.accepted, p5: p5?.status }));
    r = await post('/api/problem/skip', { account: accountId, problemSet: 'PS-MOCK-1', problem: 'P5', skip: false });
    check('unskip problem P5', r.ok === true && !r.skipped?.includes('P5'), JSON.stringify(r));
    r = await post('/api/run', { account: accountId, problemSet: 'PS-MOCK-1', pace: 'fast', mode: 'all', yes: true, idempotencyKey: 'test-key-skip-2' });
    check('unskip run starts', r.ok === true, JSON.stringify(r));
    const jobUnskip = await waitJobStatus(['done', 'failed', 'stopped'], 300);
    check('unskip run done', jobUnskip?.status === 'done', JSON.stringify(jobUnskip?.status));
    snap = await getState();
    const setUnskip = snap.accounts[0]?.sets?.find((s) => s.psid === 'PS-MOCK-1');
    check('after unskip: 7/7 accepted', setUnskip?.accepted === 7, JSON.stringify({ accepted: setUnskip?.accepted }));

    // 13b. 无 exam 的题集：自动建 exam 后做题（vscode-pintia 的 createProblemSetExam）
    out = await cli(['run', '--problem-set', 'PS-MOCK-2', '--pace', 'fast', '--yes']);
    const s2 = extractSummary(out.stdout);
    check('PS-MOCK-2 auto-creates exam and solves 1/1', s2.problems.total === 1 && s2.problems.accepted === 1, JSON.stringify(s2.problems));
    const audit2 = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/api/audit?account=${accountId}`)).json();
    check('audit has exam_created', (audit2.audit || []).some((e) => e.action === 'exam_created'), (audit2.audit || []).map((e) => e.action).join(','));

    // 13c. customTestData 管道：样例发服务端判，输出对上、题目状态不变
    await fetch(`http://127.0.0.1:${PORT}/test/reset`, { method: 'POST' });
    const checkScript = new URL('./custom-test-data-check.mjs', import.meta.url).pathname;
    const checkRun = await new Promise((resolve) => {
      const p = spawn('node', [checkScript, STATE, String(PORT), accountId], { env });
      let o = '';
      p.stdout.on('data', (d) => { o += d; });
      p.stderr.on('data', (d) => { o += d; });
      p.on('close', (code) => resolve({ code, out: o }));
    });
    check('customTestData returns server output 3 for 1 2', checkRun.code === 0 && checkRun.out.includes('CUSTOM_TEST_OK'), checkRun.out.trim().slice(0, 300));

    // 13d. 交卷分支：复位后 --finish 全链路，交卷后再次提交应被拒
    await fetch(`http://127.0.0.1:${PORT}/test/reset`, { method: 'POST' });
    out = await cli(['run', '--problem-set', 'PS-MOCK-1', '--pace', 'fast', '--yes', '--finish']);
    const sFinish = extractSummary(out.stdout);
    check('finish run: 7/7 accepted', sFinish.problems.total === 7 && sFinish.problems.accepted === 7, JSON.stringify(sFinish.problems));
    const auditF = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/api/audit?account=${accountId}`)).json();
    check('audit has exam_finished', (auditF.audit || []).some((e) => e.action === 'exam_finished'), (auditF.audit || []).map((e) => e.action).join(','));
    const finished = await (await fetch(`http://127.0.0.1:${PORT}/test/finished`)).json();
    check('mock marks exam finished', (finished.finished || []).includes('EX-MOCK-1'), JSON.stringify(finished));
    const session = JSON.parse(readFileSync(join(STATE, 'accounts', accountId, 'session.json'), 'utf8'));
    const afterEnd = await fetch(`http://127.0.0.1:${PORT}/api/exams/EX-MOCK-1/exam-submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: session.cookie },
      body: JSON.stringify({ problemType: 'MULTIPLE_CHOICE', details: [{ problemId: '0', problemSetProblemId: 'P2', multipleChoiceSubmissionDetail: { answer: 'B' } }] }),
    });
    const afterEndBody = await afterEnd.json();
    check('submit after end rejected (EXAM_ENDED)', afterEnd.status === 400 && afterEndBody?.error?.code === 'EXAM_ENDED', `${afterEnd.status} ${JSON.stringify(afterEndBody).slice(0, 200)}`);

    // 13e. 待复核闭环：P9 固定答错（42 而不是 43）→ 自测永不过 → 停表 blocked → 进队列
    // → 返工一次仍错（reworkCount=1、回 pending）→ 人工验收后 pending 清空
    await fetch(`http://127.0.0.1:${PORT}/test/reset`, { method: 'POST' });
    const out3 = await cliAllowFail(['run', '--problem-set', 'PS-MOCK-3', '--pace', 'fast', '--yes']);
    check('PS-MOCK-3 run exits 2 (1 failed)', out3.code === 2, `code=${out3.code} ${out3.stderr.slice(0, 200)}`);
    const s3 = extractSummary(out3.stdout);
    check('PS-MOCK-3 run: 1 failed', s3.problems.total === 1 && s3.problems.failed === 1, JSON.stringify(s3.problems));
    const review1 = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/api/review?account=${accountId}&status=pending`)).json();
    const p9 = (review1.items || []).find((i) => i.pspId === 'P9');
    check('review queue has P9 blocked', !!p9 && p9.reason === 'blocked', JSON.stringify(review1.items));
    r = await post('/api/review/rework', { account: accountId, key: p9.key, pace: 'fast' });
    check('review rework starts job', r.ok === true && !!r.jobId, JSON.stringify(r));
    const jobRework = await waitJobStatus(['done', 'failed', 'stopped'], 300);
    check('rework job done', jobRework?.status === 'done', JSON.stringify(jobRework?.status));
    const review2 = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/api/review?account=${accountId}`)).json();
    const p9b = (review2.items || []).find((i) => i.pspId === 'P9');
    check('after rework: P9 pending again, reworkCount=1', !!p9b && p9b.status === 'pending' && p9b.reworkCount === 1, JSON.stringify(p9b));
    r = await post('/api/review/accept', { account: accountId, key: p9.key });
    check('review accept works', r.ok === true && r.status === 'accepted', JSON.stringify(r));
    const review3 = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/api/review?account=${accountId}&status=pending`)).json();
    check('pending queue empty after accept', !(review3.items || []).some((i) => i.pspId === 'P9'), JSON.stringify(review3.items));

    // 14. 静态看板
    out = await cli(['dashboard']);
    check('dashboard written', existsSync(join(STATE, 'accounts', accountId, 'dashboard.html')));
    const html = readFileSync(join(STATE, 'accounts', accountId, 'dashboard.html'), 'utf8');
    check('dashboard shows 7/7', html.includes('7/7') || html.includes('7 / 7'), html.slice(0, 200));

    // 15. 面板登录（最后做：会新建账号）：密码绝不能落盘
    r = await post('/api/login', { user: 'mock2@pta.test', password: MOCK_PASS, label: 'mock2' });
    check('panel login works', r.ok === true && !!r.id, JSON.stringify(r));
    const mock2Id = r.id;

    // 15a. 面板删账号（双重确认）：带 confirm:true 删 mock2，账号置 removed
    r = await post('/api/account/delete', { account: mock2Id, confirm: true });
    check('panel account delete works', r.ok === true && r.id === mock2Id, JSON.stringify(r));
    snap = await getState();
    const mock2Row = (snap.accounts || []).find((a) => a.id === mock2Id);
    check('deleted account shows removed', mock2Row?.status === 'removed', JSON.stringify(mock2Row?.status));
    const mainRow = (snap.accounts || []).find((a) => a.id === accountId);
    check('main account untouched by delete', mainRow?.status === 'ready', JSON.stringify(mainRow?.status));

    // 16. 队列单元测试（vardiya 移植验证：独立进程跑）
    const queueScript = new URL('./job-queue-test.mjs', import.meta.url).pathname;
    const queueRun = await new Promise((resolve) => {
      const p = spawn('node', [queueScript, join(STATE, 'queue-test.sqlite')], { env });
      let o = '';
      p.stdout.on('data', (d) => { o += d; });
      p.stderr.on('data', (d) => { o += d; });
      p.on('close', (code) => resolve({ code, out: o }));
    });
    check('job queue unit tests pass', queueRun.code === 0 && queueRun.out.includes('QUEUE_TEST_OK'), queueRun.out.trim().slice(-300));

    const { execSync } = await import('node:child_process');
    let leaked = '';
    try {
      leaked = execSync(`grep -r "${MOCK_PASS}" ${STATE} || true`, { encoding: 'utf8' });
    } catch { /* grep no match exits 1, caught above by || true */ }
    check('password never persisted', leaked.trim() === '', leaked.slice(0, 200));
  } finally {
    if (serve) serve.kill();
    mock.kill();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed ====`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`TEST ERROR: ${e.message}`);
  process.exitCode = 1;
});
