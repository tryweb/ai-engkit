#!/usr/bin/env bash
# bootstrap.sh — Deterministic enable-finalize-maintenance bootstrap
#
# Creates docs/knowledge/maintenance/ directory, README index, _template,
# and .opencode/skills/finalize-maintenance.md in the given project root.
#
# Usage: bootstrap.sh <project-root>
#
# Idempotent — never overwrites an existing file.
# Outputs a summary table matching the SKILL.md report format.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: bootstrap.sh <project-root>" >&2
  exit 1
fi

ROOT="$1"
if [[ ! -d "$ROOT" ]]; then
  echo "Error: not a directory: $ROOT" >&2
  exit 1
fi

ROOT="${ROOT%/}"

# Auto-provision project knowledge base if missing
if [[ ! -f "$ROOT/docs/knowledge/README.md" ]]; then
  ENABLE_SCRIPT="$HOME/.config/opencode/skills/enable-project-knowledge/bootstrap.sh"
  if [[ -x "$ENABLE_SCRIPT" ]]; then
    echo "Project knowledge base not found. Auto-invoking enable-project-knowledge..."
    "$ENABLE_SCRIPT" "$ROOT"
  else
    echo "Warning: enable-project-knowledge not installed at $ENABLE_SCRIPT"
    echo "The docs/knowledge/ scaffold will be incomplete."
  fi
fi

CREATED=()
SKIPPED=()

mk() {
  local dir="$1"
  if [[ -d "$dir" ]]; then
    SKIPPED+=("$dir/")
  else
    mkdir -p "$dir"
    CREATED+=("$dir/")
  fi
}

put() {
  local dest="$1"
  if [[ -f "$dest" ]]; then
    SKIPPED+=("$dest")
    return
  fi
  mkdir -p "$(dirname "$dest")"
  cat > "$dest"
  CREATED+=("$dest")
}

mk "$ROOT/docs/knowledge/maintenance"
mk "$ROOT/.opencode/skills"

put "$ROOT/docs/knowledge/maintenance/README.md" <<'README'
# 維護報告索引

| 檔案 | 主機 | 服務 | 日期 | 問題 |
|------|------|------|------|------|
README

put "$ROOT/docs/knowledge/maintenance/_template.md" <<'TEMPLATE'
# 維護報告：{{TITLE}}

> 維護日期：{{YYYY-MM-DD}}

## 基本資訊

| 欄位 | 值 |
|------|----|
| **主機** | {{host_ips}} |
| **服務類型** | {{service_type}} |
| **問題發現時間** | {{problem_found_time}} |
| **問題修復時間** | {{problem_fixed_time}} |
| **維護人員** | {{operator}} |

## 問題描述

```
{{problem_summary}}
```

## 根因分析

```
{{root_cause}}
```

## 修復步驟

{{fix_steps}}

## 修復驗證

```
{{validation_evidence}}
```

## 經驗教訓（保留至知識庫）

```
{{lessons}}
```

## 防止再發建議

{{prevention_todos}}

## 附錄

{{appendix}}
TEMPLATE

put "$ROOT/.opencode/skills/finalize-maintenance.md" <<'SKILL'
---
name: finalize-maintenance
description: 維護完成後標準作業：撰寫維護報告、提煉經驗至知識庫、提交至 GitLab。
---

# Finalize Maintenance

維護工作完成後自動化產出維護報告、提煉可重用經驗、更新索引並提交至 GitLab。

---

## Triggers

- "完成維護"
- "產出維護報告"
- "finalize maintenance"
- "維護完成"
- "整理報告與知識庫"
- "maintenance wrap-up"

---

## Inputs

Caller 必須提供以下所有欄位（可為結構化參數或純文字段落）：

| 欄位 | 必填 | 格式 | 說明 |
|------|------|------|------|
| `host_ips` | ✅ | `["ip1", "ip2", ...]` | 受影響主機 IP |
| `service_type` | ✅ | string | e.g. Proxmox VE, PostgreSQL, Docker Swarm, Alpine Linux |
| `maintenance_date` | ✅ | `YYYY-MM-DD` | 維護日期 |
| `problem_found_time` | ❌ | `YYYY-MM-DD HH:mm` | 問題發現時間 |
| `problem_fixed_time` | ❌ | `YYYY-MM-DD HH:mm` | 問題修復時間 |
| `operator` | ❌ | string | 維護人員名稱 |
| `problem_summary` | ✅ | string（1-3 句） | 問題現象與影響範圍 |
| `root_cause` | ✅ | string | 根本原因分析 |
| `fix_steps` | ✅ | array of strings | 可重現的修復步驟 |
| `validation_evidence` | ✅ | string | 驗證指令與輸出 |
| `lessons` | ✅ | string | 經驗教訓（將寫入知識庫） |
| `prevention_todos` | ❌ | array of strings | 防止再發建議 |
| `reusable` | ❌ | boolean | 是否同時建立 patterns 知識條目 |
| `reusable_title` | ❌* | string | patterns 條目標題（reusable=true 時必填） |
| `reusable_extract` | ❌* | string | pattern 內容（reusable=true 時必填） |
| `appendix` | ❌ | string | 附錄（指令輸出、相關連結等） |

---

## Workflow

### Step 1 — 檢查環境與範本

```bash
ls docs/knowledge/maintenance/_template.md 2>/dev/null
```

