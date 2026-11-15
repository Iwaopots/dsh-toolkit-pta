// 本地 mock PTA 服务（仅用于测试，绝不连真实 pintia.cn）。
// 实现登录 / 题集 / 题目 / 状态 / 提交 / 判题 / DeepSeek mock 端点，
// 让 `run` 全链路能在本地跑通。判题对编程题是真编译真跑样例。
// 用法：node test/mock-pta.mjs [port]（默认 18765）
// 环境：MOCK_PORT。
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { runSamples } from '../plugins/pta/cli/lib/solve.mjs';

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 18765);

// ---- mock 数据 ----
const SETS = [
  { id: 'PS-MOCK-1', name: 'C语言入门练习', type: 'PRACTICE', endAt: '2026-12-31T23:59:59Z', problemSetConfig: { compilers: ['GCC', 'GXX', 'PYTHON3'] } },
  { id: 'PS-MOCK-EXAM', name: '期末考试', type: 'EXAM', endAt: '2026-12-31T23:59:59Z', problemSetConfig: { compilers: ['GCC'] } },
  // PS-MOCK-2 故意不在 EXAM_BY_SET 里：用来测“无 exam 时自动建 exam”（vscode-pintia 的 createProblemSetExam）。
  { id: 'PS-MOCK-2', name: 'Python入门练习', type: 'PRACTICE', endAt: '2026-12-31T23:59:59Z', problemSetConfig: { compilers: ['PYTHON3', 'GCC'] } },
  // PS-MOCK-3：复核练习。P9 的 mock DS 固定答错（42 而不是 43），自测永不过，
  // 用于测停表 blocked → 待复核队列 → 返工/验收闭环。
  { id: 'PS-MOCK-3', name: '复核练习', type: 'PRACTICE', endAt: '2026-12-31T23:59:59Z', problemSetConfig: { compilers: ['GCC'] } },
];
const EXAM_BY_SET = { 'PS-MOCK-1': 'EX-MOCK-1', 'PS-MOCK-EXAM': 'EX-MOCK-EXAM', 'PS-MOCK-3': 'EX-MOCK-3' };
const EXAM_BY_SET_ORIGINAL = { ...EXAM_BY_SET };
// 已交卷的 exam（PUT end 后记在这里；交卷后再次提交应被拒，见 RESEARCH §12.6.3 小心事项 3）。
const finishedExams = new Set();

const PROBLEMS = {
  'PS-MOCK-1': [
    { id: 'P1', type: 'TRUE_OR_FALSE', score: 5, content: 'Python 是一种解释型语言。（ ）' },
    // 注意：真实 PTA 枚举里单选叫 MULTIPLE_CHOICE、多选叫
    // MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER，没有 SINGLE_CHOICE。
    { id: 'P2', type: 'MULTIPLE_CHOICE', score: 5, content: '2 + 3 = ？\nA. 4\nB. 5\nC. 6\nD. 7' },
    { id: 'P3', type: 'MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER', score: 5, content: '以下哪些是 Python 的内置数据类型？\nA. int\nB. float\nC. char\nD. str' },
    { id: 'P4', type: 'FILL_IN_THE_BLANK', score: 5, content: 'Python 中用于输出的函数是 ____。' },
    {
      id: 'P5', type: 'PROGRAMMING', score: 20, compiler: 'GCC',
      content: '计算两数之和\n\n输入两个整数 a 和 b，输出它们的和。\n\n样例输入：\n1 2\n样例输出：\n3',
    },
    {
      id: 'P6', type: 'PROGRAMMING', score: 10, compiler: 'GCC',
      content: '输出 Hello World\n\n请输出一行：Hello World\n\n样例输入：\n\n样例输出：\nHello World',
    },
    { id: 'P7', type: 'TRUE_OR_FALSE', score: 5, content: '1 + 1 = 2。（ ）' },
  ],
  'PS-MOCK-EXAM': [
    { id: 'E1', type: 'MULTIPLE_CHOICE', score: 10, content: '考试题，不应被做到。\nA. 对\nB. 错' },
  ],
  'PS-MOCK-2': [
    {
      id: 'P8', type: 'PROGRAMMING', score: 10, compiler: 'PYTHON3',
      content: '输出 OK\n\n请输出一行：OK\n\n样例输入：\n\n样例输出：\nOK',
    },
  ],
  'PS-MOCK-3': [
    {
      id: 'P9', type: 'PROGRAMMING', score: 10, compiler: 'GCC',
      content: '输出 43\n\n请输出一行：43\n\n样例输入：\n\n样例输出：\n43',
    },
  ],
};

