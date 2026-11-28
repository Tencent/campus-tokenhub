#!/usr/bin/env bash
#
# 打交付包给学校：只导出 git 跟踪的文件，天然排除 node_modules / .next / .env* / 本地数据。
#
# 用法：
#   ./pack-for-school.sh                 # 默认：要求工作区干净
#   ./pack-for-school.sh --allow-dirty   # 把未提交的改动也打进包（不含未跟踪文件）
#   OUT_DIR=/tmp/x ./pack-for-school.sh  # 自定义输出目录
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M)"
OUT_BASE="${OUT_DIR:-$ROOT/dist}"
OUT="$OUT_BASE/campus-tokenhub-deliver-$STAMP"

# 内部线上域名 -> 占位符。注意：这个域名主要是「配置」，配置本身不进包；
# 这里处理的是残留在代码注释 / 错误文案 / 测试里的静态字符串。
INTERNAL_DOMAIN="api.aiedu.tencent.com"
PLACEHOLDER="${PLACEHOLDER:-your-school.example.com}"

# 不进包的路径（相对仓库根，git pathspec）。仓库是 monorepo，
# 所以每条都要带子项目前缀。
EXCLUDES=(
  # 注意 glob：`*/openspec` 只匹配到目录本身，内容要写成 `*/openspec/**`
  ":!*/openspec/**"
  ":!*/docs/tokenhub-architecture-internal.html"
  # online profile 是「我们自己的线上环境」快照（整套腾讯域名），
  # 学校没有这个环境，npm run env:online 对他们无意义。
  # use-env.mjs 有 existsSync 容错，缺这个文件只会提示可用 local / lan。
  ":!*/env/profiles/online.env"
)

REPOS=(campus-tokenhub-assign campus-tokenhub-member)
# git 操作的对象：两个子项目同属一个仓库，外加两站共用的共享包。
# `packages/portal-activity` 必须进包：两站 package.json 依赖
# `file:../packages/portal-activity`，Dockerfile 也靠 `COPY --from=activity` 挂载，
# 缺了它学校侧 `npm ci` 与 `docker compose build` 都会直接失败。
TRACKED_PATHS=("${REPOS[@]}" packages/portal-activity)
# 仓库根目录也要随包交付的文件：许可证全文（MIT）与第三方组件许可证地图。
# 网关目录自带 AGPL-3.0 全文，但「哪部分适用哪个许可」的说明只在根目录，缺了会误导接收方。
ROOT_FILES=(LICENSE THIRD-PARTY-NOTICES.md)
ALLOW_DIRTY=0

for arg in "$@"; do
  case "$arg" in
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m[警告]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[失败]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 1. 预检 ----------
step "预检"

git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "$ROOT 不是 git 仓库"
if ! git -C "$ROOT" rev-parse --verify -q HEAD >/dev/null; then
  die "仓库还没有任何 commit"
fi

for repo in "${REPOS[@]}"; do
  [ -d "$ROOT/$repo" ] || die "找不到子项目目录: $ROOT/$repo"
done

# 只看两个子项目的改动：根目录下的打包脚本、dist/、.workbuddy/ 等本地文件不该拦打包
dirty="$(git -C "$ROOT" status --porcelain -- "${TRACKED_PATHS[@]}")"
# 未跟踪文件（新建但没 git add）不会进 git archive，即便加了 --allow-dirty 也不会。
# 这类文件被页面/构建引用时，交付包会缺文件、首次构建直接失败，必须显式列出来。
untracked="$(git -C "$ROOT" status --porcelain --untracked-files=all -- "${TRACKED_PATHS[@]}" | sed -n 's/^?? //p')"
if [ -n "$dirty" ]; then
  if [ "$ALLOW_DIRTY" -eq 1 ]; then
    warn "有未提交改动，将用 git stash create 把改动一并打包（未跟踪文件不会包含）"
    if [ -n "$untracked" ]; then
      warn "以下未跟踪文件不会进包（需要先 git add）："
      printf '%s\n' "$untracked" | sed 's/^/      /'
    fi
    ref="$(git -C "$ROOT" stash create "pack-$STAMP" || true)"
    if [ -z "${ref:-}" ]; then
      warn "stash create 失败，回退到 HEAD（未提交改动将丢失）"
      ref="HEAD"
    fi
  else
    say ""
    say "有未提交改动："
    printf '%s\n' "$dirty" | sed 's/^/    /'
    say ""
    if [ -n "$untracked" ]; then
      say "  其中未跟踪文件不会进包（需要先 git add）："
      printf '%s\n' "$untracked" | sed 's/^/    /'
      say ""
    fi
    say "  先提交：  git add ${TRACKED_PATHS[*]} && git commit -m \"chore: 交付快照\""
    say "  或强打：  ./pack-for-school.sh --allow-dirty"
    die "工作区不干净，已中止（避免交付包缺改动）"
  fi
