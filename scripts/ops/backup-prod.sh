#!/usr/bin/env bash
# =============================================================================
# fcmediaagent 生产 MySQL 备份脚本（P44 运维保障 / WP1）
#
# 用法：
#   backup-prod.sh [--dry-run] [--oss] [--help]
#
#   无参数      执行一次完整备份 -> 本地 .sql.gz + .sha256，并清理过期备份
#   --dry-run   只打印将要执行的命令，不调用 docker、不写任何文件
#   --oss       备份成功后调用 oss-upload.mjs 上传异地（失败只告警，不影响本地备份）
#
# 可用环境变量（默认值即生产值，systemd unit 里可按需覆盖）：
#   ENV_FILE             /opt/fcmediaagent/app/.env
#   BACKUP_DIR           /opt/fcmediaagent/backups/mysql
#   LOG_FILE             /opt/fcmediaagent/logs/backup.log
#   MYSQL_CONTAINER      fcm-mysql
#   MYSQL_INNER_PORT     容器内 mysqldump 连接的端口（默认取 DATABASE_URL 的端口）
#   RETENTION_DAYS       14
#   OSS_UPLOAD           0|1（等价 --oss）
#   NODE_BIN             /opt/node/bin/node
#   OSS_UPLOAD_SCRIPT    /opt/fcmediaagent/ops/oss-upload.mjs
#   MYSQLDUMP_EXTRA_ARGS 追加给 mysqldump 的参数（空格分隔，可选）
#
# 退出码：0 成功；1 预检/导出/校验/清理失败；2 参数错误
#
# 安全：DATABASE_URL 里的密码只通过 MYSQL_PWD 环境变量传进容器，日志、命令回显、
#       sha256 文件都不包含密码；密码也不会出现在本脚本写出的任何文件里。
# =============================================================================
set -euo pipefail

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
ENV_FILE="${ENV_FILE:-/opt/fcmediaagent/app/.env}"
BACKUP_DIR="${BACKUP_DIR:-/opt/fcmediaagent/backups/mysql}"
LOG_FILE="${LOG_FILE:-/opt/fcmediaagent/logs/backup.log}"
CONTAINER="${MYSQL_CONTAINER:-fcm-mysql}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
NODE_BIN="${NODE_BIN:-/opt/node/bin/node}"
OSS_UPLOAD_SCRIPT="${OSS_UPLOAD_SCRIPT:-/opt/fcmediaagent/ops/oss-upload.mjs}"
PROD_HINT="需要生产环境：本脚本要在生产机（Ubuntu + docker + fcm-mysql 容器）上执行"

DIED=0
DRY_RUN=0
UPLOAD_OSS="${OSS_UPLOAD:-0}"
DB_USER=""
DB_PASS=""
DB_HOST=""
DB_PORT=""
DB_NAME=""
OUT_FILE=""
PARTIAL=""
ERRLOG=""

usage() {
  cat <<'EOF'
用法: backup-prod.sh [--dry-run] [--oss] [--help]

  无参数     备份 MySQL 到 /opt/fcmediaagent/backups/mysql/fcmediaagent-<YYYYmmdd-HHMMSS>.sql.gz
             （同时生成 .sha256），并清理超过 RETENTION_DAYS 天的旧备份
  --dry-run  只打印将要执行的命令，不执行 docker、不写文件（本机也能跑）
  --oss      备份成功后调用 oss-upload.mjs 上传到 OSS（失败只告警，退出码仍为 0）
  --help     显示本帮助

常用环境变量：
  RETENTION_DAYS=14            保留天数
  BACKUP_DIR=/opt/fcmediaagent/backups/mysql
  MYSQL_CONTAINER=fcm-mysql
  OSS_UPLOAD=1                 等价 --oss
EOF
}

log() {
  local line
  line="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$line"
  if [[ -n "$LOG_FILE" ]]; then
    mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
    echo "$line" >>"$LOG_FILE" 2>/dev/null || true
  fi
}

err() {
  local line
  line="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$line" >&2
  if [[ -n "$LOG_FILE" ]]; then
    mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
    echo "$line" >>"$LOG_FILE" 2>/dev/null || true
  fi
}

die() {
  DIED=1
  err "错误：$*"
  exit 1
}

on_err() {
  local rc=$?
  if [[ "$DIED" -eq 0 && "$rc" -ne 0 ]]; then
    err "备份异常中断：第 ${LINENO} 行命令失败（退出码 ${rc}），本次备份判定为失败"
  fi
}

