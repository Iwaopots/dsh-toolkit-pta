# PTA 平台（DSH 内运行）— 设计文档 v0.1

> 日期：2026-11-16 凌晨。状态：调研完成 + 骨架已搭，未经真号实测。
> 目标：照着 `blueforst/dsh-toolkit-educoder` 的路子，给拼题A（pintia.cn）做一个能在 DSH 里跑的作业平台。

## 1. 参考项目看完了：dsh-toolkit-educoder 是什么

`blueforst/dsh-toolkit-educoder`，核心是 DSH 插件 `@forst/dsh-educoder`（0.2.10，MIT），给头歌（EduCoder）用的：

| 层 | 东西 | 作用 |
|---|---|---|
| 插件入口 | `plugins/educoder/index.js`、`agent.js`（49KB）、`client.js`（108KB）、`worker.js`、`scheduler.js` | DSH 插件本体：账号控制面、任务队列、Web 面板、Worker 回合 |
| 账号 | `accounts.js` + `accounts.sqlite`（0600）+ DSH 本地凭据服务 | 账号表只存 id / remoteId / label / status；会话（cookie）存在 DSH 凭据记录 `dsh-educoder/account-<id>`，**不存原始密码、不写明文凭据到磁盘** |
| CLI | `plugins/educoder/cli/educoder.mjs` + `lib/` | 自愈 CLI：`accounts` / `courses` / `homeworks` / `inspect` / `read-file` / `save-file` / `evaluate` / `submit-choices` / `terminal` / `browser` / `images` / `doctor` / `cli-diff` / `cli-restore`，带 `.baseline/` 基线快照，插件升级自动保留改过的源码 |
| Skill | `plugins/educoder/skills/educoder-cli/SKILL.md` | 工作区初始化时自动同步，DSH 原生 `ctx.skills` 发现，不用往提示词堆多账号说明 |
| 会话 | DSH 原生 `SessionController` | 作业会话常驻“EduCoder”共享工作区，24 小时内复用，做完回 `idle` 不销毁；仅在做题回合内限定开放编码工具 |
| 部署 | `deploy/educoder/` | Docker Compose、凭据隔离补丁、验收记录、作业准确率实测 |

关键结论（照抄它的架构，不照抄代码）：
- 多账号 = sqlite 账号表 + 凭据服务存会话 + 每账号独立工作目录。
- 它只存 cookie、不存密码 —— 这正是用户要求改掉的点（见 §3）。
- 可视化只有任务队列 + 脱敏日志，没有“每道题做到哪了”的进度视图 —— 这正是用户要求补的点（见 §4）。

## 2. PTA（拼题A）接口实测结论

来源：`kisakiayano/PTA-mcp` 的 `PLATFORM_NOTES.md`（从 `static.pintia.cn/exam-app` 生产前端逆向 + 实测），以及 `jinzcdev/vscode-pintia`、`jaceyone/pta-auto-solver`。**端点是二手逆向结论，未经我方真号验证**，骨架里的每个调用都要打上“待实测”标记，拿用户真号跑一遍才算数。

### 登录（原生就是账号密码，不是只有 cookie）
- `POST https://passport.pintia.cn/api/users/sessions`，body 平铺 `{email|phone, password, rememberMe, ticket, randStr}`。
- reactive 验证码流程：先发无票请求，网关回 `GATEWAY_WRONG_CAPTCHA` 才弹验证码（腾讯防水墙，`TencentCaptcha("194593025")`），带票重试。
- 会话复用判定：`GET /api/u/current`，有效直接复用，避免重复登录触发风控。
- 结论：cookie 只是登录后缓存的会话，登录本身就是账号密码。v1 做到：密码登录 → 会话缓存 → 过期自动重登；验证码出现时走人工票据（`--ticket` / `--rand-str`）或 DSH 浏览器里人手过一次，不硬编滑块求解器。

### 读题 / 进度（可视化的数据源）
- `GET /api/problem-sets?filter=&limit=&order_by=END_AT&asc=true`（含 `examIdByProblemSetId`）
- `GET /api/problem-sets/{psid}/exams`
- `GET /api/problem-sets/{psid}/problem-summaries`（各题型题量与总分）
- `GET /api/problem-sets/{psid}/exam-problems?exam_id=&problem_type=`（`id` = 提交用的 problemSetProblemId；`problemId` 是另一套题库 ID，别混）
- `GET /api/exams/{exid}/problem-sets/{psid}/problem-status`（**学生视角每题状态**，可视化就靠它）
- `GET /api/exams/{exid}/problem-sets/{psid}/last-submissions?problemType=`
- `GET /api/exams/{exid}/submissions/{submission_id}`（判题详情，含 testcaseJudgeResults）

