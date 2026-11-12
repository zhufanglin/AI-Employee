#!/usr/bin/env bash
# =============================================================================
# fcmediaagent 生产 MySQL 恢复脚本（P44 运维保障 / WP1）
#
# 用法：
#   restore-prod.sh <备份文件.sql.gz> [--to-db NAME] [--apply] [--dry-run] [--help]
#
#   默认（演练）：把备份导入临时库 fcm_restore_<时间戳>，打印每张表行数概览，
#                 结束后询问是否删除临时库；**不会碰生产库**。
#   --to-db NAME  指定演练用的库名（默认 fcm_restore_<YYYYmmddHHMMSS>）
#   --apply       覆盖生产库。必须先交互输入大写 YES，且导入前会自动做一次即时备份。
#   --dry-run     只打印将要执行的动作，不连接 docker、不写库
#
# 可用环境变量：
#   ENV_FILE        /opt/fcmediaagent/app/.env
#   BACKUP_DIR      /opt/fcmediaagent/backups/mysql
#   LOG_FILE        /opt/fcmediaagent/logs/backup.log
#   MYSQL_CONTAINER fcm-mysql
#   BACKUP_SCRIPT   /opt/fcmediaagent/ops/backup-prod.sh（--apply 前的即时备份）
#
# 退出码：0 成功（演练成功也算 0）；1 失败或用户取消；2 参数错误
#
# 安全：DATABASE_URL 里的密码只通过 MYSQL_PWD 传进容器；全程 gunzip -c 管道导入，
#       不落盘解压任何临时 .sql；日志不含密码。
# =============================================================================
set -euo pipefail

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
ENV_FILE="${ENV_FILE:-/opt/fcmediaagent/app/.env}"
BACKUP_DIR="${BACKUP_DIR:-/opt/fcmediaagent/backups/mysql}"
LOG_FILE="${LOG_FILE:-/opt/fcmediaagent/logs/backup.log}"
CONTAINER="${MYSQL_CONTAINER:-fcm-mysql}"
BACKUP_SCRIPT="${BACKUP_SCRIPT:-/opt/fcmediaagent/ops/backup-prod.sh}"
PROD_HINT="需要生产环境：本脚本要在生产机（Ubuntu + docker + fcm-mysql 容器）上执行"

DIED=0
APPLY=0
DRY_RUN=0
FILE=""
TO_DB=""
TARGET_DB=""
SRC_DB=""
MODE=""
PROD_DB=""
DB_USER=""
DB_PASS=""
DB_HOST=""
DB_PORT=""
INNER_PORT=""

usage() {
  cat <<'EOF'
用法: restore-prod.sh <备份文件.sql.gz> [--to-db NAME] [--apply] [--dry-run] [--help]

  默认        演练：导入临时库 fcm_restore_<YYYYmmddHHMMSS>，打印每张表行数，询问是否删除
  --to-db N   演练用的临时库名
  --apply     覆盖生产库（需输入大写 YES；导入前自动做一次即时备份）
  --dry-run   只打印计划，不做任何变更
  --help      显示本帮助

示例：
  # 1) 演练（推荐先做）
  ./restore-prod.sh /opt/fcmediaagent/backups/mysql/fcmediaagent-20261112-033000.sql.gz

  # 2) 灾难恢复（先停服务，再 --apply）
  systemctl stop fcmediaagent-api fcmediaagent-worker
  ./restore-prod.sh /opt/fcmediaagent/backups/mysql/fcmediaagent-20261112-033000.sql.gz --apply
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
    err "恢复异常中断：第 ${LINENO} 行命令失败（退出码 ${rc}）"
  fi
}

trap on_err ERR

human_size() {
  awk -v b="${1:-0}" 'BEGIN { split("B KB MB GB TB", u, " "); i = 1; while (b >= 1024 && i < 5) { b /= 1024; i++ } printf "%.1f%s", b, u[i] }'
}