cleanup() {
  if [[ -n "$PARTIAL" && -f "$PARTIAL" ]]; then
    rm -f "$PARTIAL"
  fi
  if [[ -n "$ERRLOG" && -f "$ERRLOG" ]]; then
    rm -f "$ERRLOG"
  fi
  return 0
}

trap on_err ERR
trap cleanup EXIT

human_size() {
  awk -v b="${1:-0}" 'BEGIN { split("B KB MB GB TB", u, " "); i = 1; while (b >= 1024 && i < 5) { b /= 1024; i++ } printf "%.1f%s", b, u[i] }'
}

# 解析 %XX 转义（密码里可能出现），不依赖 sed 的反斜杠转义
urldecode() {
  local s value i n hex out
  s="${1//+/ }"
  out=""
  n=${#s}
  i=0
  while [[ "$i" -lt "$n" ]]; do
    if [[ "${s:$i:1}" == "%" && $((i + 2)) -lt "$n" ]]; then
      hex="${s:$((i + 1)):2}"
      if [[ "$hex" =~ ^[0-9A-Fa-f]{2}$ ]]; then
        value=$(printf "\x$hex")
        out="$out$value"
        i=$((i + 3))
        continue
      fi
    fi
    out="$out${s:$i:1}"
    i=$((i + 1))
  done
  printf '%s' "$out"
}

env_get() {
  local key="$1" line="" value=""
  if [[ ! -r "$ENV_FILE" ]]; then
    return 1
  fi
  line="$(grep -E "^(export[[:space:]]+)?$key[[:space:]]*=" "$ENV_FILE" | tail -n 1 | tr -d '\r')" || return 1
  if [[ -z "$line" ]]; then
    return 1
  fi
  value="${line#*=}"
  value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ "${#value}" -ge 2 && ( "$value" == '"'*'"' || "$value" == "'"*"'" ) ]]; then
    value="${value:1:$((${#value} - 2))}"
  fi
  printf '%s' "$value"
}

# 解析 DATABASE_URL：只取 user / pass / host / port / db
parse_database_url() {
  local url="$1" rest userinfo hostpart hostdb hostport
  if [[ "$url" != *"://"* ]]; then
    die "DATABASE_URL 格式不正确（缺少 ://），请检查 $ENV_FILE"
  fi
  rest="${url#*://}"
  if [[ "$rest" != *"@"* ]]; then
    die "DATABASE_URL 缺少 user:pass@ 段，请检查 $ENV_FILE"
  fi
  userinfo="${rest%%@*}"
  hostpart="${rest#*@}"
  if [[ "$userinfo" != *":"* ]]; then
    die "DATABASE_URL 缺少密码段（形如 mysql://user:pass@host:3306/db）"
  fi
  hostdb="${hostpart%%\?*}"
  if [[ "$hostdb" != *"/"* ]]; then
    die "DATABASE_URL 里没有数据库名（形如 mysql://user:pass@host:3306/db）"
  fi
  DB_NAME="${hostdb#*/}"
  hostport="${hostdb%%/*}"
  if [[ "$hostport" == *":"* ]]; then
    DB_HOST="${hostport%%:*}"
    DB_PORT="${hostport##*:}"
  else
    DB_HOST="$hostport"
    DB_PORT="3306"
  fi
  if [[ -z "$DB_NAME" || "$DB_NAME" == *"/"* ]]; then
    die "DATABASE_URL 里解析不到数据库名，请检查 $ENV_FILE"
  fi
  if [[ ! "$DB_NAME" =~ ^[A-Za-z0-9_.$-]+$ ]]; then
    die "DATABASE_URL 里的数据库名含有非法字符：$DB_NAME"
  fi
  if [[ ! "$DB_PORT" =~ ^[0-9]+$ ]]; then
    die "DATABASE_URL 里的端口不是数字：$DB_PORT"
  fi
  DB_USER="$(urldecode "${userinfo%%:*}")"
  DB_PASS="$(urldecode "${userinfo#*:}")"
  if [[ -z "$DB_USER" ]]; then
    die "DATABASE_URL 里的用户名为空"
  fi
  if [[ -z "$DB_PASS" ]]; then
    die "DATABASE_URL 里的密码为空（本脚本要求显式密码，不接受空密码）"
  fi
}

prune_old_backups() {
  local cutoff deleted f base
  cutoff=$((RETENTION_DAYS - 1))
  deleted=0
  while IFS= read -r -d '' f; do
    base="$(basename "$f")"
    rm -f "$f" "$f.sha256"
    deleted=$((deleted + 1))
    log "已删除过期备份：$base"
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'fcmediaagent-*.sql.gz' -mtime +"$cutoff" -print0 2>/dev/null || true)
  log "过期清理：删除 $deleted 个超过 ${RETENTION_DAYS} 天的备份（保留最近 $RETENTION_DAYS 天）"
}