else
  ref="HEAD"
fi

for repo in "${REPOS[@]}"; do
  say "  $repo  $(git -C "$ROOT" ls-files -- "$repo" | wc -l | tr -d ' ') 个跟踪文件  ref=$ref"
done

# ---------- 2. 导出 ----------
step "导出（git archive，排除未跟踪与忽略项）"

mkdir -p "$OUT_BASE"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -C "$ROOT" archive --format=tar "$ref" -- "${TRACKED_PATHS[@]}" "${ROOT_FILES[@]}" "${EXCLUDES[@]}" \
  | tar -x -C "$TMP"

for f in "${ROOT_FILES[@]}"; do
  [ -f "$TMP/$f" ] || die "根目录文件没有导出到交付目录: $f"
done

for repo in "${REPOS[@]}"; do
  dest="$TMP/$repo"
  [ -d "$dest" ] || die "$repo 没有导出到交付目录"

  # 兜底校验：任何敏感文件混进导出目录就中止
  if find "$dest" \( \
        -name '.env' -o -name '.env.local' -o -name '.env.dual' \
        -o -name 'docker-compose.override.yml' -o -name 'local-dev.md' \
        -o -name 'octafuse-pgdata' -o -name '.data' \
      \) -print -quit | grep -q .; then
    die "$repo 导出目录里出现了敏感文件，已中止"
  fi

  say "  $repo -> $(find "$dest" -type f | wc -l | tr -d ' ') 个文件"
done

# ---------- 3. 内部域名脱敏 ----------
step "脱敏：$INTERNAL_DOMAIN -> $PLACEHOLDER"

for repo in "${REPOS[@]}"; do
  dest="$TMP/$repo"
  hits="$(grep -rlI -e "$INTERNAL_DOMAIN" "$dest" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$hits" -gt 0 ]; then
    say "  $repo 命中 $hits 个文件（均为代码注释/文案/测试中的静态字符串）："
    grep -rlI -e "$INTERNAL_DOMAIN" "$dest" 2>/dev/null | while read -r f; do
      say "    ${f#$dest/}"
      # 可移植写法：不依赖 sed -i 的平台差异
      sed "s/$INTERNAL_DOMAIN/$PLACEHOLDER/g" "$f" > "$f.packtmp"
      mv "$f.packtmp" "$f"
    done
  else
    say "  $repo 无需替换"
  fi
done

if grep -rI -e "$INTERNAL_DOMAIN" "$TMP" 2>/dev/null | head -3 | grep -q .; then
  die "仍有内部域名残留，已中止"
fi

# ---------- 4. 交付说明 ----------
step "生成交付说明"

cat > "$TMP/交付说明.md" <<EOF
# campus-tokenhub 交付包

导出时间：$(date '+%Y-%m-%d %H:%M')
导出方式：git archive（仅版本库跟踪文件）

## 目录结构