# 解析 %XX 转义（DATABASE_URL 里的密码可能是编码过的）
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
  PROD_DB="${hostdb#*/}"
  hostport="${hostdb%%/*}"
  if [[ "$hostport" == *":"* ]]; then
    DB_HOST="${hostport%%:*}"
    DB_PORT="${hostport##*:}"
  else
    DB_HOST="$hostport"
    DB_PORT="3306"
  fi
  if [[ -z "$PROD_DB" || "$PROD_DB" == *"/"* ]]; then
    die "DATABASE_URL 里解析不到数据库名，请检查 $ENV_FILE"
  fi
  if [[ ! "$PROD_DB" =~ ^[A-Za-z0-9_.$-]+$ ]]; then
    die "DATABASE_URL 里的数据库名含有非法字符：$PROD_DB"
  fi
  if [[ ! "$DB_PORT" =~ ^[0-9]+$ ]]; then
    die "DATABASE_URL 里的端口不是数字：$DB_PORT"
  fi
  DB_USER="$(urldecode "${userinfo%%:*}")"
  DB_PASS="$(urldecode "${userinfo#*:}")"
  if [[ -z "$DB_USER" || -z "$DB_PASS" ]]; then
    die "DATABASE_URL 里的用户名或密码为空（本脚本不接受空密码）"
  fi
  INNER_PORT="${MYSQL_INNER_PORT:-$DB_PORT}"
}

# 从备份文件头部识别它属于哪个库（mysqldump --databases 会写 USE 行）
detect_dump_db() {
  local head line src
  head="$(set +o pipefail; gunzip -c "$1" 2>/dev/null | head -n 120)"
  src=""
  while IFS= read -r line; do
    if [[ "$line" == "USE "* ]]; then
      line="${line#USE }"
      line="${line%%;*}"
      src="$(printf '%s' "$line" | tr -d '`')"
      break
    fi
  done <<<"$head"
  printf '%s' "$src"
}

run_sql() {
  docker exec -e "MYSQL_PWD=$DB_PASS" "$CONTAINER" mysql \
    -h 127.0.0.1 -P "$INNER_PORT" -u "$DB_USER" \
    --default-character-set=utf8mb4 -N -B -e "$1"
}

# 容器内 root 凭据：应用账号 fcm 只有自己库的权限，建临时库/删临时库需要 root。
# root 密码从容器 env MYSQL_ROOT_PASSWORD 读，只在容器内 shell 里展开，不进 docker argv、不进日志。
have_root_creds() {
  docker exec "$CONTAINER" sh -c 'test -n "${MYSQL_ROOT_PASSWORD:-}"' >/dev/null 2>&1
}

run_sql_root() {
  docker exec -e "MYSQL_PWD=" "$CONTAINER" sh -c 'MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-}" exec mysql -h 127.0.0.1 -P "$1" -u root --default-character-set=utf8mb4 -N -B -e "$2"' sh "$INNER_PORT" "$1"
}

# 当前 SQL 执行身份：app=应用账号 / root=容器内 root（演练建库后自动切换）
SQL_AS_ROOT=0
run_sql_as() {
  if (( SQL_AS_ROOT == 1 )); then
    run_sql_root "$1"
  else
    run_sql "$1"
  fi
}

create_db() {
  local name="$1" sql
  sql="CREATE DATABASE IF NOT EXISTS $name DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  if run_sql "$sql" >/dev/null 2>&1; then
    return 0
  fi
  if have_root_creds && run_sql_root "$sql" >/dev/null 2>&1; then
    SQL_AS_ROOT=1
    log "提示：账号 $DB_USER 无建库权限，已切换为容器内 root 执行演练（仅影响临时库，生产库不受影响）"
    return 0
  fi
  die "创建数据库 $name 失败：账号 $DB_USER 无 CREATE 权限，容器内 root 凭据也不可用（可用 docker exec $CONTAINER mysql -uroot -p 手工建库并授权）"
}