# ------------------------------- 参数解析 -------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --oss) UPLOAD_OSS=1 ;;
    -h|--help) usage; exit 0 ;;
    *) err "未知参数：$1"; usage; exit 2 ;;
  esac
  shift
done

if [[ ! "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || [[ "$RETENTION_DAYS" -lt 1 ]]; then
  err "错误：RETENTION_DAYS 必须是不小于 1 的整数，当前值：$RETENTION_DAYS"
  exit 2
fi

# ------------------------------- dry-run -------------------------------
if (( DRY_RUN )); then
  TS_PREVIEW="$(date '+%Y%m%d-%H%M%S')"
  log "=== [dry-run] 仅打印计划：不调用 docker、不写任何文件 ==="
  if [[ -f "$ENV_FILE" ]]; then
    URL_PREVIEW="$(env_get DATABASE_URL || true)"
    if [[ -n "$URL_PREVIEW" ]]; then
      parse_database_url "$URL_PREVIEW"
      OUT_PREVIEW="$BACKUP_DIR/fcmediaagent-$TS_PREVIEW.sql.gz"
      log "[dry-run] 已读取 $ENV_FILE：user=$DB_USER host=$DB_HOST port=$DB_PORT db=$DB_NAME（密码已隐去）"
      log "[dry-run] 将执行：docker exec -e MYSQL_PWD=*** $CONTAINER mysqldump --single-transaction --quick --routines --events --databases $DB_NAME --default-character-set=utf8mb4 --no-tablespaces -h 127.0.0.1 -P ${MYSQL_INNER_PORT:-$DB_PORT} -u $DB_USER | gzip -9 > $OUT_PREVIEW"
      log "[dry-run] 将生成：$OUT_PREVIEW.sha256（sha256sum 校验文件）"
      log "[dry-run] 将清理：$BACKUP_DIR 下超过 $RETENTION_DAYS 天的 fcmediaagent-*.sql.gz 及对应 .sha256"
      if (( UPLOAD_OSS )); then
        log "[dry-run] 将执行：$NODE_BIN $OSS_UPLOAD_SCRIPT $OUT_PREVIEW"
      fi
    else
      log "提示：$ENV_FILE 里没有 DATABASE_URL，$PROD_HINT"
    fi
  else
    log "提示：未找到 $ENV_FILE，$PROD_HINT"
    log "提示：生产机上的实际动作 = docker exec fcm-mysql mysqldump ... | gzip -9 > $BACKUP_DIR/fcmediaagent-<YYYYmmdd-HHMMSS>.sql.gz"
  fi
  log "[dry-run] 结束：未做任何变更"
  exit 0
fi

# ------------------------------- 预检 -------------------------------
log "=== fcmediaagent MySQL 备份开始（$SCRIPT_NAME）==="
if [[ ! -f "$ENV_FILE" ]]; then
  die "找不到环境文件 $ENV_FILE。$PROD_HINT"
fi
if [[ ! -r "$ENV_FILE" ]]; then
  die "环境文件不可读：$ENV_FILE（检查运行用户权限）"
fi
URL="$(env_get DATABASE_URL || true)"
if [[ -z "$URL" ]]; then
  die "在 $ENV_FILE 里没找到 DATABASE_URL"
fi
parse_database_url "$URL"
log "目标：db=$DB_NAME 容器=$CONTAINER host=$DB_HOST port=$DB_PORT user=$DB_USER（密码已隐去）"

command -v docker >/dev/null 2>&1 || die "找不到 docker 命令。$PROD_HINT"
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  die "容器 $CONTAINER 不存在或 docker 不可用（先确认 docker ps 能看到它）"
fi
RUNNING="$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)"
if [[ "$RUNNING" != "true" ]]; then
  die "容器 $CONTAINER 未在运行（当前状态：$RUNNING），先 docker start $CONTAINER"
fi

mkdir -p "$BACKUP_DIR" || die "无法创建备份目录 $BACKUP_DIR"
if [[ ! -w "$BACKUP_DIR" ]]; then
  die "备份目录不可写：$BACKUP_DIR（检查属主与权限）"
fi
AVAIL_KB="$(df -Pk "$BACKUP_DIR" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
if [[ -n "$AVAIL_KB" && "$AVAIL_KB" =~ ^[0-9]+$ ]] && [[ "$AVAIL_KB" -lt 1048576 ]]; then
  log "警告：$BACKUP_DIR 所在分区可用空间不足 1GB（约 $((AVAIL_KB / 1024))MB），备份可能失败"
fi

# ------------------------------- 导出 -------------------------------
TS="$(date '+%Y%m%d-%H%M%S')"
OUT_FILE="$BACKUP_DIR/fcmediaagent-$TS.sql.gz"
PARTIAL="$OUT_FILE.partial"
ERRLOG="$(mktemp)"
INNER_PORT="${MYSQL_INNER_PORT:-$DB_PORT}"

DUMP_CMD=(docker exec -e "MYSQL_PWD=$DB_PASS" "$CONTAINER" mysqldump
  --single-transaction --quick --routines --events --databases "$DB_NAME"
  --default-character-set=utf8mb4 --no-tablespaces
  -h 127.0.0.1 -P "$INNER_PORT" -u "$DB_USER")
if [[ -n "${MYSQLDUMP_EXTRA_ARGS:-}" ]]; then
  read -r -a DUMP_EXTRA <<<"$MYSQLDUMP_EXTRA_ARGS"
  DUMP_CMD+=("${DUMP_EXTRA[@]}")
fi

SECONDS=0
log "开始导出：$DB_NAME -> $OUT_FILE"
if ! "${DUMP_CMD[@]}" 2>"$ERRLOG" | gzip -9 >"$PARTIAL"; then
  REASON="$(tail -n 5 "$ERRLOG" 2>/dev/null | paste -sd ' ' - || true)"
  rm -f "$PARTIAL"
  if grep -qi 'access denied' "$ERRLOG" 2>/dev/null; then
    die "mysqldump 被 MySQL 拒绝（Access denied）：数据账号权限不足。原始错误：$REASON"
  fi
  die "mysqldump 导出失败（可能原因：容器内连不上 MySQL、磁盘写满、账号权限不足）。原始错误：$REASON"
fi
if [[ ! -s "$PARTIAL" ]]; then
  die "导出的备份文件为空：$PARTIAL（mysqldump 未产生数据，检查库名与权限）"
fi
if ! gzip -t "$PARTIAL" 2>/dev/null; then
  die "gzip 完整性校验失败，备份文件已损坏：$PARTIAL"
fi
mv -f "$PARTIAL" "$OUT_FILE" || die "无法把备份文件移动到 $OUT_FILE"
PARTIAL=""

if ! ( cd "$BACKUP_DIR" && sha256sum "$(basename "$OUT_FILE")" >"$(basename "$OUT_FILE").sha256" ); then
  die "生成 sha256 校验文件失败：$OUT_FILE.sha256"
fi

SIZE_BYTES="$(wc -c <"$OUT_FILE" | tr -d ' ')"
SHA256_VALUE="$(awk '{print $1}' "$OUT_FILE.sha256")"
log "备份完成：$(basename "$OUT_FILE")  大小=$(human_size "$SIZE_BYTES")（${SIZE_BYTES}B）  耗时=${SECONDS}s"
log "sha256：$SHA256_VALUE"
log "校验命令：cd $BACKUP_DIR && sha256sum -c $(basename "$OUT_FILE").sha256"

# ------------------------------- 清理与上传 -------------------------------
prune_old_backups

if (( UPLOAD_OSS )); then
  if [[ ! -f "$OSS_UPLOAD_SCRIPT" ]]; then
    log "警告：找不到 $OSS_UPLOAD_SCRIPT，跳过 OSS 上传（本地备份成功）"
  elif [[ ! -x "$NODE_BIN" ]]; then
    log "警告：找不到可执行 node：$NODE_BIN，跳过 OSS 上传（本地备份成功）"
  elif "$NODE_BIN" "$OSS_UPLOAD_SCRIPT" "$OUT_FILE"; then
    log "OSS 上传完成（异地备份成功）"
  else
    OSS_RC=$?
    log "警告：OSS 上传失败（退出码 $OSS_RC），本地备份仍然有效，不影响本次备份结果"
  fi
fi

log "=== 备份成功：$(basename "$OUT_FILE") ==="
exit 0
