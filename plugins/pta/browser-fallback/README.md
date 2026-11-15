# 浏览器兜底路线（browser-fallback）

**本目录不接任何执行路径。** 主路线是 API（`cli/lib/pta-client.mjs`）；
只有当 API 路线被 PTA 改版堵死、且用户明确批准时，才按这里的文档手工走
浏览器兜底。

## 来源

- 仓库：HZ-Abox/pta-auto-submit（MIT，Copyright (c) 2026 HZ-Abox），
  2026-11-16 从 GitHub 克隆的快照。
- `inject_code.js`：Fiber 反查链——从 `.cm-content` 节点反查 React Fiber，
  拿到 CodeMirror 6 的 EditorView 实例，用 `view.dispatch()` 一次性写入全文。
- `references/codemirror.md` / `selectors.md` / `submit-flow.md`：配套文档。
- 许可证全文见 `LICENSE-HZ-Abox-MIT.txt`（原仓库 LICENSE 的复制件）。

## 未验证项（用前必读）

- 选择器层是 2026-07 的快照：带 hash 的类名（如 `.cm-content` 旁的
  动态 class）当前 pintia.cn 答题页是否仍用同一批，**未验证**。
  用前必须对当前答题页实测，失效的选择器要重采。
- LImingcheng07 的 `setCode()` 与这条 Fiber 链逐行同构，两者互相印证
  2026-05~07 的前端上是通的；但这不能证明 2026-11 的前端仍通。
- HZ 的 modal 轮询 180s、测试 tab 读取、sessionStorage 断点续做是
  浏览器路线才用的机制；API 路线用 `state.json` 持久化等价实现，
  不要两边混用。
- 击键时序防御（Condrey arXiv:2601.17280）只在浏览器兜底路线里有意义；
  API 路线根本不产生击键事件。重心微调：**代码差异化优先于打字节律**。
