#!/usr/bin/env bash
#
# 安全与接口冒烟测试
#
#   npm run smoke            # 自动读取本机 .env
#   ./scripts/smoke.sh       # 同上
#
# 全部写操作都发生在一个临时 PostgreSQL schema 里（结束即 drop），
# 不会碰到 public.food_options 的正式数据。
#
# 连接凭据一律来自环境，脚本内不内置任何真实口令：
#   优先 SMOKE_PGHOST / SMOKE_PGPORT / SMOKE_PGDATABASE / SMOKE_PGUSER / SMOKE_PGPASSWORD
#   或直接给 DATABASE_URL（从中解析）
#   也可放在仓库根目录的 .env 里（已被 git 忽略），脚本会自动读取
# 其它可选项：SMOKE_PORT（默认 3399）、SMOKE_ADMIN_TOKEN（默认随机生成）
#
set -uo pipefail

cd "$(dirname "$0")/.."

# 自动加载本机 .env（不存在则跳过；不用 dotenv，避免为一个测试脚本引依赖）
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
fi

_smoke_split_url() { # postgresql://user:pass@host:port/db
    local url="$1"
    local authority="${url#*://}"
    local creds rest hostport pathpart

    if [[ "$authority" == *@* ]]; then
        # 以最后一个 @ 分界：口令里含 @ 时也能正确切分
        creds="${authority%@*}"
        rest="${authority##*@}"
        SMOKE_PGUSER="${creds%%:*}"
        SMOKE_PGPASSWORD="${creds#*:}"
    else
        SMOKE_PGUSER=""
        SMOKE_PGPASSWORD=""
        rest="$authority"
    fi

    hostport="${rest%%/*}"
    SMOKE_PGHOST="${hostport%%:*}"

    if [[ "$hostport" == *:* ]]; then
        SMOKE_PGPORT="${hostport##*:}"
    else
        SMOKE_PGPORT="5432"
    fi

    if [[ "$rest" == */* ]]; then
        pathpart="${rest#*/}"
        SMOKE_PGDATABASE="${pathpart%%\?*}"
    else
        SMOKE_PGDATABASE=""
    fi
}

if [ -z "${SMOKE_PGUSER:-}" ] || [ -z "${SMOKE_PGPASSWORD:-}" ]; then
    if [ -n "${DATABASE_URL:-}" ]; then
        _smoke_split_url "$DATABASE_URL"
    fi
fi

SMOKE_PGHOST="${SMOKE_PGHOST:-}"
SMOKE_PGPORT="${SMOKE_PGPORT:-5432}"
SMOKE_PGDATABASE="${SMOKE_PGDATABASE:-}"
SMOKE_PGUSER="${SMOKE_PGUSER:-}"
SMOKE_PGPASSWORD="${SMOKE_PGPASSWORD:-}"

if [ -z "$SMOKE_PGHOST" ] || [ -z "$SMOKE_PGDATABASE" ] || [ -z "$SMOKE_PGUSER" ] || [ -z "$SMOKE_PGPASSWORD" ]; then
    echo "缺少 PostgreSQL 连接信息。请在 .env 里提供 DATABASE_URL，或显式设置：" >&2
    echo "  SMOKE_PGHOST / SMOKE_PGPORT / SMOKE_PGDATABASE / SMOKE_PGUSER / SMOKE_PGPASSWORD" >&2
    echo "本脚本故意不内置任何默认口令，避免真实凭据进入仓库。" >&2
    exit 2
fi

PORT="${SMOKE_PORT:-3399}"
SCHEMA="smoke_$$"
# 测试用密钥随机生成，不落盘、不入库
TOKEN="${SMOKE_ADMIN_TOKEN:-smoke-$RANDOM$RANDOM$(date +%s)}"
WRONG="definitely-wrong-token"
ALLOWED_ORIGIN="http://allowed.test"
EVIL_ORIGIN="http://evil.test"
BASE="http://127.0.0.1:${PORT}"
DB_URL="postgresql://${SMOKE_PGUSER}:${SMOKE_PGPASSWORD}@${SMOKE_PGHOST}:${SMOKE_PGPORT}/${SMOKE_PGDATABASE}?options=-csearch_path%3D${SCHEMA}"
# 日志名自己按 PID 拼，不用 `mktemp -t 前缀`：那是 BSD/macOS 写法，
# GNU coreutils 会因「模板里没有 X」报错退出，导致 LOG 为空、
# 服务重定向失败 —— CI（Ubuntu）上真实踩过，别再改回去。
LOG="${TMPDIR:-/tmp}/huliaeat-smoke.$$"
# 期望条数取自种子文件本身：菜单增删后不必再来改测试断言
SEED_COUNT="$(node -pe 'const d = require("./data/options.json"); (Array.isArray(d) ? d : d.options).length')"
SRV_PID=""

export PGHOST="$SMOKE_PGHOST" PGPORT="$SMOKE_PGPORT" PGDATABASE="$SMOKE_PGDATABASE"
export PGUSER="$SMOKE_PGUSER" PGPASSWORD="$SMOKE_PGPASSWORD"

PASS_COUNT=0
FAIL_COUNT=0

cleanup() {
    if [ -n "$SRV_PID" ] && kill -0 "$SRV_PID" 2>/dev/null; then
        kill "$SRV_PID" 2>/dev/null
        wait "$SRV_PID" 2>/dev/null
    fi
    psql -q -c "drop schema if exists \"${SCHEMA}\" cascade;" >/dev/null 2>&1
    rm -f "$LOG"
}
trap cleanup EXIT INT TERM

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }

