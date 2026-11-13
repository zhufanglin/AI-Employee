#!/usr/bin/env bash
# =============================================================================
# deploy-landing.sh —— 把下载落地页发布到更新站根目录
# =============================================================================
# 作用：将本目录 landing/index.html 安装为 /opt/fcmediaagent/updates/index.html，
#       然后用 curl 校验公网 https://updates.fcmediaagent.com/ 返回 200 且内容匹配。
# 说明：更新站是 nginx 静态站点（root=/opt/fcmediaagent/updates），静态文件
#       替换后不需要 reload nginx；脚本只动 index.html，不碰安装包和 latest.yml。
#
# 用法（在生产机执行，建议 root）：
#   sudo bash /opt/fcmediaagent/ops/deploy-landing.sh
#   sudo bash /opt/fcmediaagent/ops/deploy-landing.sh --dry-run
#
# 可选环境变量：
#   LANDING_TARGET_DIR  默认 /opt/fcmediaagent/updates
#   LANDING_PUBLIC_URL  默认 https://updates.fcmediaagent.com/
#   LANDING_KEEP_BACKUPS 默认 5（保留最近几个 index.html.bak-*）
#
# 回滚：
#   sudo cp -p /opt/fcmediaagent/updates/index.html.bak-<时间戳> \
#            /opt/fcmediaagent/updates/index.html
#   curl -fsS https://updates.fcmediaagent.com/ | head
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SCRIPT_DIR}/landing/index.html"
TARGET_DIR="${LANDING_TARGET_DIR:-/opt/fcmediaagent/updates}"
PUBLIC_URL="${LANDING_PUBLIC_URL:-https://updates.fcmediaagent.com/}"
KEEP_BACKUPS="${LANDING_KEEP_BACKUPS:-5}"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "[deploy-landing] 未知参数：$arg（支持 --dry-run / --help）" >&2
      exit 2
      ;;
  esac
done

log() { printf '[deploy-landing] %s\n' "$*"; }
die() { printf '[deploy-landing] 错误：%s\n' "$*" >&2; exit 1; }

[ -f "$SRC" ] || die "源文件不存在：$SRC"

if [ "$DRY_RUN" = "1" ]; then
  log "dry-run：不会写入任何文件"
  log "源文件        ：$SRC ($(wc -c < "$SRC" | tr -d ' ') bytes)"
  log "目标文件      ：$TARGET_DIR/index.html"
  log "校验地址      ：$PUBLIC_URL"
  [ -d "$TARGET_DIR" ] && log "目标目录      ：存在" || log "目标目录      ：不存在（真实执行会失败）"
  log "真实执行将：备份旧 index.html -> 原子替换 -> curl 校验 200 与内容 -> 失败自动回滚"
  exit 0
fi

[ -d "$TARGET_DIR" ] || die "目标目录不存在：$TARGET_DIR（确认更新站已部署）"
[ -w "$TARGET_DIR" ] || die "目标目录不可写：$TARGET_DIR（请用 root 或 sudo）"

TARGET="$TARGET_DIR/index.html"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="$TARGET_DIR/index.html.bak-$TS"
TMP="$TARGET_DIR/.index.html.tmp.$$"
TMP_BODY="$(mktemp)"
ROLLBACK_NEEDED=0

cleanup() {
  rm -f "$TMP" "$TMP_BODY" 2>/dev/null || true
}
trap cleanup EXIT

# 任何未预期失败（sha256sum/grep/磁盘满等）也自动回滚，避免把坏页面留在线上。
rollback_on_error() {
  local rc=$?
  if [ "$ROLLBACK_NEEDED" = "1" ]; then
    ROLLBACK_NEEDED=0
    if [ -f "$BACKUP" ]; then
      cp -p "$BACKUP" "$TARGET" 2>/dev/null || true
      log "未预期失败，已回滚到 $BACKUP"
    else
      rm -f "$TARGET" 2>/dev/null || true
      log "未预期失败，已删除新页面（原本无旧页面）"
    fi
  fi
  exit "$rc"
}
trap rollback_on_error ERR

if [ -f "$TARGET" ]; then
  cp -p "$TARGET" "$BACKUP"
  log "已备份旧页面：$BACKUP"
else
  log "目标位置暂无 index.html，跳过备份"
fi

install -m 0644 "$SRC" "$TMP"
mv -f "$TMP" "$TARGET"
ROLLBACK_NEEDED=1
log "已安装：$TARGET"

# 校验公网 200 且返回内容与源文件一致；加 cachebust 防止命中旧缓存。
CODE="$(curl -sS -o "$TMP_BODY" -w '%{http_code}' --max-time 25 \
  "${PUBLIC_URL%/}/?deploy_check=$TS" || true)"
if [ "$CODE" != "200" ]; then
  log "校验失败：HTTP $CODE（期望 200），开始回滚"
  if [ -f "$BACKUP" ]; then cp -p "$BACKUP" "$TARGET"; log "已回滚到 $BACKUP"; else rm -f "$TARGET"; log "已删除新页面（原本无旧页面）"; fi
  die "公网校验未通过，请检查 nginx 站点与 DNS"
fi

SRC_SHA="$(sha256sum "$SRC" | awk '{print $1}')"
BODY_SHA="$(sha256sum "$TMP_BODY" | awk '{print $1}')"
if [ "$SRC_SHA" != "$BODY_SHA" ]; then
  log "校验失败：公网返回内容与源文件不一致（可能被缓存/改写），开始回滚"
  cp -p "$BACKUP" "$TARGET" 2>/dev/null || rm -f "$TARGET"
  die "内容校验未通过（源 $SRC_SHA / 公网 $BODY_SHA）"
fi

grep -q '中科元晟 AI员工' "$TMP_BODY" || {
  log "校验失败：页面缺少产品名，开始回滚"
  cp -p "$BACKUP" "$TARGET" 2>/dev/null || rm -f "$TARGET"
  die "内容断言失败"
}

ROLLBACK_NEEDED=0
log "公网校验通过：HTTP 200，sha256=$SRC_SHA"
log "访问地址：$PUBLIC_URL"

# 只保留最近 N 个备份，避免长期堆积。
if [ -d "$TARGET_DIR" ]; then
  # shellcheck disable=SC2012
  ls -1t "$TARGET_DIR"/index.html.bak-* 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | while read -r old; do
    rm -f "$old"
  done || true
fi

log "完成。回滚命令：cp -p '$BACKUP' '$TARGET'"