// 样例只存在 mock 服务端（客户端要从题面里抠，测 extractSamples 的真实路径）。
const SAMPLES = {
  P5: [{ input: '1 2', output: '3' }, { input: '10 20', output: '30' }],
  P6: [{ input: '', output: 'Hello World' }],
  P8: [{ input: '', output: 'OK' }],
  P9: [{ input: '', output: '43' }],
};

const ANSWER_KEY = {
  P1: { kind: 'tf', answer: 'TRUE' },
  P2: { kind: 'single', answer: 'B' },
  P3: { kind: 'multi', answers: ['A', 'B', 'D'] },
  P4: { kind: 'fill', answers: ['print'] },
  P7: { kind: 'tf', answer: 'TRUE' },
};

const sessions = new Map(); // cookie -> { id, nickname }
const statuses = new Map(); // psid -> Map(pspId -> status)
for (const psid of Object.keys(PROBLEMS)) {
  const m = new Map();
  for (const p of PROBLEMS[psid]) m.set(p.id, 'PROBLEM_NO_ANSWER');
  statuses.set(psid, m);
}
statuses.get('PS-MOCK-1').set('P7', 'PROBLEM_ACCEPTED'); // P7 已通过，run 应跳过
const submissions = new Map(); // sid -> { createdAt, results, type }

function gradeObjective(detail) {
  const pspId = detail.problemSetProblemId;
  const key = ANSWER_KEY[pspId];
  if (!key) return 'WRONG_ANSWER';
  if (detail.trueOrFalseSubmissionDetail) return detail.trueOrFalseSubmissionDetail.answer === key.answer ? 'ACCEPTED' : 'WRONG_ANSWER';
  if (detail.multipleChoiceSubmissionDetail) return detail.multipleChoiceSubmissionDetail.answer === key.answer ? 'ACCEPTED' : 'WRONG_ANSWER';
  if (detail.multipleChoiceMoreThanOneAnswerSubmissionDetail) {
    const got = [...(detail.multipleChoiceMoreThanOneAnswerSubmissionDetail.answers || [])].sort().join(',');
    return got === [...key.answers].sort().join(',') ? 'ACCEPTED' : 'WRONG_ANSWER';
  }
  if (detail.fillInTheBlankSubmissionDetail) {
    const got = (detail.fillInTheBlankSubmissionDetail.answers || []).map((a) => String(a).trim());
    return got.join('|') === key.answers.join('|') ? 'ACCEPTED' : 'WRONG_ANSWER';
  }
  return 'WRONG_ANSWER';
}

async function gradeProgramming(detail, workDir) {
  const pspId = detail.problemSetProblemId;
  const d = detail.programmingSubmissionDetail || detail.codeCompletionSubmissionDetail || detail.sqlProgrammingSubmissionDetail;
  if (!d) return [{ testcaseId: 0, result: 'WRONG_ANSWER' }];
  const samples = SAMPLES[pspId] || [];
  const res = await runSamples({ code: d.program || '', compiler: d.compiler || 'GCC', samples, workDir });
  if (res.compileError) return [{ testcaseId: 0, result: 'COMPILE_ERROR', message: res.compileError.slice(0, 200) }];
  return res.results.map((r, i) => ({ testcaseId: i + 1, result: r.passed ? 'ACCEPTED' : 'WRONG_ANSWER' }));
}

// mock DeepSeek：按题面关键词回固定答案（只为测链路，不代表真实模型能力）。
function mockDSReply(text) {
  if (/两数之和|A\+B/.test(text)) {
    return '```c\n#include <stdio.h>\nint main() {\n    int a, b;\n    if (scanf("%d %d", &a, &b) != 2) return 0;\n    printf("%d\\n", a + b);\n    return 0;\n}\n```';
  }
  if (/输出 OK/.test(text)) {
    return '```python\nprint("OK")\n```';
  }
  if (/输出 43/.test(text)) {
    // 故意答错（42 而不是 43）：自测永不过 → 停表 blocked → 进待复核队列。
    return '```c\n#include <stdio.h>\nint main() {\n    printf("42\\n");\n    return 0;\n}\n```';
  }
  if (/Hello World/.test(text)) {
    return '```c\n#include <stdio.h>\nint main() {\n    printf("Hello World\\n");\n    return 0;\n}\n```';
  }
  if (/解释型语言/.test(text)) return '{"answer": true, "confidence": 0.95}';
  if (/2 \+ 3/.test(text)) return '{"answer": "B", "confidence": 0.95}';
  if (/内置数据类型/.test(text)) return '{"answer": ["A", "B", "D"], "confidence": 0.9}';
  if (/输出的函数/.test(text)) return '{"answer": "print", "confidence": 0.95}';
  if (/1 \+ 1/.test(text)) return '{"answer": true, "confidence": 0.99}';
  return '{"answer": "A", "confidence": 0.3}';
}