# GitHub Actions 的原始日志必须登录才能读，但 annotation 可以走公开 API 看到。
# 所以在 CI 里把失败细节同时写成 ::error::，本地终端则完全静默。
ci_error() {
    [ "${GITHUB_ACTIONS:-}" = "true" ] || return 0
    printf '::error::%s\n' "$(printf '%s' "$*" | tr '\n' ' ' | cut -c1-500)"
}

fail() {
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf '  \033[31m✗\033[0m %s — 期望 %s，实际 %s\n' "$1" "$2" "${3:-}"
    ci_error "断言失败: $1 | 期望 $2 | 实际 ${3:-}"
}
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

expect_code() { # desc expected actual
    if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi
}

expect_has() { # desc needle file-or-text-source
    if grep -qF "$2" "$3" 2>/dev/null; then pass "$1"; else fail "$1" "包含 '$2'" "$3"; fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
body() { curl -s "$@"; }
ctype() { curl -s -o /dev/null -w '%{content_type}' "$@"; }
count_of() { body "$@" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(Array.isArray(j)?j.length:(j.total??"-"))}catch(e){console.log("-")}})'; }
header_value() { # url header-name [extra curl args...]
    local url="$1" name="$2"; shift 2
    curl -s -D - -o /dev/null "$@" "$url" \
        | tr -d '\r' | tr 'A-Z' 'a-z' \
        | awk -v h="$(printf '%s' "$name" | tr 'A-Z' 'a-z' | sed 's/:*$//')" 'index($0, h":")==1 {sub(/^[^:]*: */, ""); print; exit}'
}

start_server() { # 启动被测服务（NODE_ENV=production + ADMIN_TOKEN）
    NODE_ENV=production \
    ADMIN_TOKEN="$TOKEN" \
    CORS_ALLOWED_ORIGINS="$ALLOWED_ORIGIN" \
    PORT="$PORT" \
    DATABASE_URL="$DB_URL" \
        node server.js >"$LOG" 2>&1 &
    SRV_PID=$!

    for _ in $(seq 1 60); do
        if curl -s -m 2 "${BASE}/api/health" | grep -q '"status":"ok"'; then
            return 0
        fi
        if ! kill -0 "$SRV_PID" 2>/dev/null; then
            echo "服务启动失败，日志：" >&2
            cat "$LOG" >&2
            ci_error "服务启动失败: $(cat "$LOG" | tr '\n' ' ')"
            return 1
        fi
        sleep 0.25
    done
    echo "服务启动超时" >&2
    ci_error "服务在 60 次探测内未就绪: $(cat "$LOG" | tr '\n' ' ')"
    return 1
}

echo "冒烟测试：临时 schema=${SCHEMA}，端口=${PORT}"

