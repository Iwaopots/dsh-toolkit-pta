# DSH PTA 平台（`@iwaopots/dsh-pta`）

在 DSH 里跑的拼题A（pintia.cn）作业平台。照着 `blueforst/dsh-toolkit-educoder` 的路子做的，但改了两点：

1. **账号密码登录，不只 cookie**：登录走 `POST passport.pintia.cn/api/users/sessions`，密码只在登录那一刻用，不落盘；会话 cookie 存在各账号自己的目录里，过期自动重登（凭据引用按账号走）。
2. **独立账号空间 + 进度可视化**：一账号一目录（会话、进度缓存、答案草稿全隔离）；`status` 拉每题状态，`dashboard` 生成进度看板，`serve` 起实时控制台。

## 最终用法（用户定）：面板驱动

用户输一次账号密码，DSH 全自动、像真人一样完成全部作业。**不用跟模型对话**：打开面板点按钮就行。

```bash
node plugins/pta/cli/pta.mjs serve --port 18766   # 打开 http://127.0.0.1:18766/
```

面板上有登录框（账号 + 密码，密码只进内存），点“🚀 一键完成作业”就开始跑全链路：DS 解题 → 本地样例自测 → 拟人节律 → 提交 → 判题回读 → 看板实时显示进度。想停就点“⏹️ 停止”，想歇会儿点“⏸️ 暂停”。

## 动作注册表

面板按钮不是写死的：每一个动作都是 `plugins/pta/cli/lib/action-registry.mjs` 里的一项（名字、图标、接口、要不要二次确认、运行中能不能点），以后加功能只加注册项、不改框架。v0.2 实际 34 个动作，分 5 组：

| 组 | 动作 |
|---|---|
| 账号 | 登录、登出、切换账号、添加账号、删除账号、一键测活、启用/停用账号 |
| 题集 | 拉取题集列表、刷新、查看题目列表、选定题集开始做、暂停、继续、停止 |
| 做题 | 一键完成作业（全自动）、只做未完成的、只做错题、单题重做、只解题不提交（答案预览）、单题跳过、查看单题详情 |
| 监控 | 实时进度、查看待复核、验收通过、返工重做、提交历史/审计日志、失败重试、节律档位切换（慢/正常/快） |
| 管理 | 导出报告、清理缓存、导出日志、设置（重试次数、DS 模型）、复制任务配置为 JSON、只读模式开关 |

危险动作（删除账号、停止、真提交类）有二次确认；删账号与清缓存服务端还要求请求体显式 `confirm: true`，且运行中 409。

**动作三档（RESEARCH.md §5.7）**：必有的 6 个（完成作业/停止/重试失败题/
单题重试跳过/刷新进度/导出日志）全有；值得有的 7 个已补齐。**别做的 5 个是红线**：
批量删/重跑、面板改密码、定时全量跑、面板改提示词、多账号一键全开。
删账号原先也在“别做”里，但用户 2026-11-16 03:17 明确要求面板要能点，已恢复进
注册表，代价是双重确认（面板二次确认 + 服务端显式 `confirm: true`）。

**待复核队列**（dsh-task-panel 验收/返工闭环的参考思路重写，见 PLAN.md §11.6）：
低置信 / 停表 / 自测失败的题进队列等人验收或返工，最多返工 5 次；返工重做成功后
自动验收。面板上有“查看待复核”列表与下拉框，选一道题点“验收通过”或“返工重做”。

## 任务队列（vardiya 机制移植）

`serve` 的任务走 `plugins/pta/cli/lib/job-queue.mjs`（vardiya v0.2.1，MIT，
移植到 Node ≥22 内置的 `node:sqlite`，零新增依赖）：五态状态机
（pending/active/completed/delayed/dead）、固定/指数 backoff + jitter、幂等键
唯一索引（同一幂等键重复提交返回同一任务，不建新任务；进程重启后去重仍有效）、
WAL + `UPDATE ... RETURNING` 原子认领、AdaptivePoller 维护循环、FIFO 信号量
（单-flight：同一时间只跑一个全链路任务）、心跳 + 优雅停机（SIGTERM/SIGINT 时
运行中的任务放回队列，不烧重试次数）。启动时扫尾：上次崩溃留下的 active 任务
回 pending，从未开始的 pending 任务记 dead，state.json 里卡在 running 的任务
记录置 failed。单元测试见 `test/job-queue-test.mjs`（26 项）。

## 保守兜底策略（PTA 自身反作弊阈值无法从公开渠道验证）

