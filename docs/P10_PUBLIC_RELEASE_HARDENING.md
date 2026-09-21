# P10 — Public Release Hardening（v1.0.1 开发计划）

> 阶段目标：把 v1.0.0「功能完整的开发成果」提升为**稳定、规范、可在线体验、可持续维护**的正式开源项目。
> 原则：不重写、不新增高风险语言特性、不破坏现有功能；先审计 → 计划 → 实施 → 测试 → 修复 → 再审计 → 发布 v1.0.1。

## 1. 当前仓库审计结果（2026-09-22，以实际代码为准）

| 项目 | 现状 | 结论 |
| --- | --- | --- |
| 版本 / tag | `package.json` 1.0.0；tag `v1.0.0` 指向 `a62870d`（= main HEAD） | ✅ tag 之后无游离提交 |
| 测试 | 13 个测试文件、**237 个测试全部通过**（vitest run） | ✅ |
| lint / typecheck / build | 全部通过（ESLint flat + tsc strict + Vite 8） | ✅ |
| LICENSE | **不存在**，但 README 声明 MIT | ❌ 需补标准 MIT 文件 |
| GitHub Actions | **不存在**（无 `.github/` 目录） | ❌ 需建 CI |
| GitHub Pages | 未配置；**无 vite.config.ts**（base 默认 `/`） | ❌ 需建部署流水线 + base 配置 |
| 远程仓库 | `origin = github.com/yangxijia111/C-Visualizer`，gh CLI 已登录（repo+workflow 权限） | ✅ 可推送可发布 |
| README | 结构偏"开发文档"，缺在线 Demo、截图、项目结构、已知限制、贡献方式 | ⚠️ 需 Public Release 化 |
| 示例库 | 21 个示例，与 `tests/examples.test.ts` 一致 | ✅ |
| 播放速度表述 | UI 与文档均为「0.5/1/2/4/8 步/秒」，无 "0.25x/1x" 旧表述残留 | ✅ 保持现状即可 |
| 敏感信息扫描 | 未发现 API key/token/绝对路径/用户名目录等 | ✅（详见 §4） |
| npm audit | `found 0 vulnerabilities` | ✅ |
| 构建体积 | JS ≈ 953 KB（含 React/CodeMirror/tree-sitter JS）、CSS ≈ 5.9 KB、wasm 626 KB + 210 KB | ⚠️ 记录即可，不做体积重构 |

## 2. 本轮目标

1. **合规**：补 LICENSE（标准 MIT），使 README / package metadata / 仓库 LICENSE 三者一致。
2. **自动化**：GitHub Actions CI（push + PR 全量质量门禁）+ GitHub Pages 自动部署（`/C-Visualizer/` base）。
3. **修复已知 UI 缺陷**：ControlFlowPanel 历史事件重复、CodeEditor 重复 Effect、wasm 加载失败无 UI 提示。
4. **文档**：README Public Release 化；播放速度等表述与实现完全一致。
5. **质量**：回归测试补齐、可访问性基础检查、窄窗口基本可用、构建体积记录。
6. **发布**：v1.0.1 → tag → GitHub Release。

## 3. 已发现问题（本轮要修）

| # | 问题 | 位置 | 严重度 |
| --- | --- | --- | --- |
| P1 | ControlFlowPanel 用 `history.slice(0, -1)` 分离 past/now，隐含「当前 step 恰好 1 个 FlowEvent」假设：当前 step 有 0 个事件时误隐藏上一事件，有 ≥2 个事件时中间事件在 past/now **重复显示** | `src/ui/Panels.tsx` ControlFlowPanel | 高 |
| P2 | CodeEditor 两个 useEffect（`[currentLine, errorLines]` 与 `[value, currentLine, errorLines]`）内容完全相同，重复 dispatch | `src/ui/CodeEditor.tsx` | 低 |
| P3 | wasm 解析器加载失败仅 `console.error`，UI 仍显示「▶ 运行」，点击后行为未定义（compile 内部兜底为错误，但用户无「解析器不可用」的明确提示） | `src/App.tsx` | 中 |
| P4 | 无 LICENSE 文件（README 却声明 MIT），package.json 无 `license` 字段 | 仓库根 | 高（公开合规） |
| P5 | 无 CI / 无 Pages；`dist` 构建以 `/` 为 base，直接放 Pages 会白屏 | 仓库根 | 高 |
| P6 | `body { overflow: hidden }` + 固定双栏 grid：窄窗口下不可用 | `src/styles.css` | 中 |
| P7 | 控制流事件类型着色之外，当前/历史行仅靠透明度区分（信息冗余尚可，补充文字标注） | `src/ui/Panels.tsx` | 低 |

## 4. 安全与隐私审计（本轮执行记录）

- 全仓扫描（源码/docs/tests/scripts/配置）`API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE KEY|Bearer|sk-|\.env`：仅命中 `ctx.env.get(...)` 等误报，**无真实密钥**。
- 绝对路径 / 用户名目录 / 机器名 / 内网 IP：未发现。
- `npm audit`：0 vulnerabilities（本轮结束时再次复核并记录到最终报告）。
- 结论：无需轮换密钥、无需清理历史。**不声称绝对安全**，仅声明「未发现明显敏感信息」。

## 5. 修改计划（对应任务分解）