if ! psql -q -c "create schema \"${SCHEMA}\";" >/dev/null 2>&1; then
    echo "无法创建临时 schema，请确认 PostgreSQL 可用且 ${SMOKE_PGUSER} 有 CREATE 权限。" >&2
    # 把 psql 是否存在一并写进 annotation：CI 上「命令找不到」和「权限不够」症状相同，必须区分
    ci_error "无法创建临时 schema（psql=$(command -v psql || echo 未安装) host=${SMOKE_PGHOST} port=${SMOKE_PGPORT} db=${SMOKE_PGDATABASE} user=${SMOKE_PGUSER}）"
    exit 1
fi

start_server || exit 1

# ---------------------------------------------------------------- 读接口
section "读接口保持公开（无需密钥）"
expect_code "GET /api/health → 200" 200 "$(code "${BASE}/api/health")"
expect_code "GET /api/options → 200" 200 "$(code "${BASE}/api/options")"
expect_code "空 schema 自动灌入种子数据（${SEED_COUNT} 条）" "$SEED_COUNT" "$(count_of "${BASE}/api/options")"
expect_code "跨域 GET 对任意来源开放（读接口不敏感）" "${EVIL_ORIGIN}" "$(header_value "${BASE}/api/options" "access-control-allow-origin" -H "Origin: ${EVIL_ORIGIN}")"

# ---------------------------------------------------------------- 写接口鉴权
section "写接口必须携带管理密钥"
expect_code "POST 无密钥 → 401" 401 "$(code -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -d '{"name":"无密钥","emoji":"🍜"}')"
expect_code "POST 错密钥 → 401" 401 "$(code -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "x-admin-token: ${WRONG}" -d '{"name":"错密钥","emoji":"🍜"}')"
expect_code "DELETE 无密钥 → 401" 401 "$(code -X DELETE "${BASE}/api/options/1")"
expect_code "PATCH 无密钥 → 401" 401 "$(code -X PATCH "${BASE}/api/options/1" -H 'Content-Type: application/json' -d '{"emoji":"🍜"}')"
expect_code "PUT 无密钥 → 401" 401 "$(code -X PUT "${BASE}/api/options/1" -H 'Content-Type: application/json' -d '{"name":"x","emoji":"🍜"}')"
expect_code "import(replace) 无密钥 → 401，且数据未被清空" 401 "$(code -X POST "${BASE}/api/options/import" -H 'Content-Type: application/json' -d '{"mode":"replace","items":[{"name":"恶意","emoji":"🍜"}]}')"
expect_code "未授权后数据量不变（仍 ${SEED_COUNT} 条）" "$SEED_COUNT" "$(count_of "${BASE}/api/options")"
expect_code "POST /api/lists 无密钥 → 401" 401 "$(code -X POST "${BASE}/api/lists" -H 'Content-Type: application/json' -d '{"name":"未授权榜"}')"
expect_code "PATCH /api/lists 无密钥 → 401" 401 "$(code -X PATCH "${BASE}/api/lists/1" -H 'Content-Type: application/json' -d '{"name":"未授权改名"}')"
expect_code "DELETE /api/lists 无密钥 → 401" 401 "$(code -X DELETE "${BASE}/api/lists/1")"
expect_code "membership 无密钥 → 401" 401 "$(code -X POST "${BASE}/api/lists/1/membership" -H 'Content-Type: application/json' -d '{"mode":"replace","optionIds":[1]}')"
expect_code "Authorization: Bearer 也可通过" 201 "$(code -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "Authorization: Bearer ${TOKEN}" -d '{"name":"Bearer 测试","emoji":"🥟"}')"