RESEARCH.md §13.5，7 条默认策略（PLAN.md §11.7 有全文）：

1. **代码差异化优先于打字节律**：`vary.mjs` 默认开启；多账号同一题代码必须语义不变
   变换 + 重跑样例验证；禁止多账号提交逐字相同的代码。
2. **节律保守档默认**：pace 默认 slow/normal，不开 fast（fast 只用于 mock 测试）。
3. **00:00–06:00 不批量跑**（只警告 + 记审计，不硬拦）。
4. **单账号单 IP 原则**：默认一次只跑一个账号；多账号错峰 + 轮换；面板不提供一键全开。
5. **频率上限**：同一题集单日全量跑 ≤2 次（只警告 + 记审计）；失败题单题重试 1 次；登录限频 20 秒。
6. **客观题低置信不自动交**：阈值 0.75 初值 + 3/4 一致才自动提交，否则进待复核队列。
7. **审计 + 边界**：每账号 JSONL 日志记全部提交（时间、题、结果、代码 hash）；
   只做平时练习/作业题集，不碰正式考试/OMS 场次；一旦平台出现明确反作弊提示或
   警告，立即停跑、人工处理。

## CLI 用法（面板和 CLI 共用同一套后端）

```bash
node plugins/pta/cli/pta.mjs doctor
node plugins/pta/cli/pta.mjs login --user <邮箱或手机号> --label <名字> [--remember]  # 交互输密码
node plugins/pta/cli/pta.mjs problem-sets
node plugins/pta/cli/pta.mjs status --psid <id> --exam-id <E>
node plugins/pta/cli/pta.mjs run --problem-set <id> --pace normal --yes
# run 模式：--mode all（全部未通过）| todo（只做未答过的）| wrong（只做错题）| one（单题重做，需 --only-problem <id>）
node plugins/pta/cli/pta.mjs dashboard
```

## 答案生成（DeepSeek）

答案由 DS 自己生成（用户定）。配置：

```bash
export DEEPSEEK_API_KEY='...'   # 必须配，绝不写进文件、绝不进仓库
export DEEPSEEK_MODEL='deepseek-chat'  # 可选，默认 deepseek-chat
export DEEPSEEK_MAX_TOKENS=200000     # 可选，token 硬上限，超了就停
```

客观题：3 次采样（temperature 0.7）+ 1 次选项重排，多数投票，一致率当置信度代理。
**阈值 0.75 只是初值、无文献依据**（4 票制下的工程取整：2/4 平票无法决策、3/4 是最小
有效多数、4/4 过严）；必须在目标题库 + DeepSeek 上用 100–400 道题校准，自动提交桶
准确率目标 ≥90%，否则升阈值到 4/4 或采样数提到 5 次。低于阈值不提交、进人工复核。

编程题：生成代码后本地编译/跑题目样例，失败把“最后 30 行报错 + 最多 3 个失败用例
（输入/期望/实际/报错四段，各截 200 字符）”喂回模型，先解释错在哪再改；停表规则：
轮数上限（`--max-fixes`，默认 3，最多 5）、连续 2 轮报错完全相同、连续 2 轮通过样例数
零增长，三者任一即停，标 `blocked` 不提交。本地自测支持 GCC / GXX / PYTHON3
（本机有 gcc、python3；JAVAC 需本机有 JDK，无 JDK 时走服务端自定义测试先验，
见下）。无样例的题只做编译检查（`verified=false`，审计里标明）。

本地无编译器时（例如 JAVAC、无 JDK）：先把第一条样例经 `customTestData` 发服务端判，
输出对上了再真交；对不上不交。服务端判题语义在 mock 里无法覆盖，首次真号实测再核。

## 拟人化节律

读题按中文 **300 字/分**基准（已验证的保守基准，见 RESEARCH.md §12.5）× 难度系数
（编程 1.5–2.5、客观 1.0）× 对数正态抖动，客观下限 20 秒上限 3 分钟、编程下限 3 分钟
上限 10 分钟，另加 1–2 次回读停顿（2–5 秒）；粘贴改分段打字（击键间隔对数正态采样，
截断 28–400ms，约 4% 概率附加 400–1400ms 分心停顿，总长封顶 10 分钟）；提交前停顿
对数正态采样（中位 6 秒，截断 3–10 秒）；题间间隔指数分布（均值 20 秒）叠加在 15 秒
硬下限之上。全部是真实 sleep。档位：`--pace slow|normal|fast`（fast 只用于测试，
仍是真 sleep）。面板上换档后，运行中的任务下一次等待即用新档位。

