// PTA（pintia.cn）API 客户端。端点形状来自 kisakiayano/PTA-mcp 的 PLATFORM_NOTES.md
//（生产前端逆向 + 实测），未经我方真号验证 —— 每个方法上标了 TODO(verify)，实测后消掉。
// 只用标准 fetch，不依赖任何第三方包。

const BASE = 'https://pintia.cn';
const PASSPORT = 'https://passport.pintia.cn';

export class PTAError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// 路径写错时 PTA 前端路由兜底返回 index.html，配 Accept: application/json 会得到
// 406 空响应体 —— 直接 .json() 会抛错，统一归一成 NOT_JSON。
async function readJson(res) {
  const text = await res.text();
  if (!text) throw new PTAError('NOT_JSON', `empty body (HTTP ${res.status})`);
  try {
    return JSON.parse(text);
  } catch {
    throw new PTAError('NOT_JSON', `non-JSON body (HTTP ${res.status}): ${text.slice(0, 120)}`);
  }
}

function pickCookies(res) {
  // undici 的 getSetCookie()；没有时退回单条 set-cookie。
  if (typeof res.headers.getSetCookie === 'function') {
    const all = res.headers.getSetCookie();
    if (all.length) return all.map((c) => c.split(';')[0]).join('; ');
  }
  const single = res.headers.get('set-cookie');
  return single ? single.split(';')[0] : '';
}

export class PTAClient {
  constructor(cookie = '') {
    this.cookie = cookie;
  }

  async request(path, { method = 'GET', body = null, base = BASE } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: body ? JSON.stringify(body) : null,
    });
    const next = pickCookies(res);
    if (next) this.cookie = next;
    const data = await readJson(res);
    if (data && typeof data === 'object' && data.error) {
      const code = data.error.code || data.error;
      // USER_NOT_FOUND(404) 在未登录时出现，容易误判，归一成 NOT_LOGGED_IN。
      if (code === 'USER_NOT_FOUND' && res.status === 404) throw new PTAError('NOT_LOGGED_IN', 'session expired or not logged in');
      throw new PTAError(code, data.error.message || code);
    }
    if (!res.ok) throw new PTAError(`HTTP_${res.status}`, `HTTP ${res.status} on ${path}`);
    return data;
  }

  // TODO(verify): 登录。reactive 验证码：先无票发一次，网关回 GATEWAY_WRONG_CAPTCHA
  // 才需要 ticket + randStr（腾讯防水墙 TencentCaptcha("194593025") 的票）。
  async login({ user, password, ticket = '', randStr = '' }) {
    const isEmail = user.includes('@');
    const body = {
      ...(isEmail ? { email: user } : { phone: user }),
      password,
      rememberMe: true,
      ticket,
      randStr,
    };
    const data = await this.request('/api/users/sessions', { method: 'POST', body, base: PASSPORT });
    return data;
  }

  // TODO(verify): 会话复用判定。有效直接复用，避免重复登录触发风控。
  async current() {
    return this.request('/api/u/current');
  }

  // TODO(verify): 题目集列表，含 examIdByProblemSetId。
  async problemSets({ limit = 20 } = {}) {
    return this.request(`/api/problem-sets?limit=${limit}&order_by=END_AT&asc=true`);
  }

  // TODO(verify)
  async exams(psid) {
    return this.request(`/api/problem-sets/${psid}/exams`);
  }

  // TODO(verify): 各题型题量与总分。
  async problemSummaries(psid) {
    return this.request(`/api/problem-sets/${psid}/problem-summaries`);
  }

  // TODO(verify): 题目列表。注意 id = 提交用的 problemSetProblemId，
  // 该数组里 problemSetProblemId 字段为 null、problemId 是另一套题库 ID，别混。
  async examProblems(psid, { examId = '', problemType = '' } = {}) {
    const q = new URLSearchParams({ ...(examId ? { exam_id: examId } : {}), ...(problemType ? { problem_type: problemType } : {}) });
    return this.request(`/api/problem-sets/${psid}/exam-problems?${q}`);
  }

  // TODO(verify): 学生视角每题状态 —— 可视化的数据源。
  async problemStatus(examId, psid) {
    return this.request(`/api/exams/${examId}/problem-sets/${psid}/problem-status`);
  }

  // TODO(verify): 判题详情，含 testcaseJudgeResults。
  async submissionDetail(examId, submissionId) {
    return this.request(`/api/exams/${examId}/submissions/${submissionId}`);
  }

  // TODO(verify): 提交。客观题整卷 upsert（按题型一次全交），编程题逐题。
  // details[i] = { problemId:"0", problemSetProblemId:<exam-problems[].id>, <detailKey>:{...} }
  async submit(examId, problemType, details) {
    return this.request(`/api/exams/${examId}/exam-submissions`, {
      method: 'POST',
      body: { problemType, details },
    });
  }

  // TODO(verify): 交卷（触发客观题判题）。
  async endExam(examId) {
    return this.request(`/api/exams/${examId}/end`, { method: 'PUT' });
  }
}