# ---------------------------------------------------------------- CRUD 往返
section "带密钥的完整 CRUD 往返"
NEW_ID=$(body -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"name":"冒烟小火锅","emoji":"🍲"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')
expect_code "POST 返回新 id（${NEW_ID}）" "ok" "$([ -n "$NEW_ID" ] && echo ok || echo empty)"
expect_code "GET 单条 → 200" 200 "$(code "${BASE}/api/options/${NEW_ID}")"
expect_code "PUT 全量更新 → 200" 200 "$(code -X PUT "${BASE}/api/options/${NEW_ID}" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"name":"冒烟小火锅2","emoji":"🍲"}')"
expect_code "PATCH 部分更新 → 200" 200 "$(code -X PATCH "${BASE}/api/options/${NEW_ID}" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"emoji":"🌶️"}')"
expect_code "重名 POST → 409（店名唯一，与导入路径语义一致）" 409 "$(code -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"name":"冒烟小火锅2","emoji":"🍲"}')"
expect_code "DELETE → 204" 204 "$(code -X DELETE "${BASE}/api/options/${NEW_ID}" -H "x-admin-token: ${TOKEN}")"
expect_code "删除后 GET → 404" 404 "$(code "${BASE}/api/options/${NEW_ID}")"

# ---------------------------------------------------------------- 导入
section "批量导入（append / replace）"
expect_code "import append 带密钥 → 200" 200 "$(code -X POST "${BASE}/api/options/import" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"mode":"append","items":[{"name":"导入甲","emoji":"🍜"},{"name":"导入乙","emoji":"🍚"}]}')"
NO_EMOJI_RESULT=$(body -X POST "${BASE}/api/options/import" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"mode":"append","items":[{"name":"测试面馆无图标"}]}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s).options.find((x)=>x.name==="测试面馆无图标");console.log(o?o.emoji:"missing")})')
expect_code "导入缺 emoji 时按前后端共用规则自动匹配（面→🍜）" "🍜" "$NO_EMOJI_RESULT"
expect_code "import replace 带密钥 → 200" 200 "$(code -X POST "${BASE}/api/options/import" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"mode":"replace","items":[{"name":"替换后只剩这家","emoji":"🦆"}]}')"
expect_code "replace 后总数为 1" 1 "$(count_of "${BASE}/api/options")"
expect_code "非法 import mode → 400" 400 "$(code -X POST "${BASE}/api/options/import" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"mode":"typo","items":[{"name":"不应导入","emoji":"🍜"}]}')"
expect_code "非法 import mode 不会清空现有数据" 1 "$(count_of "${BASE}/api/options")"
expect_code "空 items → 400" 400 "$(code -X POST "${BASE}/api/options/import" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"mode":"append","items":[]}')"
BAD_JSON='{"name":'
expect_code "坏 JSON → 400（不再被误报为 500）" 400 "$(code -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d "$BAD_JSON")"
expect_code "未知接口 → JSON 404" 404 "$(code "${BASE}/api/nope")"

# ---------------------------------------------------------------- 多榜单
section "多榜单：一店可属多榜、删榜不删店"
pick_id() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.id ?? "")}catch(e){console.log("")}})'; }
json_len() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(Array.isArray(j)?j.length:(j.lists?j.lists.length:"n/a"))}catch(e){console.log("parse-error")}})'; }

LIST_A=$(body -X POST "${BASE}/api/lists" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"name":"榜A"}' | pick_id)
LIST_B=$(body -X POST "${BASE}/api/lists" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"name":"榜B"}' | pick_id)
expect_code "新建两个榜单拿到 id" "ok" "$([ -n "$LIST_A" ] && [ -n "$LIST_B" ] && echo ok || echo empty)"
expect_code "同名榜单冲突 → 409" 409 "$(code -X POST "${BASE}/api/lists" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"name":"榜A"}')"
expect_code "新建榜单缺少 name → 400" 400 "$(code -X POST "${BASE}/api/lists" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"sortOrder":1}')"
expect_code "GET /api/lists → 200" 200 "$(code "${BASE}/api/lists")"

OPT_ID=$(body "${BASE}/api/options" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].id))')
expect_code "ID 带后缀 → 400" 400 "$(code "${BASE}/api/options/${OPT_ID}abc")"
BEFORE_BAD_LIST=$(count_of "${BASE}/api/options")
expect_code "新增到不存在榜单 → 404" 404 "$(code -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"name":"不存在榜单的店","emoji":"🍜","listIds":[999999]}')"
expect_code "不存在榜单不会新增孤儿店" "$BEFORE_BAD_LIST" "$(count_of "${BASE}/api/options")"

# 说明：payload 一律先赋值给变量再传入。
# macOS 的 bash 3.2 在「双引号参数里嵌套 $( )，再用 \" 转义」时会拼错引号，
# 把合法 JSON 打散成非法 JSON —— 于是测的其实是解析器而不是接口。
PAYLOAD_ADD='{"mode":"add","optionIds":['$OPT_ID']}'
PAYLOAD_EXPLODE='{"mode":"explode","optionIds":[1]}'
PAYLOAD_REPLACE_EMPTY='{"mode":"replace","optionIds":[]}'

