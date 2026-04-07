# 變更日誌

本檔案記錄 OpenChamber 專案的所有重要變更。

格式基於 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.0.0/)，並且本專案遵循 [語義化版本](https://semver.org/lang/zh-TW/)。

## [未發布]

### 新增
- `docs/SECURITY.md` - 安全政策文件
- `docs/TROUBLESHOOTING.md` - 故障排除指南
- `docs/ARCHITECTURE.md` - 架構說明文件
- `docs/CONTRIBUTING.md` - 貢獻指南

### 變更
- 改善 README.md 文件結構

## [0.3.3] - 2026-04-02

### 新增
- 初始版本發布
- 基於 Ubuntu 24.04 的 Docker 開發環境
- 整合 OpenCode AI 程式碼助手 (v1.3.13)
- 整合 OpenChamber Web UI (v1.9.3)
- 整合 Ollama 本地 LLM 推論引擎
- 支援 LanceDB 向量搜尋插件
- 內建 GitHub CLI
- 完整的開發工具鏈（git, python, tmux, jq 等）
- 自動化 CI/CD 流程
- 漏洞掃描（Grype）
- 整合測試套件（39 個測試項目）

### 架構
- 雙容器設計（ai-dev + ollama）
- Docker named volumes 資料持久化
- 支援 bind mount 本地開發模式
- 健康檢查與自動重啟
- 動態套件安裝支援

---

## 版本格式說明

### 類型

- `新增` - 新功能
- `變更` - 現有功能的變更
- `棄用` - 即將移除的功能
- `移除` - 已移除的功能
- `修復` - Bug 修復
- `安全性` - 安全相關變更

### 範例

```markdown
## [1.1.0] - 2026-04-15

### 新增
- 新增 GPU 支援
- 新增多模型切換功能

### 變更
- 升級 Ollama 至最新版本

### 修復
- 修正容器重啟問題
- 修正權限錯誤
```

---

> 📖 本日誌格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.0.0/) 規範。