1. `docs/P10_PUBLIC_RELEASE_HARDENING.md`（本文）+ ROADMAP 增加 v1.0.1 阶段 + CHANGELOG 增加 1.0.1 条目。
2. 根目录添加标准 MIT LICENSE（Copyright (c) 2026 yangxijia111，首次公开年份），package.json 增加 `"license": "MIT"`。
3. `.github/workflows/ci.yml`：push(main) + 全部 PR 触发；Node 22/24 矩阵；`npm ci → lint → typecheck → test → build`；无 continue-on-error。
4. `vite.config.ts`：开发/本地构建保持 `/`；`--mode pages` 构建使用 `/C-Visualizer/`；`package.json` 增加 `build:pages`；`.github/workflows/deploy-pages.yml`（官方 Pages Actions 流程，main push 触发 + 手动触发）。
5. 修复 P1：past/now 改为「按 step 边界严格分离」并**提取纯函数** `splitFlowEvents` 以便直接单测；P2：合并为一个 effect；P3：wasm 失败 → 错误横幅 + 禁用运行按钮 + compile 兜底错误呈现。
6. 可访问性 + 响应式：控件可聚焦可见、错误为文字、窄窗口改为纵向堆叠（不追求移动端完美）。
7. README 重写（在线 Demo、截图区、项目结构、已知限制、贡献方式等）；截图视环境生成到 `docs/assets/`，无法生成则保留占位并如实标记。
8. 回归测试：`tests/release.test.ts`（FlowEvent 分离、播放边界纯逻辑、Pages base 构建产物、文档一致性、示例库完整性、核心导出稳定性）。
9. `package.json` → 1.0.1；CHANGELOG 收尾；`V1.0.1_FINAL_REPORT.md`。

## 6. 风险

| 风险 | 缓解 |
| --- | --- |
| Pages base 配置破坏本地 dev/preview | base 仅在 `--mode pages` 生效；dev 与普通 build/preview 行为不变（有测试断言两种构建产物路径） |
| CI 环境（Node 22）与本地（Node 24）差异 | 使用 Node 22 + 24 矩阵，两边都跑 |
| UI 修复引入回归 | 修复前先为 splitFlowEvents 写测试；修复后跑全量 237+ 测试 + 浏览器 smoke |
| GitHub Pages 需仓库设置开启 | 代码与 workflow 全部就绪；若 Settings 未启用 Pages，记录人工步骤（BLOCKED_BY_EXTERNAL_PERMISSION），不阻塞其他项 |
| tree-sitter wasm 在 Pages 子路径加载失败 | `?url` 导入的资源路径自动携带 base；部署后实际访问验证（无法验证则如实记录） |

## 7. 验收标准

- [ ] LICENSE 存在且为标准 MIT；README/package/仓库三者一致
- [ ] ci.yml 存在，push + PR 均触发，五步质量门禁，无 continue-on-error
- [ ] deploy-pages.yml 存在；`build:pages` 产物资源路径以 `/C-Visualizer/` 开头（有自动化测试）
- [ ] ControlFlowPanel：当前 step 含 0/1/N 个 FlowEvent 时 past 与 now 无重复、无丢失（有单测）
- [ ] CodeEditor 只有一个高亮 dispatch effect；行高亮/错误行行为不变
- [ ] wasm 加载失败时 UI 出现明确错误提示且禁用运行
- [ ] README 含：简介/特性/在线 Demo/截图区/快速开始/支持与不支持子集/架构/测试/构建/技术栈/项目结构/文档导航/已知限制/License/贡献
- [ ] npm audit 0 critical/high；敏感信息扫描通过
- [ ] `npm ci && npm run lint && npm run typecheck && npm test && npm run build` 全绿（测试数 before=237 → after=记录值）
- [ ] version=1.0.1；CHANGELOG 有 1.0.1；commit + push + tag `v1.0.1`；GitHub Release（权限允许时）

## 8. 测试计划

1. **单测新增**（`tests/release.test.ts` + 必要的独立文件）：
   - FlowEvent 分离：当前 step 0 / 1 / 多个事件 → past 不含当前 step 事件、now 恰为当前 step 事件、历史窗口不丢事件；
   - 播放控制边界：提取的纯函数（速度档合法性、步进 clamp、末尾自动停止条件）；
   - Pages base：执行 `vite build --mode pages` 到临时目录，断言 `index.html` 资源 URL 以 `/C-Visualizer/` 开头、wasm 资源存在；普通 build 断言仍为 `/`；
   - 文档一致性：README/CHANGELOG/ROADMAP 关键承诺（示例数、测试数口径、速度档、版本号）与 package.json 一致；
   - 示例库完整性：id 唯一、代码可编译、描述非空；
   - 核心导出稳定：`compile`/`runProgram`/`EXAMPLES`/面板组件存在性（防意外破坏公共 API）。
2. **回归**：全量既有 237 测试不退化。
3. **Smoke**：`npm run preview` + 浏览器自动化走查 if/switch/for/短路/递归/数组/指针/goto/错误代码/死循环保护 + 播放控制 + 各面板。
4. **Pages Smoke**：部署后访问线上 URL 验证（无法访问则如实记录）。

## 9. 发布计划

1. 分阶段 commit（docs → license → ci → fix → ui → readme → test → release），禁止 force push / rebase 公开历史。
2. 全部验收项通过后：`release: v1.0.1` commit → tag `v1.0.1` → push → `gh release create v1.0.1`（失败则记录原因，不回改代码）。
3. 更新 `docs/V1.0.1_FINAL_REPORT.md`（Version/Changes/CI/Testing/Deployment/Security/Bug Fixes/Repository Quality/Known Limitations/Future）。