MEMBER_ADD=$(code -X POST "${BASE}/api/lists/${LIST_A}/membership" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d "$PAYLOAD_ADD")
expect_code "membership add 进榜A → 200" 200 "$MEMBER_ADD"
expect_code "按榜A过滤 → 1 条" 1 "$(count_of "${BASE}/api/options?list=${LIST_A}")"
expect_code "按榜B过滤 → 0 条（尚未加入）" 0 "$(count_of "${BASE}/api/options?list=${LIST_B}")"
expect_code "非法 list 参数 → 400" 400 "$(code "${BASE}/api/options?list=not-a-number")"

MEMBER_EXPLODE=$(code -X POST "${BASE}/api/lists/${LIST_A}/membership" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d "$PAYLOAD_EXPLODE")
expect_code "非法 membership mode → 400" 400 "$MEMBER_EXPLODE"
MEMBER_MISSING=$(code -X POST "${BASE}/api/lists/${LIST_A}/membership" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"mode":"add","optionIds":[999999]}')
expect_code "加入不存在店铺 → 404" 404 "$MEMBER_MISSING"

MULTI_BODY='{"name":"双榜店","emoji":"🍜","listIds":['$LIST_A','${LIST_B}']}'
MULTI_ID=$(body -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d "$MULTI_BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.lists||[]).length)})')
expect_code "一店同属两榜（lists 长度 2）" 2 "$MULTI_ID"
expect_code "双榜店在榜A过滤中出现" 2 "$(count_of "${BASE}/api/options?list=${LIST_A}")"

BEFORE_DEL=$(count_of "${BASE}/api/options")
expect_code "删除榜B → 204" 204 "$(code -X DELETE "${BASE}/api/lists/${LIST_B}" -H "x-admin-token: ${TOKEN}")"
expect_code "删榜后店本身不减少" "$BEFORE_DEL" "$(count_of "${BASE}/api/options")"
expect_code "已删的榜B查询 → 空结果而非 500" 0 "$(count_of "${BASE}/api/options?list=${LIST_B}")"

MEMBER_RESET=$(code -X POST "${BASE}/api/lists/${LIST_A}/membership" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d "$PAYLOAD_REPLACE_EMPTY")
expect_code "membership replace 可整榜重置" 200 "$MEMBER_RESET"
expect_code "重置后榜A为空" 0 "$(count_of "${BASE}/api/options?list=${LIST_A}")"

# ---------------------------------------------------------------- 地理信息
section "地理信息：可选但填了就必须合法"
geo_field() { # body json-key → 值（undefined/null 原样标注）
    printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const v=j[process.argv[1]];console.log(v===undefined?"missing":v===null?"null":String(v))}catch(e){console.log("parse-error")}})' "$2"
}

GEO_BODY='{"name":"坐标火锅","emoji":"🍲","latitude":30.274085,"longitude":120.15507,"address":"武林广场"}'
GEO_ID=$(body -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d "$GEO_BODY" | pick_id)
expect_code "POST 带合法经纬度+地址 → 拿到 id" "ok" "$([ -n "$GEO_ID" ] && echo ok || echo empty)"
GEO_READ=$(body "${BASE}/api/options/${GEO_ID}")
expect_code "GET 单条读回经度" "120.15507" "$(geo_field "$GEO_READ" longitude)"
expect_code "GET 单条读回地址" "武林广场" "$(geo_field "$GEO_READ" address)"

PUT_KEEP_BODY='{"name":"坐标火锅改","emoji":"🍲"}'
expect_code "PUT 不带坐标 → 200" 200 "$(code -X PUT "${BASE}/api/options/${GEO_ID}" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d "$PUT_KEEP_BODY")"
expect_code "PUT 后坐标保留（附加元数据不随全量更新清空）" "30.274085" "$(geo_field "$(body "${BASE}/api/options/${GEO_ID}")" latitude)"

expect_code "POST 只给纬度不成对 → 400" 400 "$(code -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"name":"半对","emoji":"🍜","latitude":30.1}')"
expect_code "POST 纬度越界(91) → 400" 400 "$(code -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"name":"越界","emoji":"🍜","latitude":91,"longitude":120}')"
expect_code "POST 非数字坐标 → 400" 400 "$(code -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"name":"坏类型","emoji":"🍜","latitude":"abc","longitude":120}')"
expect_code "POST 空字符串坐标 → 400" 400 "$(code -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"name":"空串","emoji":"🍜","latitude":"","longitude":120}')"

