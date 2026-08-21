# Git Workbench v1 Release Checklist

Stable 发布前逐项提供实测证据；任何一项缺失即阻塞发布。

## 供给与打包
- [ ] `npm audit --audit-level=high` 无 High/Critical 漏洞（记录输出）。
- [ ] `npm sbom --sbom-format cyclonedx > dist/sbom.cdx.json` 生成并入库 SBOM。
- [ ] `npm run package && node scripts/check-vsix.mjs`：VSIX 内容白名单 PASS（记录文件列表与大小）。
- [ ] CI 中所有 GitHub Action 固定到完整 40 位 Commit SHA（合同测试已锁定）。

## 支持矩阵（nightly 工作流实测）
- [ ] macOS 15 arm64 / x64、Windows 2022 x64、Ubuntu 24.04 x64 全绿。
- [ ] 每平台 Node 24 + Git >= 2.35.3 + VS Code 1.96/Stable/Insiders 的 Electron 测试通过。
- [ ] Remote SSH / WSL / Dev Containers 场景手工冒烟记录（发现、状态、比较、一次完整提交闭环）。

## 安全证据
- [ ] Untrusted Workspace：恶意 `filter.evil.process` 从未被启动（Electron Trust 测试输出）。
- [ ] 诊断导出样本经 redactor 处理后不含凭据/路径（tests/security 输出）。
- [ ] 恢复检查点抽查：hard reset 后 recovery ref 可用；Recovery Center 列表正确。
- [ ] force-with-lease 拒绝远端并发前进的实测记录。

## 产品门槛
- [ ] 10 万 Commit nightly P95 < 1s（nightly 性能任务输出）。
- [ ] 中英文 NLS 完整（scripts/check-settings.mjs + check-localization.mjs）。
- [ ] 首版用户文档（README 涵盖：信任边界、恢复中心入口、已知限制）。

## 发布动作
- [ ] `release.yml` 从 tag 构建 VSIX 并附 SBOM 与本 checklist 的实测输出。