resolve_mode() {
  local src="$1" tgt="$2"
  if [[ -z "$src" ]]; then
    printf 'target-arg'
    return 0
  fi
  if [[ "$src" == "$tgt" ]]; then
    printf 'direct'
    return 0
  fi
  printf 'rewrite'
}

# 导入：全程 gunzip -c 管道，不解压到磁盘
# mode: direct（备份里的 USE 与目标库同名）/ rewrite（改写为临时库）/ target-arg（无 USE，用位置参数指定库）
import_dump() {
  local file="$1" target="$2" mode="$3"
  local -a cmd
  if (( SQL_AS_ROOT == 1 )); then
    # root 分支：mysql 在容器内 sh 里启动，密码取自容器 env，不进 argv
    cmd=(docker exec -i -e "MYSQL_PWD=" "$CONTAINER" sh -c 'MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-}" exec mysql -h 127.0.0.1 -P "$1" -u root --default-character-set=utf8mb4' sh "$INNER_PORT")
  else
    cmd=(docker exec -i -e "MYSQL_PWD=$DB_PASS" "$CONTAINER" mysql
      -h 127.0.0.1 -P "$INNER_PORT" -u "$DB_USER" --default-character-set=utf8mb4)
  fi
  if [[ "$mode" == "target-arg" ]]; then
    if (( SQL_AS_ROOT == 1 )); then
      # root 分支无法把库名作为位置参数透传（会被 sh -c 吃掉），改为在流前面插一行 USE
      if ! gunzip -c "$file" | sed -e "1i USE \`$target\`;" | "${cmd[@]}"; then
        return 1
      fi
      return 0
    fi
    cmd+=("$target")
  fi
  if [[ "$mode" == "rewrite" ]]; then
    if ! gunzip -c "$file" | sed -e "s/^CREATE DATABASE .*/CREATE DATABASE IF NOT EXISTS $target;/" -e "s/^USE .*/USE $target;/" | "${cmd[@]}"; then
      return 1
    fi
  else
    if ! gunzip -c "$file" | "${cmd[@]}"; then
      return 1
    fi
  fi
  return 0
}

