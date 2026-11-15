#!/usr/bin/env node
// PTA（pintia.cn）CLI for DSH — v0.1 骨架。
// 用法：node pta.mjs <command> [options]
// 密码只在登录那一刻用（交互输入或 --password-stdin），不落盘、不进仓库。
// 验证码分支：登录返回 GATEWAY_WRONG_CAPTCHA 时，用 --ticket / --rand-str 带票重试，
// 票从 DSH 浏览器里人手过一次防水墙拿；v0.2 再接自动求解。

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PTAClient, PTAError } from './lib/pta-client.mjs';
import * as store from './lib/store.mjs';

const HELP = `pta — 拼题A（pintia.cn）CLI for DSH
  login --user <email|phone> [--label <name>] [--ticket T --rand-str R]
  accounts
  problem-sets [--account <id|label>] [--limit N]
  exams --psid <id> [--account <id|label>]
  problems --psid <id> [--exam-id E] [--type PROGRAMMING] [--account <id|label>]
  status --psid <id> --exam-id E [--account <id|label>]
  submit --exam-id E --type <TYPE> --answers <answers.json> [--account <id|label>]
  dashboard [--account <id|label>]
  doctor
状态文件：$PTA_STATE_DIR 或 ~/.pta（accounts.json + accounts/<id>/{session.json,progress/,work/}）
`;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else out._.push(a);
  }
  return out;
}

function readPasswordStdin() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    process.stdout.write('PTA password (input hidden in DSH credential flow; here typed then discarded): ');
    rl.on('line', (line) => { rl.close(); resolve(line.trim()); });
  });
}

async function authedClient(account) {
  const session = store.readSession(account.id);
  if (!session?.cookie) throw new PTAError('NOT_LOGGED_IN', `account ${account.label} has no session, run login first`);
  const client = new PTAClient(session.cookie);
  try {
    await client.current(); // 会话复用判定
  } catch (e) {
    if (e.code === 'NOT_LOGGED_IN') throw new PTAError('NOT_LOGGED_IN', `session expired for ${account.label}, run login again (password re-entry)`);
    throw e;
  }
  if (client.cookie !== session.cookie) store.writeSession(account.id, { cookie: client.cookie, updatedAt: new Date().toISOString() });
  return client;
}