若 `_template.md` 不存在，使用下方預設範本（見 Appendix）。

讀取參考檔案：
- `docs/knowledge/maintenance/README.md` — 報告索引（將更新）
- `docs/knowledge/maintenance/_template.md` — 報告範本
- `docs/knowledge/patterns/_template.md` — pattern 範本（若 reusable=true）
- `docs/knowledge/patterns/README.md` — pattern 索引（若 reusable=true）

### Step 2 — 撰寫維護報告

1. 複製 `_template.md` 內容
2. 填入所有 Inputs 欄位
3. 檔案命名規則：`YYYY-MM-DD-{host-ip}-{service}-{short-desc}.md`
   - 範例：`2026-07-01-192-168-11-50-postgresql-connection-pool-exhaustion.md`
   - 多台主機：`YYYY-MM-DD-cluster-{cluster-name}-{service}.md`
4. 存放路徑：`docs/knowledge/maintenance/`

### Step 3 — 提煉經驗至知識庫

將「經驗教訓」與「防止再發建議」同步寫入對應知識庫：

| 主題 | 存放位置 |
|------|---------|
| 架構相關決策 | `docs/knowledge/architecture/` |
| 故障排除技巧 | `docs/knowledge/troubleshooting/` |
| 可重用的模式 | `docs/knowledge/patterns/` |
| 工具使用心得 | `docs/knowledge/tooling/` |

若 lessons 提及對應主題且尚無相關檔案，建立新的 kebab-case markdown 檔案。

### Step 4 — 更新索引

在 `docs/knowledge/maintenance/README.md` 的報告索引表格中**插入一行至正確位置**，維持**日期降冪排序（最新在前）**：

```markdown
| [`{filename}`](./{filename}) | `{host_ips}` | {service_type} | {YYYY-MM-DD} | {problem_summary 截短 40 字} |
```

插入規則：
- 依表格的「日期」欄位降冪插入（日期新 → 舊），非直接附加至末尾。
- 同日期條目依現有相對順序排列，或附加於同日期群組末尾。

若檔案尚無表格，依照下方格式建立：

```markdown
## 報告索引

| 檔案 | 主機 | 服務 | 日期 | 問題 |
|------|------|------|------|------|
```

若 `docs/knowledge/patterns/README.md` 存在且 reusable=true，一併更新。

### Step 5 — 提交至 GitLab

```bash
git add docs/knowledge/
git commit -m "docs: 維護報告 - {host_ips} {service_type} - {short_desc}"
git push
```

輸出 commit hash。

---

## 預設報告範本

若 `docs/knowledge/maintenance/_template.md` 不存在，使用以下範本：

```markdown
# 維護報告：{{TITLE}}

> 維護日期：{{YYYY-MM-DD}}

## 基本資訊

| 欄位 | 值 |
|------|----|
| **主機** | {{host_ips}} |
| **服務類型** | {{service_type}} |
| **問題發現時間** | {{problem_found_time}} |
| **問題修復時間** | {{problem_fixed_time}} |
| **維護人員** | {{operator}} |

## 問題描述

```
{{problem_summary}}
```

## 根因分析

```
{{root_cause}}
```

## 修復步驟

{{fix_steps}}

## 修復驗證

```
{{validation_evidence}}
```

## 經驗教訓（保留至知識庫）

```
{{lessons}}
```

## 防止再發建議

{{prevention_todos}}

## 附錄

{{appendix}}
```

---

## Must Do

- 產生報告前 ALWAYS 讀取範本檔案 — 範本定義當前格式
- 檔案命名 ALWAYS 使用 `YYYY-MM-DD-{host}-{service}-{short-desc}.md`
- 若 lessons 提及特定主題，ALWAYS 同步寫入對應知識庫目錄
- ALWAYS 更新 `docs/knowledge/maintenance/README.md` 索引表格
- ALWAYS 依日期降冪（最新在前）插入新行至正確位置，非附加至末尾
- ALWAYS `git push`（此為團隊協作流程）
- 若 reusable=true，patterns 條目須經過驗證（Context/Problem/Solution/Why It Works/Evidence/Tags）

## Must Not Do

- NEVER 修改 `docs/knowledge/` 以外的檔案
- NEVER 覆蓋既有報告 — 同名檔案時附加計數器（`-2`, `-3`）
- NEVER 在 lessons 僅為 task-local 時建立知識庫條目
- NEVER 包含原始對話紀錄於報告中
- NEVER 跳過讀取範本檔案
- NEVER 直接將新行附加至表格末尾 — 須插入正確位置維持降冪排序

---

## Appendix: 搜尋技巧

```bash
# 搜尋特定主機
grep -r "192.168.11." docs/knowledge/maintenance/

# 搜尋特定服務
grep -r "postgresql\|alpine\|docker" docs/knowledge/maintenance/

# 搜尋特定關鍵字
grep -r "OOM\|kernel panic\|磁碟滿" docs/knowledge/maintenance/
```
SKILL

echo ""
echo "| Path | Action |"
echo "|------|--------|"
for p in "${CREATED[@]}"; do
  echo "| \`$p\` | **created** |"
done
for p in "${SKIPPED[@]}"; do
  echo "| \`$p\` | skipped (exists) |"
done
echo ""

if [[ ${#CREATED[@]} -eq 0 ]]; then
  echo "Maintenance workflow already enabled. Nothing changed."
fi
