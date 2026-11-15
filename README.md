# DSH PTA 平台（`@iwaopots/dsh-pta`）

在 DSH 里跑的拼题A（pintia.cn）作业平台。照着 `blueforst/dsh-toolkit-educoder` 的路子做的，但改了两点：

1. **账号密码登录，不只 cookie**：登录走 `POST passport.pintia.cn/api/users/sessions`，密码只在登录那一刻用，不落盘；会话 cookie 存在各账号自己的目录里，过期重登。
2. **独立账号空间 + 进度可视化**：一账号一目录（会话、进度缓存、答案草稿全隔离）；`status` 拉每题状态，`dashboard` 生成进度看板，能看到每个题集做到哪了。

## 快速开始

```bash
node plugins/pta/cli/pta.mjs doctor
node plugins/pta/cli/pta.mjs login --user <邮箱或手机号> --label <名字>   # 交互输密码
node plugins/pta/cli/pta.mjs problem-sets
node plugins/pta/cli/pta.mjs status --psid <id> --exam-id <E>
node plugins/pta/cli/pta.mjs dashboard
```

## 布局

```
plugins/pta/
  cli/pta.mjs              # CLI 本体
  cli/lib/pta-client.mjs   # API 客户端（登录/读题/提交/状态）
  cli/lib/store.mjs        # 账号表 + 每账号目录 + 会话读写
  skills/pta-cli/SKILL.md  # DSH 原生 skill
```

## 红线

- 只做平时练习 / 作业题集，**不碰正式考试**（OMS 监考）。
- 提交前必须确认；`submit` 默认只预览，加 `--yes` 才真交。
- 凭据不进仓库：`~/.pta/`、`session.json` 一律 gitignore。
- 接口来自第三方逆向笔记（`kisakiayano/PTA-mcp` 的 PLATFORM_NOTES.md），未经真号实测；代码里标 `TODO(verify)` 的调用，实测一轮后再消标记。

## 路线

- v0.1：CLI 骨架 + 设计文档（`PLAN.md` 在工作区根目录）。
- v0.2：真号实测登录 → 拉题集 → 拉状态 → 交一道练习题。
- v0.3：DSH 插件化（工作区自动同步 skill + 账号快照注入，照 educoder 的模式）。