expect_code "PATCH 只改经度（另一半保留）→ 200" 200 "$(code -X PATCH "${BASE}/api/options/${GEO_ID}" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"longitude":120.2}')"
expect_code "PATCH 只清经度造成半对 → 400" 400 "$(code -X PATCH "${BASE}/api/options/${GEO_ID}" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"longitude":null}')"
expect_code "PATCH 成对清空 → 200" 200 "$(code -X PATCH "${BASE}/api/options/${GEO_ID}" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"latitude":null,"longitude":null}')"
expect_code "清空后纬度为 null" "null" "$(geo_field "$(body "${BASE}/api/options/${GEO_ID}")" latitude)"
expect_code "PATCH 单独清地址 → 200" 200 "$(code -X PATCH "${BASE}/api/options/${GEO_ID}" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"address":null}')"

GEO_IMPORT='{"mode":"append","items":[{"name":"导入带坐标","emoji":"🍜","latitude":30.1,"longitude":120.1,"address":"某路1号"},{"name":"导入无坐标","emoji":"🍚"}]}'
expect_code "import 带坐标 → 200" 200 "$(code -X POST "${BASE}/api/options/import" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d "$GEO_IMPORT")"
IMPORT_COORD=$(body "${BASE}/api/options" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s).find((x)=>x.name==="导入带坐标");console.log(o&&o.longitude!=null?String(o.longitude):"missing")})')
expect_code "import 的坐标入了库" "120.1" "$IMPORT_COORD"
expect_code "import 非法坐标 → 400（整单拒绝）" 400 "$(code -X POST "${BASE}/api/options/import" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"mode":"append","items":[{"name":"坏坐标","emoji":"🍜","latitude":99,"longitude":120}]}')"

# ---------------------------------------------------------------- 静态资源
section "静态资源只放行前端真正需要的文件"
expect_code "GET / → 200" 200 "$(code "${BASE}/")"
expect_code "GET / 返回 HTML" "text/html; charset=UTF-8" "$(ctype "${BASE}/")"
expect_code "GET /styles.css → 200" 200 "$(code "${BASE}/styles.css")"
expect_code "GET /script.js → 200" 200 "$(code "${BASE}/script.js")"
expect_code "GET /image1/eateat.jpg → 200" 200 "$(code "${BASE}/image1/eateat.jpg")"
expect_code "GET /emoji-rules.js → 200" 200 "$(code "${BASE}/emoji-rules.js")"
expect_code "GET /map.js → 200" 200 "$(code "${BASE}/map.js")"
expect_code "GET /api/config → 200（地图公开配置）" 200 "$(code "${BASE}/api/config")"
expect_code "GET /manifest.webmanifest → 200" 200 "$(code "${BASE}/manifest.webmanifest")"
expect_code "manifest 的 Content-Type 正确" "application/manifest+json; charset=utf-8" "$(ctype "${BASE}/manifest.webmanifest")"
expect_code "GET /sw.js → 200" 200 "$(code "${BASE}/sw.js")"
expect_code "sw.js 必须即时失效（no-cache），否则发版卡在旧缓存" "no-cache" "$(header_value "${BASE}/sw.js" "cache-control")"
expect_code "GET /icons/icon-192.png → 200" 200 "$(code "${BASE}/icons/icon-192.png")"
expect_code "图标返回 PNG" "image/png" "$(ctype "${BASE}/icons/icon-192.png")"
for hidden in README.md package.json package-lock.json Dockerfile docker-compose.yml server.js script.js.map data/options.json image1/eateat.jpg.bak; do
    expect_code "禁止读取 /${hidden}" 404 "$(code "${BASE}/${hidden}")"
done
for dotgit in .git/config .git/HEAD .env; do
    expect_code "禁止读取 /${dotgit}" 404 "$(code "${BASE}/${dotgit}")"
done
expect_has "响应含安全头 nosniff" "x-content-type-options: nosniff" <(curl -s -D - -o /dev/null "${BASE}/api/health" | tr -d '\r' | tr 'A-Z' 'a-z')