| 目录 | 说明 |
| --- | --- |
| \`campus-tokenhub-assign/\` | 成员分配 / TokenHub 门户与网关 |
| \`campus-tokenhub-member/\` | 成员门户 |
| \`packages/portal-activity/\` | 两站共用的活动埋点包（登录事件 / 页面访问），以 \`file:\` 依赖引入，必须与两站同级保留 |
| \`LICENSE\` | 仓库根许可证（MIT，仅覆盖门户代码，不含网关目录） |
| \`THIRD-PARTY-NOTICES.md\` | 第三方组件与许可证地图（含 octafuse-gateway 的 AGPL-3.0 边界说明） |

两者同属一个仓库（campus-tokenhub monorepo）的两个子项目，分别安装依赖、分别启动；
\`packages/portal-activity\` 通过 \`file:../packages/portal-activity\` 被两站引用，目录层级不能改动。

## 许可证

- \`campus-tokenhub-assign/\`（除 \`local-stack/octafuse-gateway/\`）与 \`campus-tokenhub-member/\`：MIT
- \`campus-tokenhub-assign/local-stack/octafuse-gateway/\`：**AGPL-3.0**（上游 OctaFuse Gateway 的修改版）

网关目录内自带 \`LICENSE\`（AGPL-3.0 全文）与 \`MODIFICATIONS.md\`（修改说明、修改日期与基线），
分发该目录时须一并保留；若对外提供基于它的网络服务，依 AGPL-3.0 第 13 条须向使用者提供对应源码。

## 为什么包里没有 node_modules 和 .env

- \`node_modules/\`、\`.next/\`：构建产物，用 \`npm ci\` 重新生成
- \`.env\`、\`.env.local\`、\`.env.dual\`：**部署方自己的密钥与口令**，不随代码交付
- 交付包只包含 \`*.example\` 模板

## 快速开始（每个目录分别执行）

\`\`\`bash
npm ci
cp .env.example .env        # 然后按注释填写
npm run build
npm start
\`\`\`

本地开发用 \`npm run dev\`；环境切换用 \`npm run env:local|lan|online\`。

## 必须自己填的配置

打开 \`.env.example\`，至少设置：

- \`POSTGRES_PASSWORD\` / \`SESSION_SECRET\`：**改成你自己的强随机值**
- \`PUBLIC_BASE_URL\` / \`NEXT_PUBLIC_PROXY_BASE\` / \`ADMIN_PUBLIC_BASE_URL\`：改成你的实际访问地址
- 同时部署成员自购站时，在统一采买站的 \`.env\` 里填 \`MEMBER_PUBLIC_BASE_URL\`（如 \`https://域名/tokenhub/member\`），侧边栏「用户入口」才会出现「成员账号 ↗」；只部署统一采买站时留空
- 管理员初始账号口令：首次启动前设置
- TokenHub API Key / 腾讯云 AK：在你的腾讯云账号下申请后填入

配置项完整说明见各自目录的 \`README.md\`。

## 部署管理员账号（只有一套，两站共用）

\`PORTAL_ADMIN_USERNAME\` / \`PORTAL_ADMIN_PASSWORD\` 是**给运维用的唯一一套账号**：

- 统一采买站、成员自购站、网关管理后台（\`ADMIN_AUTH_MODE=portal\`）**都用这一套登录**，不存在第二个口令；
- 首次启动会把这两项加密写进共享配置（\`portal_shared.login_config\`），此后以库内为准、改 \`.env\` 不再生效；
  同库双站部署两站读同一行、口令天然一致；分栈部署（两套库）没有共享行，必须把两处写成同一个值；
- SSO 参数填齐后这个入口**不会自动关闭**，请确认学校账号能登录后，再把 \`PORTAL_ADMIN_LOGIN\` 置 \`off\` 并清空口令；
- \`OCTAFUSE_ADMIN_API_KEY\` 是门户调用网关 admin API 的**集成密钥**（\`Authorization: Bearer\`），不对人使用；门户不再持有网关管理员账密。

## 注意

- 包内文档示例中的 \`$PLACEHOLDER\` 是占位符，需替换成你的真实域名。
- \`env/profiles/online.env\` 等文件只是示例地址，不要直接用于生产。
EOF

# ---------- 5. 压缩 ----------
step "压缩"

ZIP="$OUT_BASE/campus-tokenhub-deliver-$STAMP.zip"
mkdir -p "$OUT"
cp -R "$TMP"/. "$OUT"/
( cd "$OUT_BASE" && zip -qr "$ZIP" "$(basename "$OUT")" )

# ---------- 6. 结果 ----------
step "完成"
say "  目录：$OUT"
say "  压缩包：$ZIP  ($(du -h "$ZIP" | cut -f1))"
say ""
if [ -n "$untracked" ]; then
  warn "注意：以下未跟踪文件没有进包（git add 后重新打包才会包含）"
  printf '%s\n' "$untracked" | sed 's/^/      /'
  say ""
fi
say "交付前建议再抽查："
# 精确到「真会泄密的那几类」，避免把 env/profiles/*.env 这类示例配置误报成敏感文件
say "  unzip -l \"$ZIP\" | grep -Ei '/(\\.env|\\.env\\.local|\\.env\\.dual)$|node_modules/|pgdata/' || echo '  无敏感文件 ✅'"