每题状态取值：`PROBLEM_NO_ANSWER` / `PROBLEM_SUBMITTED` / `PROBLEM_ACCEPTED` / `PROBLEM_WRONG_ANSWER` / `PARTIAL_ACCEPTED`；考试级 `PROCESSING` / `END`。

### 提交
- `POST /api/exams/{exam_id}/exam-submissions`，body `{problemType, details}`。
- 客观题（判断/单选/多选/填空）：**一次整卷提交**，服务端按题型整卷 upsert，后一次覆盖前一次。
- 编程题 / 代码补全 / SQL：**逐题提交**，独立记录。
- `details[i] = { problemId:"0", problemSetProblemId:<exam-problems[].id>, <detailKey>:{...} }`，各题型 detailKey 见 PLATFORM_NOTES §1。
- 编译器枚举：`GCC GXX CLANG CLANGXX JAVAC PYTHON2 PYTHON3 RUBY BASH ...`；`compiler:"NO_COMPILER"` 表示未锁定。
- `PUT /api/exams/{exid}/end` 交卷（触发客观题判题）。交卷前 `standard-answers` 返回空，客观题无法自查。

### 风控与坑
- 单 IP 高频登录 / 多次失败登录会进风控窗口：登录限频（pta-auto-mcp 内置 20s 限频），提交也要限频。
- `GATEWAY_WRONG_CAPTCHA` 既可能是验证码错，也可能是风控兜底。
- 路径写错时前端路由兜底返回 `index.html`，配 `Accept: application/json` 会得到 406 空响应体 —— 工具里要统一报 `NOT_JSON` 而不是直接 `.json()` 抛错。
- `X-Lollipop` / `X-Marshmallow` 实测只读接口不带也能 200，非必需。

## 3. 账号设计：独立密码 + 独立账号空间

用户要求：每个账号有独立密码、独立空间；登录走账号密码，不要只局限于 cookie。

- **密码只在登录那一刻用，不落盘**。登录时由用户在受保护页面 / DSH 凭据服务里输入，或 CLI 交互输入（stdin，不回显、不进 shell 历史）；换到会话 cookie 后密码即丢弃。会话 cookie 存在各账号自己的目录里（0600），过期用保存的登录方式重登 —— 重登需要密码时，找 DSH 凭据服务要，不在仓库里存任何密码明文。
- **一账号一目录**：`~/.pta/accounts/<account-id>/`，下面放 `session.json`（cookie + 过期时间）、`progress/`（每题集进度缓存）、`work/`（答案文件、源码草稿）。账号之间不共享 cookie、不共享进度。
- **账号表**：`accounts.json`（或 sqlite，二选一，v1 用 JSON 省依赖）只存 id / label / 登录名掩码 / 状态（`ready` / `auth_required` / `manual` / `removed`）/ 更新时间，不存密码、不存原始 cookie（cookie 在各账号目录里）。
- **切号即切空间**：所有子命令都接受 `--account <id|label>`；不传时若只有一个可用账号自动选中，多个则报错让用户指明，不猜。

## 4. 可视化：能看到做了哪些部分

educoder 插件只有队列 + 日志，本项目补一个进度看板：

- 数据源就是 `problem-status`（每题状态）+ `problem-summaries`（题量/总分），每次 `status` 命令刷新缓存。
- `pta.mjs dashboard [--account X]` 生成一张静态 `dashboard.html`（放账号目录里，DSH 里直接打开）：
  - 顶层：每账号一行，题集总数 / 已完成题集 / 进行中。
  - 每题集一张卡：名称、截止时间、总分、进度条（已通过 / 已提交待判 / 答错 / 未答，四段颜色），点开是按题型分组的每题清单（题号、题型、分值、状态、最后提交时间）。
  - 状态色：未答灰、已提交蓝、通过绿、答错红、部分通过黄。
- 同时 CLI 输出紧凑文本版（`status` 命令默认只打摘要，不把整卷 JSON 往对话里倒，省 token）。

## 5. DSH 里怎么跑

照 educoder 插件的包结构：