# ---------------------------------------------------------------- CORS
section "跨域写操作需要白名单"
expect_code "同域（Origin=host）写请求放行" 201 "$(code -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -H "Origin: ${BASE}" -d '{"name":"同域写入","emoji":"🍜"}')"
expect_code "白名单来源预检 → 204" 204 "$(code -X OPTIONS "${BASE}/api/options" -H "Origin: ${ALLOWED_ORIGIN}" -H 'Access-Control-Request-Method: POST')"
expect_code "白名单来源写请求 → 201" 201 "$(code -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -H "Origin: ${ALLOWED_ORIGIN}" -d '{"name":"白名单写入","emoji":"🍜"}')"
expect_code "非白名单来源预检 → 403" 403 "$(code -X OPTIONS "${BASE}/api/options" -H "Origin: ${EVIL_ORIGIN}" -H 'Access-Control-Request-Method: POST')"
expect_code "非白名单来源写请求 → 403（即使密钥正确）" 403 "$(code -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -H "Origin: ${EVIL_ORIGIN}" -d '{"name":"跨域恶意","emoji":"🍜"}')"
expect_code "非白名单来源不泄露 CORS 头" "" "$(header_value "${BASE}/api/options" "access-control-allow-origin" -H "Origin: ${EVIL_ORIGIN}" -X OPTIONS -H 'Access-Control-Request-Method: DELETE')"

# ---------------------------------------------------------------- 限流
section "密钥爆破限流（放最后，会打满计数）"
for _ in $(seq 1 24); do
    code -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "x-admin-token: ${WRONG}" -d '{"name":"爆破","emoji":"🍜"}' >/dev/null
done
expect_code "连续错密钥后被限流 → 429" 429 "$(code -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "x-admin-token: ${WRONG}" -d '{"name":"爆破","emoji":"🍜"}')"
expect_code "限流后正确密钥也被挡住（说明是 IP 级限流）" 429 "$(code -X POST "${BASE}/api/options" -H 'Content-Type: application/json' -H "x-admin-token: ${TOKEN}" -d '{"name":"限流中","emoji":"🍜"}')"

# ---------------------------------------------------------------- 启动策略
section "启动策略：production 缺少密钥必须拒绝启动"
kill "$SRV_PID" 2>/dev/null
wait "$SRV_PID" 2>/dev/null
SRV_PID=""
FAILBOOT_LOG="${TMPDIR:-/tmp}/huliaeat-boot.$$"
NODE_ENV=production ADMIN_TOKEN="" PORT=$((PORT + 1)) DATABASE_URL="$DB_URL" node server.js >"$FAILBOOT_LOG" 2>&1
expect_code "NODE_ENV=production 且无 ADMIN_TOKEN → 非 0 退出" "1" "$?"
expect_has "退出原因写明需要 ADMIN_TOKEN" "ADMIN_TOKEN" "$FAILBOOT_LOG"
rm -f "$FAILBOOT_LOG"

DEVBOOT_LOG="${TMPDIR:-/tmp}/huliaeat-dev.$$"
NODE_ENV=development ADMIN_TOKEN="" PORT=$((PORT + 2)) DATABASE_URL="$DB_URL" node server.js >"$DEVBOOT_LOG" 2>&1 &
DEV_PID=$!
DEV_OK=0
for _ in $(seq 1 60); do
    if curl -s -m 2 "http://127.0.0.1:$((PORT + 2))/api/health" | grep -q '"status":"ok"'; then DEV_OK=1; break; fi
    sleep 0.25
done
expect_code "开发模式无密钥仍可启动（附警告）" 1 "$DEV_OK"
expect_has "启动日志打印安全警告" "安全警告" "$DEVBOOT_LOG"
expect_code "开发模式写接口无需密钥 → 201" 201 "$(code -X POST "http://127.0.0.1:$((PORT + 2))/api/options" -H 'Content-Type: application/json' -d '{"name":"开发模式","emoji":"🍜"}')"
kill "$DEV_PID" 2>/dev/null
wait "$DEV_PID" 2>/dev/null
rm -f "$DEVBOOT_LOG"

# ---------------------------------------------------------------- 汇总
printf '\n\033[1m结果：%d 通过 / %d 失败\033[0m\n' "$PASS_COUNT" "$FAIL_COUNT"
if [ "$FAIL_COUNT" -ne 0 ]; then
    ci_error "冒烟测试 ${PASS_COUNT} 通过 / ${FAIL_COUNT} 失败（每条失败都有单独的 annotation）"
    exit 1
fi