show_overview() {
  local target="$1" cnt list
  cnt="$(run_sql_as "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$target' AND table_type = 'BASE TABLE';" 2>/dev/null || true)"
  if [[ -z "$cnt" ]]; then
    log "警告：统计表数量失败（可能权限不足），跳过行数概览"
    return 0
  fi
  log "表数量：$cnt"
  list="$(run_sql_as "SET SESSION group_concat_max_len = 1048576; SELECT GROUP_CONCAT(CONCAT('SELECT ''', table_name, ''' AS tbl, COUNT(*) AS rows_cnt FROM ', CHAR(96), table_schema, CHAR(96), '.', CHAR(96), table_name, CHAR(96)) SEPARATOR ' UNION ALL ') FROM information_schema.tables WHERE table_schema = '$target' AND table_type = 'BASE TABLE';" 2>/dev/null || true)"
  if [[ -z "$list" || "$list" == "NULL" ]]; then
    log "（库里没有可统计的表）"
    return 0
  fi
  echo "---------------- 每张表行数（精确 COUNT(*)）----------------"
  if (( SQL_AS_ROOT == 1 )); then
    docker exec -e "MYSQL_PWD=" "$CONTAINER" sh -c 'MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-}" exec mysql -h 127.0.0.1 -P "$1" -u root --default-character-set=utf8mb4 -t -e "$2"' sh "$INNER_PORT" "$list" || log "警告：行数统计失败（表太多或权限不足），不影响导入结果"
  else
    docker exec -e "MYSQL_PWD=$DB_PASS" "$CONTAINER" mysql -h 127.0.0.1 -P "$INNER_PORT" -u "$DB_USER" --default-character-set=utf8mb4 -t -e "$list" || log "警告：行数统计失败（表太多或权限不足），不影响导入结果"
  fi
  echo "-----------------------------------------------------------"
}

ask_confirm() {
  local prompt="$1" ans=""
  if [[ -t 0 ]]; then
    printf '%s' "$prompt"
    IFS= read -r ans || ans=""
  elif { : < /dev/tty; } 2>/dev/null; then
    # -r /dev/tty 在无控制终端（ssh 非交互）下也返回真，必须真去打开一次才算能问
    printf '%s' "$prompt" >/dev/tty 2>/dev/null || true
    IFS= read -r ans </dev/tty 2>/dev/null || ans=""
  else
    printf '%s' "$prompt"
    IFS= read -r ans || ans=""
  fi
  case "$ans" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

ask_exact_yes() {
  local prompt="$1" ans=""
  if [[ -t 0 ]]; then
    printf '%s' "$prompt"
    IFS= read -r ans || ans=""
  elif { : < /dev/tty; } 2>/dev/null; then
    # -r /dev/tty 在无控制终端（ssh 非交互）下也返回真，必须真去打开一次才算能问
    printf '%s' "$prompt" >/dev/tty 2>/dev/null || true
    IFS= read -r ans </dev/tty 2>/dev/null || ans=""
  else
    printf '%s' "$prompt"
    IFS= read -r ans || ans=""
  fi
  if [[ "$ans" == "YES" ]]; then
    return 0
  fi
  return 1
}

do_immediate_backup() {
  if [[ ! -x "$BACKUP_SCRIPT" ]]; then
    die "找不到可执行的即时备份脚本 $BACKUP_SCRIPT（--apply 前必须先备份，已中止，生产库未被修改）"
  fi
  log "开始即时备份（覆盖生产库前的保护措施）..."
  if ! "$BACKUP_SCRIPT"; then
    die "即时备份失败，已中止恢复：生产库未被修改"
  fi
  log "即时备份完成（见 $BACKUP_DIR）"
}

# ------------------------------- 参数解析 -------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --to-db)
      shift
      if [[ $# -eq 0 ]]; then
        err "错误：--to-db 缺少库名"
        exit 2
      fi
      TO_DB="$1"
      ;;
    --apply) APPLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) err "未知参数：$1"; usage; exit 2 ;;
    *)
      if [[ -n "$FILE" ]]; then
        err "错误：只能指定一个备份文件（已有：$FILE，又收到：$1）"
        exit 2
      fi
      FILE="$1"
      ;;
  esac
  shift
done

if [[ -z "$FILE" ]]; then
  err "错误：缺少备份文件参数"
  usage
  exit 2
fi

if [[ -n "$TO_DB" ]]; then
  if [[ ! "$TO_DB" =~ ^[A-Za-z0-9_]+$ ]] || [[ ${#TO_DB} -gt 60 ]]; then
    err "错误：--to-db 只允许字母、数字、下划线，且不超过 60 个字符：$TO_DB"
    exit 2
  fi
fi

# ------------------------------- dry-run -------------------------------
if (( DRY_RUN )); then
  log "=== [dry-run] 仅打印计划：不调用 docker、不写任何库 ==="
  if [[ -f "$FILE" ]]; then
    log "[dry-run] 备份文件：$FILE（$(human_size "$(wc -c <"$FILE" | tr -d ' ')")）"
  else
    log "[dry-run] 注意：备份文件不存在：$FILE"
  fi
  if [[ -f "$ENV_FILE" ]]; then
    URL_PREVIEW="$(env_get DATABASE_URL || true)"
    if [[ -n "$URL_PREVIEW" ]]; then
      parse_database_url "$URL_PREVIEW"
      if (( APPLY )); then
        log "[dry-run] 模式：--apply 覆盖生产库 $PROD_DB（会先自动备份，并要求输入 YES）"
        log "[dry-run] 将执行：$BACKUP_SCRIPT"
        log "[dry-run] 将执行：gunzip -c $FILE | docker exec -i -e MYSQL_PWD=*** $CONTAINER mysql ...（导入 $PROD_DB）"
      else
        PREVIEW_DB="${TO_DB:-fcm_restore_<YYYYmmddHHMMSS>}"
        log "[dry-run] 模式：演练，目标库 $PREVIEW_DB（生产库 $PROD_DB 不受影响）"
        log "[dry-run] 将执行：CREATE DATABASE IF NOT EXISTS $PREVIEW_DB"
        log "[dry-run] 将执行：gunzip -c $FILE | sed 改写 USE/CREATE DATABASE 为 $PREVIEW_DB | docker exec -i -e MYSQL_PWD=*** $CONTAINER mysql"
        log "[dry-run] 将打印每张表 COUNT(*)，并询问是否 DROP DATABASE $PREVIEW_DB"
      fi
    else
      log "提示：$ENV_FILE 里没有 DATABASE_URL，$PROD_HINT"
    fi
  else
    log "提示：未找到 $ENV_FILE，$PROD_HINT"
  fi
  log "[dry-run] 结束：未做任何变更"
  exit 0
fi

# ------------------------------- 预检 -------------------------------
log "=== fcmediaagent MySQL 恢复开始（$SCRIPT_NAME）==="
if (( APPLY )); then
  log "模式：--apply 覆盖生产库（危险操作）"
else
  log "模式：演练（导入临时库，不碰生产库）"
fi

if [[ ! -e "$FILE" ]]; then
  die "备份文件不存在：$FILE"
fi
if [[ ! -f "$FILE" ]]; then
  die "不是普通文件：$FILE"
fi
if [[ ! -r "$FILE" ]]; then
  die "备份文件不可读：$FILE（检查权限）"
fi
if [[ ! -s "$FILE" ]]; then
  die "备份文件为空：$FILE"
fi
if ! gzip -t "$FILE" 2>/dev/null; then
  die "不是有效的 gzip 文件或已损坏：$FILE（可先用 gzip -t 复核）"
fi
FILE_SIZE="$(wc -c <"$FILE" | tr -d ' ')"
log "备份文件：$FILE（$(human_size "$FILE_SIZE")）"

if [[ ! -f "$ENV_FILE" ]]; then
  die "找不到环境文件 $ENV_FILE。$PROD_HINT"
fi
URL="$(env_get DATABASE_URL || true)"
if [[ -z "$URL" ]]; then
  die "在 $ENV_FILE 里没找到 DATABASE_URL"
fi
parse_database_url "$URL"
log "生产库：$PROD_DB 容器：$CONTAINER host=$DB_HOST port=$DB_PORT user=$DB_USER（密码已隐去）"

command -v docker >/dev/null 2>&1 || die "找不到 docker 命令。$PROD_HINT"
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  die "容器 $CONTAINER 不存在或 docker 不可用（先确认 docker ps 能看到它）"
fi
RUNNING="$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)"
if [[ "$RUNNING" != "true" ]]; then
  die "容器 $CONTAINER 未在运行（当前状态：$RUNNING），先 docker start $CONTAINER"
fi
if ! run_sql "SELECT 1;" >/dev/null; then
  die "用 .env 里的数据库账号连不上 MySQL（检查 DATABASE_URL 与 fcm-mysql 是否正常）"
fi

SRC_DB="$(detect_dump_db "$FILE")"
if [[ -n "$SRC_DB" ]]; then
  log "备份文件内的数据库：$SRC_DB"
  if [[ "$SRC_DB" != "$PROD_DB" ]]; then
    log "注意：备份文件的库名与生产库 $PROD_DB 不一致，导入时会改写为 $PROD_DB"
  fi
else
  log "提示：备份文件不带 CREATE DATABASE / USE 语句，将用位置参数指定目标库"
fi

if (( APPLY )); then
  TARGET_DB="$PROD_DB"
else
  if [[ -n "$TO_DB" ]]; then
    TARGET_DB="$TO_DB"
  else
    TARGET_DB="fcm_restore_$(date '+%Y%m%d%H%M%S')"
  fi
  if [[ "$TARGET_DB" == "$PROD_DB" ]]; then
    die "演练模式不允许写入生产库 $PROD_DB；确实要覆盖生产库请加 --apply"
  fi
fi
MODE="$(resolve_mode "$SRC_DB" "$TARGET_DB")"

# ------------------------------- 演练 -------------------------------
if (( APPLY == 0 )); then
  log "演练目标库：$TARGET_DB（生产库 $PROD_DB 不会被修改）"
  create_db "$TARGET_DB"
  log "开始导入（gunzip -c 管道，全程不落盘解压；大库可能要几分钟）..."
  if ! import_dump "$FILE" "$TARGET_DB" "$MODE"; then
    # 应用账号可能对新库没有写权限：有容器内 root 凭据就切过去重试一次
    if (( SQL_AS_ROOT == 0 )) && have_root_creds; then
      SQL_AS_ROOT=1
      log "提示：账号 $DB_USER 导入失败，改用容器内 root 重试（只写临时库 $TARGET_DB）"
      if ! import_dump "$FILE" "$TARGET_DB" "$MODE"; then
        die "演练导入失败：备份可能损坏、磁盘已满或 root 也无权限（df -h 确认）。临时库 $TARGET_DB 已保留以便排查"
      fi
    else
      die "演练导入失败：备份可能损坏、账号权限不足或磁盘已满（df -h 确认）。临时库 $TARGET_DB 已保留以便排查"
    fi
  fi
  show_overview "$TARGET_DB"
  if ask_confirm "是否删除临时库 $TARGET_DB？[y/N] "; then
    if run_sql_as "DROP DATABASE IF EXISTS $TARGET_DB;" >/dev/null; then
      log "已删除临时库 $TARGET_DB"
    else
      log "警告：删除临时库失败，请手工执行：docker exec -e MYSQL_PWD= $CONTAINER sh -c 'MYSQL_PWD=\"\$MYSQL_ROOT_PASSWORD\" mysql -uroot -e \"DROP DATABASE IF EXISTS $TARGET_DB;\"'"
    fi
  else
    log "已保留临时库 $TARGET_DB（排查用）"
    log "清理命令：docker exec -e MYSQL_PWD= $CONTAINER sh -c 'MYSQL_PWD=\"\$MYSQL_ROOT_PASSWORD\" mysql -uroot -e \"DROP DATABASE IF EXISTS $TARGET_DB;\"'"
  fi
  log "=== 演练完成：备份可正常导入，生产库未被修改 ==="
  exit 0
fi

# ------------------------------- --apply 覆盖生产库 -------------------------------
log "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
log "危险操作：--apply 会用上面的备份文件覆盖生产库 $PROD_DB"
log "（表会被 DROP 后重建；导入期间 api/worker 的读写会短暂失败）"
log "强烈建议先执行：systemctl stop fcmediaagent-api fcmediaagent-worker"
log "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
if ! ask_exact_yes "确认覆盖生产库 $PROD_DB？请输入大写 YES 继续（其他任意输入放弃）："; then
  err "已取消：输入不是 YES，未做任何变更"
  exit 1
fi

do_immediate_backup

log "开始导入到生产库 $PROD_DB（模式：$MODE；gunzip -c 管道）..."
if ! import_dump "$FILE" "$TARGET_DB" "$MODE"; then
  die "导入生产库失败：备份可能损坏、权限不足或磁盘已满（df -h 确认）。生产库可能处于半恢复状态，请立即用刚生成的即时备份重跑 --apply 兜底"
fi
show_overview "$TARGET_DB"
log "恢复完成。后续步骤："
log "  1) systemctl start fcmediaagent-api fcmediaagent-worker"
log "  2) curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health（应为 200）"
log "  3) 抽查业务数据（作品、员工、任务表行数）是否正常"
log "=== 生产库恢复完成：$PROD_DB ==="
exit 0
