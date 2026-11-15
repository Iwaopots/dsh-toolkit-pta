import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// v1 用 JSON 存账号表（省掉 sqlite 依赖）；v0.3 照 educoder 的 accounts.js 换 sqlite。
// 密码永不落盘：这里只存账号元数据，cookie 存在各账号自己的 session.json（0600）。

export function stateRoot() {
  return process.env.PTA_STATE_DIR || join(homedir(), '.pta');
}

export function accountsFile() {
  return join(stateRoot(), 'accounts.json');
}

export function accountDir(id) {
  return join(stateRoot(), 'accounts', id);
}

export function ensureState() {
  mkdirSync(join(stateRoot(), 'accounts'), { recursive: true });
  if (!existsSync(accountsFile())) {
    writeFileSync(accountsFile(), JSON.stringify({ version: 1, accounts: [] }, null, 2), { mode: 0o600 });
  }
}

export function loadAccounts() {
  ensureState();
  try {
    return JSON.parse(readFileSync(accountsFile(), 'utf8')).accounts;
  } catch {
    return [];
  }
}

function saveAccounts(list) {
  writeFileSync(accountsFile(), JSON.stringify({ version: 1, accounts: list }, null, 2), { mode: 0o600 });
}

export function maskLogin(login) {
  if (!login) return '***';
  if (login.includes('@')) {
    const [u, d] = login.split('@');
    return `${u.slice(0, 2)}***@${d}`;
  }
  return login.length > 4 ? `${login.slice(0, 3)}***${login.slice(-2)}` : '***';
}

export function addAccount({ label, login }) {
  const list = loadAccounts();
  const id = randomUUID();
  const row = { id, label: label || login, loginMasked: maskLogin(login), status: 'unverified', updatedAt: new Date().toISOString() };
  mkdirSync(join(accountDir(id), 'progress'), { recursive: true });
  mkdirSync(join(accountDir(id), 'work'), { recursive: true });
  list.push(row);
  saveAccounts(list);
  return row;
}

export function setAccountStatus(id, status) {
  const list = loadAccounts();
  const row = list.find((a) => a.id === id);
  if (!row) return null;
  row.status = status;
  row.updatedAt = new Date().toISOString();
  saveAccounts(list);
  return row;
}

// --account 接受 id 或 label；不传时只有一个可用账号自动选中，多个则报错。
export function resolveAccount(ref) {
  const list = loadAccounts().filter((a) => a.status !== 'removed');
  if (ref) {
    const row = list.find((a) => a.id === ref || a.label === ref);
    if (!row) throw new Error(`account not found: ${ref}`);
    return row;
  }
  if (list.length === 1) return list[0];
  if (list.length === 0) throw new Error('no accounts yet, run `login` first');
  throw new Error('multiple accounts, pass --account <id|label>');
}

export function sessionFile(id) {
  return join(accountDir(id), 'session.json');
}

export function readSession(id) {
  try {
    return JSON.parse(readFileSync(sessionFile(id), 'utf8'));
  } catch {
    return null;
  }
}

export function writeSession(id, session) {
  const file = sessionFile(id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows 无 unix 权限位 */ }
}

export function clearSession(id) {
  try {
    writeFileSync(sessionFile(id), JSON.stringify({ cookie: '', updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  } catch { /* ignore */ }
}

export function progressFile(id, psid) {
  return join(accountDir(id), 'progress', `${psid}.json`);
}

export function writeProgress(id, psid, data) {
  const file = progressFile(id, psid);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

export function readProgress(id, psid) {
  try {
    return JSON.parse(readFileSync(progressFile(id, psid), 'utf8'));
  } catch {
    return null;
  }
}