选择题答案可以一样（不做变换）；代码答案按账号种子做语义不变变换（局部变量改名、空行抖动、注释策略），变换后重新跑样例验证通过才交，失败回退原代码。

**同 IP 多账号是最高关联信号**：账号隔离铁律（1 账号 1 profile、账号间错峰），
面板不提供多账号一键全开；同一 IP 多账号本身就是风险点，技术上不做规避承诺。
重心微调：**代码差异化优先于打字节律**（API 路线根本不产生击键事件）。

## 布局

```
plugins/pta/
  cli/pta.mjs              # CLI 本体
  cli/lib/pta-client.mjs   # API 客户端（登录/读题/提交/状态/判题轮询）
  cli/lib/store.mjs        # 账号表 + 每账号目录 + 会话/状态/审计/设置
  cli/lib/actions.mjs      # 共享后端：登录/登出/会话复用/自动重登（CLI 与面板共用）
  cli/lib/action-registry.mjs  # 面板动作注册表（34 个动作，5 组）
  cli/lib/run.mjs          # 全链路编排（DS 解题 → 自测 → 节律 → 提交 → 判题）
  cli/lib/job-queue.mjs    # 任务队列（vardiya 机制移植到 node:sqlite，MIT）
  cli/lib/solve.mjs        # DeepSeek 解题 + 本地样例自测
  cli/lib/pace.mjs         # 拟人化节律
  cli/lib/vary.mjs         # 代码差异化
  cli/lib/credentials.mjs  # 凭据引用（密码永不落盘）
  cli/lib/captcha.mjs      # 腾讯防水墙滑块求解器（Node + Python 定位）
  cli/lib/serve.mjs        # 面板服务（操作接口 + 实时看板 + SSE）
  cli/lib/dashboard.mjs    # 看板数据 + 渲染 + 报告导出
  skills/pta-cli/SKILL.md  # DSH 原生 skill
  browser-fallback/        # 浏览器兜底（HZ-Abox Fiber 链，MIT；不接执行路径）
test/
  mock-pta.mjs             # 本地 mock PTA 服务（只用于测试）
  run-mock-test.mjs        # mock 全链路测试
  job-queue-test.mjs       # 队列单元测试（26 项，由 run-mock-test.mjs 第 16 节调起）
  custom-test-data-check.mjs  # customTestData 管道检查
```

## 红线

- 只做平时练习 / 作业题集，**不碰正式考试**（OMS 监考）。题集 type 为 EXAM / FORMAL / OMS 或带监考标记时直接拒绝并记日志。
- 提交前必须确认；`submit` 默认只预览，加 `--yes` 才真交；面板上真提交类按钮有二次确认。
- 编程题必须先本地自测通过才交；自测 3 次改不好就不交，记失败继续下一题。
- **交卷自研状态**：`PUT /api/exams/{exam_id}/end` 全网无人实现，只能先在 mock/练习 exam 上实测；交卷不可逆，只在 `--finish` 且真交模式下做，默认不交卷；交卷前客观题无法自查（standard-answers 交卷前返回空），门控只能是“客观题答案已全部提交 + 编程题已判题通过”；禁止盲重试（重试前先 GET exam 状态确认是否已结束）；不要在 endAt 前最后一分钟交卷；响应码 + 响应体 + 交卷后状态查询三者都记入审计日志。7 条小心事项见 `PLAN.md` §11.4。
- 凭据不进仓库：密码、cookie、ticket 绝不写进仓库、PLAN、日志或 skill 文件；`~/.pta/`、`session.json` 一律 gitignore。
- 接口来自第三方逆向笔记（`kisakiayano/PTA-mcp` 的 PLATFORM_NOTES.md），未经真号实测；代码里标 `TODO(verify)` 的调用，实测一轮后再消标记。

## 依赖

- Node ≥ 22。
- 滑块求解器依赖 Python 3 + Pillow + numpy（只用于登录这种低频操作；本机 Python requests 走出口代理到验证码域名会超时，所以 HTTP 全走 Node fetch，只把图像计算交给 Python）。
- 本地自测：gcc（C/C++）、python3。

## 路线

- v0.1：CLI 骨架 + 设计文档。
- v0.2：答案生成 + 提交引擎 + 拟人节律 + 代码差异化 + 全链路 run + 实时看板 + 面板驱动 + 动作注册表（mock 全链路已测通，见 `PLAN.md` §11）。
- v0.3：DSH 插件化（index.js + 工作区自动同步 skill + 账号快照注入，照 educoder 的模式）；看板进 DSH 面板。