```
dsh-toolkit-pta/
  package.json                    # 根包（工作区说明）
  plugins/pta/
    package.json                  # @iwaopots/dsh-pta 0.1.0，engines node >= 22
    index.js                      # 插件入口（v1 先占位，复用 CLI）
    cli/pta.mjs                   # CLI 本体（v1 已实现，见骨架）
    cli/lib/pta-client.mjs        # API 客户端（登录/读题/提交/状态）
    cli/lib/store.mjs             # 账号表 + 每账号目录 + 会话读写
    skills/pta-cli/SKILL.md       # DSH 原生 skill，工作区自动同步
    dashboard/                    # 看板模板（v1 由 CLI 内联生成）
    README.md
  deploy/pta/                     # v2：Compose + 凭据隔离说明（照 deploy/educoder 的样子）
```

安装（在 DSH 里，照 educoder 的命令）：
```bash
npm pack ./plugins/pta --pack-destination dist
dsh plugin --profile web add --ignore-scripts --save-exact "$PWD/dist/iwaopots-dsh-pta-0.1.0.tgz"
```
v1 先以 CLI + skill 的形态在 DSH 工作区里跑通（`node "$DSH_PTA_CLI" <subcommand>`），插件 UI（client.js / 面板）放 v2。

## 6. 红线

- **只做平时练习 / 作业题集，不碰正式考试**。PTA 正式考试接 OMS 监考客户端，任何自动化提交都可能被记违规；题集页是练习性质的才做。`submit` 命令默认拒绝 `exam` 类型里标记为正式考试的卷（以后按实测再细化判定）。
- **提交前必须有确认**：编程题先本地用题目样例自测，客观题整卷提交前先打一份答案预览给用户看，不静默交卷。
- **不编造接口**：所有端点来自 §2 的逆向笔记，未实测的调用在代码里标 `TODO(verify)`，实测一轮后才去掉标记。
- **凭据不进仓库**：`~/.pta/`、`*.session.json`、任何含 cookie / 密码的文件一律 gitignore；仓库里只放代码和文档。
- **许可证**：参考了 MIT 的 educoder 插件结构与 PTA-mcp 的接口笔记（只参考端点形状，不复制代码）；本仓库新写代码用 MIT。

## 7. 路线

- **v0.1（本轮）**：调研 + 设计文档 + CLI 骨架（login / accounts / problem-sets / problems / status / submit / dashboard）+ skill 文件。放工作区，待用户定目标仓库后推上去。
- **v0.2**：拿用户真号实测登录 → 拉题集 → 拉一题状态 → 交一道练习题（编程题先本地自测），把 `TODO(verify)` 逐个消掉；验证码分支实测。
- **v0.3**：DSH 插件化（index.js + 工作区自动同步 skill + `DSH_PTA_ACCOUNTS` 快照注入，照 educoder 的 `accounts.js` 模式）；看板进 DSH 面板。
- **之后**：按用户需求改 —— 队列调度（一键通关题集）、多账号批量、错题重做、经验沉淀（`解题经验.md` 同款）。

## 8. 实测记录（2026-11-16 凌晨，真号）

- 登录端点 `POST passport.pintia.cn/api/users/sessions` 是真的：第一次无票请求即回
  `GATEWAY_WRONG_CAPTCHA`，与逆向笔记一致。
- 验证码是真卡点：预热 + 浏览器级请求头也躲不掉，网关对这个账号/IP 每次都弹滑块。
- 已实现纯协议滑块求解器（`cli/lib/captcha.mjs` + `cli/lib/locate.py`，算法源自
  kisakiayano/PTA-mcp 的 solve.py，MIT）：prehandle → 取图 → 缺口定位 → PoW → verify。
  **2026-11-16 实测解出 x=443，用时 63.6 秒**，票有效、登录重试已发出。
  注意：本机 Python requests 走出口代理到 `turing.captcha.qcloud.com` 会超时，
  所以 HTTP 全走 Node fetch，只把图像计算交给 Python（Pillow + numpy，不联网）。
  求解器依赖：Python 3 + Pillow/numpy（DSH 所在机器上要有）。
- 登录重试被 PTA 拒：**「该手机号无效」**——用户给的手机号不是该 PTA 账号的
  注册手机号，或账号本身是邮箱注册。待用户确认注册方式（邮箱/手机号）再试。
  勿连续盲试，防风控。
- `u/current` 正确域名是 `passport.pintia.cn`（骨架初版写错成 pintia.cn，已修）。
- `npm pack` 已验：包 15.4 kB、8 个文件，可打 tgz。DSH 侧现状：CLI + skill 可在
  DSH 工作区终端里跑（Node ≥22），但完整插件（index.js / Web 面板 / 自动同步）
  还没写，那是 v0.3 的活。
