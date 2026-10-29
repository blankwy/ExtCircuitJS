#!/usr/bin/env bash
# 把 wiki-src/ 推送到 GitHub Wiki。
#
# 用法：bash tools/push-wiki.sh
#
# 前置：GitHub 要求 wiki 仓库必须先有"第一篇页面"才会被创建（网页操作，无 API 绕过）。
#   1. 打开 https://github.com/blankwy/ExtCircuitJS/wiki
#   2. 点 "Create the first page"，标题随便填（如 Home），正文随便写一个字，保存
#   3. 回到这里运行本脚本，会覆盖成正式内容
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/wiki-src"
WIKI_URL="https://github.com/blankwy/ExtCircuitJS.wiki.git"
TMP="$(mktemp -d)"

[ -d "$SRC" ] || { echo "缺少 wiki-src/"; exit 1; }

echo "==> 克隆 wiki 仓库"
if ! git clone "$WIKI_URL" "$TMP" 2>/dev/null; then
  echo "!! wiki 仓库不存在。请先在网页创建第一篇页面："
  echo "   https://github.com/blankwy/ExtCircuitJS/wiki  → Create the first page"
  exit 1
fi

echo "==> 复制文档"
# 清掉旧的 .md（保留 .git）
find "$TMP" -maxdepth 1 -name '*.md' -delete
cp "$SRC"/*.md "$TMP"/

echo "==> 提交并推送"
cd "$TMP"
git add -A
if git diff --cached --quiet; then
  echo "无变化，跳过"
else
  # 提交身份用环境变量，不做字符串拼接
  GIT_AUTHOR_NAME="ExtCircuitJS" \
  GIT_AUTHOR_EMAIL="noreply@github.com" \
  GIT_COMMITTER_NAME="ExtCircuitJS" \
  GIT_COMMITTER_EMAIL="noreply@github.com" \
  git commit -m "docs: 更新 Wiki（使用/开发/插件开发/内置插件）"
  git push origin HEAD
fi
cd /
rm -rf "$TMP"

echo "==> 完成：https://github.com/blankwy/ExtCircuitJS/wiki"