const STATUS_LABEL = {
  PROBLEM_NO_ANSWER: '未答',
  PROBLEM_SUBMITTED: '已提交',
  PROBLEM_ACCEPTED: '通过',
  PROBLEM_WRONG_ANSWER: '答错',
  PARTIAL_ACCEPTED: '部分通过',
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = args(rest);
  try {
    switch (cmd) {
      case 'login': {
        const user = o.user;
        if (!user) throw new Error('login needs --user <email|phone>');
        const password = o.passwordStdin ? await readPasswordStdin() : (process.env.PTA_PASSWORD || '');
        if (!password) throw new Error('no password: pipe it via --password-stdin or set PTA_PASSWORD (never commit it)');
        const account = store.addAccount({ label: o.label, login: user });
        const client = new PTAClient();
        await client.prewarm();
        try {
          await client.login({ user, password, ticket: o.ticket || '', randStr: o.randStr || '' });
        } catch (e) {
          if (e.code === 'GATEWAY_WRONG_CAPTCHA' && !o.noCaptcha) {
            // 滑块验证码：先走纯协议求解器（tcaptcha.py），失败再回退人工。
            console.log('captcha hit, trying protocol solver...');
            try {
              const { solveCaptcha } = await import('./lib/captcha.mjs');
              const solved = await solveCaptcha({});
              console.log(`captcha solved x=${solved.x} in ${solved.stat?.total_ms}ms, retrying login...`);
              await client.login({ user, password, ticket: solved.ticket, randStr: solved.randstr });
            } catch (solveErr) {
              console.log(`auto-solve failed: ${solveErr.message}`);
              console.log('manual fallback: complete the Tencent captcha once in the DSH browser, then retry with --ticket <T> --rand-str <R>');
              store.setAccountStatus(account.id, 'manual');
              return;
            }
          } else if (e.code === 'GATEWAY_WRONG_CAPTCHA') {
            console.log('captcha required: complete the Tencent captcha once in the DSH browser, then retry with --ticket <T> --rand-str <R>');
            store.setAccountStatus(account.id, 'manual');
            return;
          } else {
            throw e;
          }
        }
        store.writeSession(account.id, { cookie: client.cookie, updatedAt: new Date().toISOString() });
        store.setAccountStatus(account.id, 'ready');
        console.log(JSON.stringify({ ok: true, id: account.id, label: account.label, login: account.loginMasked, status: 'ready' }));
        break;
      }
      case 'accounts': {
        for (const a of store.loadAccounts()) {
          console.log(`${a.id}  ${a.label}  ${a.loginMasked}  ${a.status}  ${a.updatedAt}`);
        }
        break;
      }
      case 'problem-sets': {
        const account = store.resolveAccount(o.account);
        const client = await authedClient(account);
        const data = await client.problemSets({ limit: Number(o.limit || 20) });
        const sets = data.problemSets || data || [];
        for (const s of sets) console.log(`${s.id}  ${s.name || s.title || ''}  end=${s.endAt || ''}`);
        break;
      }
      case 'exams': {
        const account = store.resolveAccount(o.account);
        const client = await authedClient(account);
        if (!o.psid) throw new Error('exams needs --psid <id>');
        console.log(JSON.stringify(await client.exams(o.psid), null, 2).slice(0, 4000));
        break;
      }
      case 'problems': {
        const account = store.resolveAccount(o.account);
        const client = await authedClient(account);
        if (!o.psid) throw new Error('problems needs --psid <id>');
        const data = await client.examProblems(o.psid, { examId: o.examId || '', problemType: o.type || '' });
        const list = data.examProblems || data.problems || [];
        for (const p of list) console.log(`${p.id}  [${p.type || ''}] ${p.score || ''}分  ${(p.content || '').split('\n')[0].slice(0, 60)}`);
        break;
      }
      case 'status': {
        const account = store.resolveAccount(o.account);
        const client = await authedClient(account);
        if (!o.psid || !o.examId) throw new Error('status needs --psid <id> --exam-id <E>');
        const data = await client.problemStatus(o.examId, o.psid);
        store.writeProgress(account.id, o.psid, { fetchedAt: new Date().toISOString(), examId: o.examId, data });
        const items = data.problemStatus || data.status || data || [];
        const counts = {};
        for (const it of items) counts[it.status || it.problemStatus || 'UNKNOWN'] = (counts[it.status || it.problemStatus || 'UNKNOWN'] || 0) + 1;
        const total = items.length;
        const done = counts.PROBLEM_ACCEPTED || 0;
        console.log(`psid=${o.psid} total=${total} accepted=${done} ${JSON.stringify(counts)}`);
        for (const it of items) console.log(`  ${it.problemSetProblemId || it.id}  ${STATUS_LABEL[it.status || it.problemStatus] || it.status}`);
        break;
      }
      case 'submit': {
        const account = store.resolveAccount(o.account);
        const client = await authedClient(account);
        if (!o.examId || !o.type || !o.answers) throw new Error('submit needs --exam-id E --type <TYPE> --answers <answers.json>');
        const payload = JSON.parse(readFileSync(o.answers, 'utf8'));
        const details = payload.details || payload;
        console.log(`preview: ${details.length} detail(s), type=${o.type}, exam=${o.examId}`);
        console.log(JSON.stringify(details, null, 2).slice(0, 2000));
        if (!o.yes) {
          console.log('dry-run only: re-run with --yes to actually submit');
          break;
        }
        const res = await client.submit(o.examId, o.type, details);
        console.log(JSON.stringify(res).slice(0, 2000));
        break;
      }
      case 'dashboard': {
        const account = store.resolveAccount(o.account);
        const sets = store.loadAccounts();
        void sets;
        const { readdirSync } = await import('node:fs');
        const dir = join(store.accountDir(account.id), 'progress');
        let files = [];
        try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { /* no cache yet */ }
        const rows = files.map((f) => {
          const c = store.readProgress(account.id, f.replace('.json', ''));
          const items = c?.data?.problemStatus || c?.data?.status || [];
          const counts = {};
          for (const it of items) counts[it.status || 'UNKNOWN'] = (counts[it.status || 'UNKNOWN'] || 0) + 1;
          const total = items.length || 1;
          const ok = counts.PROBLEM_ACCEPTED || 0;
          return { psid: f.replace('.json', ''), total, ok, counts, fetchedAt: c?.fetchedAt || '' };
        });
        const bar = (r) => {
          const pct = Math.round((r.ok / r.total) * 100);
          return `<div style="background:#eee;height:16px;border-radius:8px;overflow:hidden"><div style="width:${pct}%;background:#22c55e;height:100%"></div></div>`;
        };
        const html = `<!doctype html><meta charset="utf-8"><title>PTA 进度 — ${account.label}</title>
<h1>PTA 进度 — ${account.label}</h1><p>生成时间 ${new Date().toLocaleString('zh-CN')}</p>
${rows.map((r) => `<section style="margin:12px 0"><h3>题集 ${r.psid}（${r.ok}/${r.total} 通过）</h3>${bar(r)}<p>${JSON.stringify(r.counts)} · 更新 ${r.fetchedAt}</p></section>`).join('') || '<p>暂无缓存，先跑 status 拉一次进度。</p>'}`;
        const out = join(store.accountDir(account.id), 'dashboard.html');
        writeFileSync(out, html);
        console.log(`dashboard written: ${out}`);
        break;
      }
      case 'doctor': {
        console.log(JSON.stringify({ node: process.version, stateDir: store.stateRoot(), accounts: store.loadAccounts().length }, null, 2));
        break;
      }
      default:
        process.stdout.write(HELP);
    }
  } catch (e) {
    if (e instanceof PTAError) {
      console.error(`ERR ${e.code}: ${e.message}`);
      process.exitCode = 2;
    } else {
      console.error(`ERR: ${e.message}`);
      process.exitCode = 2;
    }
  }
}

main();
