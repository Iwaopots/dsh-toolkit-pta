---
name: pta-cli
description: 在 DSH 里用账号密码登录拼题A（pintia.cn），拉题集、看进度、提交作业。触发条件：用户提到 PTA、拼题A、pintia、PTA 作业、PTA 刷题、PTA 自动提交时使用。
---

# PTA CLI Skill

## 一句话
PTA（拼题A，pintia.cn）的作业平台走账号密码登录：密码只在登录那一刻用，不落盘；登录后会话 cookie 存在各账号自己的目录里（0600），过期重登。

## 命令（工作区 CLI：`node "$DSH_PTA_CLI" <subcommand>`，默认 CLI 在 `plugins/pta/cli/pta.mjs`）

```bash
node cli/pta.mjs doctor                                        # 自检：node 版本、状态目录、账号数
node cli/pta.mjs login --user <邮箱或手机号> --label <名字>      # 交互输密码登录（密码不落盘）
node cli/pta.mjs accounts                                      # 列账号（只显示掩码，不输出 cookie）
node cli/pta.mjs problem-sets [--account <id|label>]           # 题集列表
node cli/pta.mjs problems --psid <id> [--type PROGRAMMING]     # 拉题
node cli/pta.mjs status --psid <id> --exam-id <E>              # 每题状态 + 写进度缓存
node cli/pta.mjs submit --exam-id <E> --type <TYPE> --answers <answers.json>  # 先预览，不加 --yes 不真交
node cli/pta.mjs dashboard [--account <id|label>]              # 生成进度看板 dashboard.html
```

## 账号与空间
- 状态根目录：`$PTA_STATE_DIR` 或 `~/.pta`；每账号独立目录 `accounts/<id>/`，下有 `session.json`、`progress/`、`work/`。
- 账号表 `accounts.json` 只存 id / label / 登录名掩码 / 状态，不存密码、不存原始 cookie。
- 切号即切空间：所有命令接受 `--account <id|label>`；不传时只有一个账号自动选中，多个必须指明。

## 登录与验证码
- 登录接口：`POST passport.pintia.cn/api/users/sessions`，body `{email|phone, password, rememberMe, ticket, randStr}`。
- 先无票发一次；网关回 `GATEWAY_WRONG_CAPTCHA` 时，带 `--ticket <T> --rand-str <R>` 重试，票从 DSH 浏览器里人手过一次腾讯防水墙拿。
- 会话复用判定走 `GET /api/u/current`；失效就重新登录，不要反复登录触发风控（登录限频 20s）。

## 做题流程
1. `problem-sets` 找题集 → `problems --psid` 拉题（注意 `id` 是提交用的 problemSetProblemId）。
2. 编程题：先在本地用题目样例自测，通过再交；客观题：整卷一次提交，提交前先给用户看答案预览。
3. `submit` 默认只预览（dry-run），加 `--yes` 才真交。
4. `status` 刷新每题状态（`PROBLEM_NO_ANSWER` / `SUBMITTED` / `ACCEPTED` / `WRONG_ANSWER` / `PARTIAL_ACCEPTED`），`dashboard` 生成看板。

## 红线
- 只做平时练习 / 作业题集，**不碰正式考试**（PTA 正式考试接 OMS 监考，自动化提交可能被记违规）。
- 提交前必须确认；不静默交卷。
- 凭据不进仓库：`~/.pta/`、`session.json` 一律 gitignore。
- 接口来自第三方逆向笔记，未实测的调用标 `TODO(verify)`；实测一轮后再消标记。