function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;
  const cookie = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('MOCKSESSION='))?.slice('MOCKSESSION='.length);
  const authed = cookie && sessions.has(cookie);

  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
  // 测试专用：复位所有题集状态与提交记录（mock 只用于测试，不连真实服务）。
  if (req.method === 'POST' && path === '/test/reset') {
    for (const [psid, m] of statuses) {
      for (const k of m.keys()) m.set(k, 'PROBLEM_NO_ANSWER');
    }
    statuses.get('PS-MOCK-1').set('P7', 'PROBLEM_ACCEPTED');
    submissions.clear();
    finishedExams.clear();
    for (const k of Object.keys(EXAM_BY_SET)) delete EXAM_BY_SET[k];
    Object.assign(EXAM_BY_SET, EXAM_BY_SET_ORIGINAL);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && path === '/test/finished') {
    return send(res, 200, { finished: [...finishedExams] });
  }
  if (req.method === 'GET' && path === '/auth/login') {
    return send(res, 200, '<html>mock login</html>', { 'Content-Type': 'text/html', 'Set-Cookie': 'PTASession=mock-prewarm; Path=/' });
  }
  if (req.method === 'POST' && path === '/api/users/sessions') {
    const body = await readBody(req);
    if (!body.password || (!body.email && !body.phone)) return send(res, 400, { error: { code: 'INVALID_INPUT', message: 'missing credentials' } });
    const sid = randomUUID();
    sessions.set(sid, { id: 'u-mock', nickname: 'mock-user' });
    return send(res, 200, { user: { id: 'u-mock', nickname: 'mock-user' } }, { 'Set-Cookie': `MOCKSESSION=${sid}; Path=/` });
  }
  if (req.method === 'GET' && path === '/api/u/current') {
    if (!authed) return send(res, 404, { error: { code: 'USER_NOT_FOUND', message: 'not logged in' } });
    return send(res, 200, { user: sessions.get(cookie) });
  }
  if (req.method === 'GET' && path === '/api/problem-sets') {
    return send(res, 200, { problemSets: SETS, examIdByProblemSetId: EXAM_BY_SET });
  }
  const mExams = path.match(/^\/api\/problem-sets\/([^/]+)\/exams$/);
  if (req.method === 'GET' && mExams) {
    return send(res, 200, [{ id: EXAM_BY_SET[mExams[1]] || '', name: 'mock exam' }]);
  }
  // 自动建 exam（vscode-pintia createProblemSetExam）：POST 空 body，返回新 exam，
  // 并注册到 EXAM_BY_SET，让后续提交能反查到 psid。无 exam 的题集才走这条路。
  if (req.method === 'POST' && mExams) {
    const psid = mExams[1];
    if (!PROBLEMS[psid]) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'no such problem set' } });
    if (!EXAM_BY_SET[psid]) EXAM_BY_SET[psid] = `EX-MOCK-NEW-${psid}`;
    return send(res, 200, { id: EXAM_BY_SET[psid], name: 'mock exam (created)' });
  }
  const mSumm = path.match(/^\/api\/problem-sets\/([^/]+)\/problem-summaries$/);
  if (req.method === 'GET' && mSumm) {
    const list = PROBLEMS[mSumm[1]] || [];
    return send(res, 200, { problemSummaries: list.map((p) => ({ problemType: p.type, count: 1, score: p.score })) });
  }
  const mProbs = path.match(/^\/api\/problem-sets\/([^/]+)\/exam-problems$/);
  if (req.method === 'GET' && mProbs) {
    let list = PROBLEMS[mProbs[1]] || [];
    const type = url.searchParams.get('problem_type');
    if (type) list = list.filter((p) => p.type === type);
    return send(res, 200, { examProblems: list });
  }
  const mStatus = path.match(/^\/api\/exams\/([^/]+)\/problem-sets\/([^/]+)\/problem-status$/);
  if (req.method === 'GET' && mStatus) {
    const m = statuses.get(mStatus[2]) || new Map();
    return send(res, 200, { problemStatus: [...m.entries()].map(([problemSetProblemId, status]) => ({ problemSetProblemId, status })) });
  }
  const mLast = path.match(/^\/api\/exams\/([^/]+)\/problem-sets\/([^/]+)\/last-submissions$/);
  if (req.method === 'GET' && mLast) {
    const list = [...submissions.values()].filter((s) => s.examId === mLast[1]);
    return send(res, 200, { submissions: list.map((s) => ({ submissionId: s.id })) });
  }
  const mSubmit = path.match(/^\/api\/exams\/([^/]+)\/exam-submissions$/);
  if (req.method === 'POST' && mSubmit) {
    if (!authed) return send(res, 404, { error: { code: 'USER_NOT_FOUND', message: 'not logged in' } });
    const body = await readBody(req);
    const examId = mSubmit[1];
    if (finishedExams.has(examId)) {
      return send(res, 400, { error: { code: 'EXAM_ENDED', message: 'exam already finished' } });
    }
    const psid = Object.keys(EXAM_BY_SET).find((k) => EXAM_BY_SET[k] === examId) || '';
    const sid = `S-${randomUUID().slice(0, 8)}`;
    const results = [];
    let customTestResult = null;
    for (const detail of body.details || []) {
      const pspId = detail.problemSetProblemId;
      // customTestData：只跑自定义输入、不改题目状态，返回实际输出让客户端自己比对
      // （vscode-pintia 的 createSubmission 语义；服务端判题语义在 mock 里无法覆盖，见 PLAN §11）。
      const ctd = detail.programmingSubmissionDetail?.customTestData || detail.codeCompletionSubmissionDetail?.customTestData || null;
      if (ctd?.hasCustomTestData) {
        const code = detail.programmingSubmissionDetail?.program || detail.codeCompletionSubmissionDetail?.program || '';
        const compiler = detail.programmingSubmissionDetail?.compiler || detail.codeCompletionSubmissionDetail?.compiler || 'GCC';
        const r = await runSamples({ code, compiler, samples: [{ input: (ctd.content || '').replace(/\n$/, ''), output: '' }] }, `/tmp/mock-pta-judge/${pspId}-custom`);
        customTestResult = { input: ctd.content || '', output: r.results?.[0]?.actual ?? '', stderr: r.results?.[0]?.stderr ?? '' };
        continue;
      }
      const isCode = detail.programmingSubmissionDetail || detail.codeCompletionSubmissionDetail || detail.sqlProgrammingSubmissionDetail;
      let verdict;
      if (isCode) {
        const r = await gradeProgramming(detail, `/tmp/mock-pta-judge/${pspId}`);
        results.push(...r);
        verdict = r.every((x) => x.result === 'ACCEPTED') ? 'PROBLEM_ACCEPTED' : 'PROBLEM_WRONG_ANSWER';
      } else {
        verdict = gradeObjective(detail) === 'ACCEPTED' ? 'PROBLEM_ACCEPTED' : 'PROBLEM_WRONG_ANSWER';
        results.push({ testcaseId: 1, result: verdict === 'PROBLEM_ACCEPTED' ? 'ACCEPTED' : 'WRONG_ANSWER' });
      }
      statuses.get(psid)?.set(pspId, verdict);
    }
    submissions.set(sid, { id: sid, examId, createdAt: Date.now(), results, type: body.problemType, customTestResult });
    return send(res, 200, { submissionId: sid, status: 'JUDGING' });
  }
  const mDetail = path.match(/^\/api\/exams\/([^/]+)\/submissions\/([^/]+)$/);
  if (req.method === 'GET' && mDetail) {
    const s = submissions.get(mDetail[2]);
    if (!s) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'no such submission' } });
    if (Date.now() - s.createdAt < 1000) return send(res, 200, { status: 'JUDGING' });
    const out = { status: 'DONE', testcaseJudgeResults: s.results };
    if (s.customTestResult) out.customTestResult = s.customTestResult;
    return send(res, 200, out);
  }
  const mEnd = path.match(/^\/api\/exams\/([^/]+)\/end$/);
  if (req.method === 'PUT' && mEnd) {
    const examId = mEnd[1];
    if (finishedExams.has(examId)) {
      return send(res, 400, { error: { code: 'EXAM_ALREADY_ENDED', message: 'exam already finished' } });
    }
    finishedExams.add(examId);
    return send(res, 200, { ok: true, examId, endedAt: new Date().toISOString() });
  }
  if (req.method === 'POST' && path === '/chat/completions') {
    const body = await readBody(req);
    const msgs = body.messages || [];
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content || '';
    return send(res, 200, { choices: [{ message: { role: 'assistant', content: mockDSReply(lastUser) } }] });
  }
  return send(res, 404, { error: { code: 'NOT_FOUND', message: `no mock route ${req.method} ${path}` } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock PTA listening on http://127.0.0.1:${PORT}`);
});
