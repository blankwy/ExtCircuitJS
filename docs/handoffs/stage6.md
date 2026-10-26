# Stage 6 handoff（2026-10-26）

- 做了什么：A04 GitHub Actions CI（cf772f9，双平台 Node 侧门禁，浏览器契约标注仅本地）；A03 core sync-drill（f5f7015，沙箱假上游判定 upstream-changed + 真 manifest 对照 both-changed）；A06 菜单插槽（63feb36，ExtMenus.ts + 浏览器断言全绿；卡面 Menus.ts 命名偏离已记录——同名会经 coverOverlay 影子掉 core）；REL v0.1.0（5f3f3e4，CHANGELOG + README 状态表；package.json 版本本就是 0.1.0）。
- 证据：全量门禁 16/16 退出 0——doctor / build / plugin lint / cover status / cover scan / core sync-drill / Node 契约 40 测试 / boot / menu / g2 / place / plugins-smoke / reload / netlist-export / netlist-roundtrip / mcp-bridge / mcp-tools（2026-10-26 Lead 亲跑，仅看退出码）。menu.browser 输出 ok:true（popup 游离节点 + Draw 文档内条目、点击后 mouseModeStr=ExtShuntElm、卸载归零）。
- 卡在哪：无。执行侧：GLM 免费额度耗尽后 D05 起全部 Lead 直做（用户批准），A06 调试 3 轮收敛（Menu 类未导出→自实现追加；/ExtMenus.ts 404→/@fs/ 装载；popup UL 游离 DOM→断言口径修正）。
- 下一步：交接文档见 [HANDOVER.md](HANDOVER.md)（给 DeepSeek harness / CodeBuddy 的完整交接）。用户三件事：push 看 CI 首绿、`git tag v0.1.0 && git push origin v0.1.0` + Release 页贴 CHANGELOG、spike/ 扫描发现处置。
- 消耗：本阶段 Lead（GLM-5.3，付费小额）约 150 万 token；A06 浏览器调试回路是主要开销。

## 给下一任执行者的要点（速记）

1. **A06 关键坑**：cover/ts 下新建与 core 同名文件会被 coverOverlay 影子覆盖（除非完整 re-export）；cover-only 文件在页面里用 `/@fs/<绝对路径>` 装载（根相对 URL 只解析 core 存在的文件）；右键弹出菜单的 UL 游离于 DOM 外，断言用元素级 querySelector。
2. **引擎确定性步进**：analyzeCircuit → preStampAndStampCircuit → runCircuit（冻结 Date.now），只调 preStampCircuit 会在 runCircuit NaN 检查崩。
3. **Mimosa commit 硬拦**：仓库外 spike/ 旧产物（33 高危/21 中危）会被算进任何 commit——本地提交被拦时勿 --no-verify，销账/豁免 spike/ 是根治（待用户裁决）。
