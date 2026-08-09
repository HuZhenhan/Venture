#!/bin/bash
# ============================================================
#  Venture Android 一键打包+安装脚本
#  支持并行构建、自动签名、ADB 安装
#
#  用法:
#    bash build-apk.sh             完整构建+安装
#    bash build-apk.sh --no-install 仅打包不安装
#    bash build-apk.sh --skip-rust  跳过 Rust 编译（仅前端变更时）
#    bash build-apk.sh --skip-front 跳过前端构建（仅 Rust 变更时）
#    bash build-apk.sh --clean      清理后重新构建
# ============================================================
set -eo pipefail

# ── 解析参数 ──────────────────────────────────────────────
SKIP_FRONT=false
SKIP_RUST=false
NO_INSTALL=false
DO_CLEAN=false

for arg in "$@"; do
  case "$arg" in
    --skip-front) SKIP_FRONT=true ;;
    --skip-rust)  SKIP_RUST=true ;;
    --no-install) NO_INSTALL=true ;;
    --clean)      DO_CLEAN=true ;;
    --help|-h)
      echo "用法: bash build-apk.sh [选项]"
      echo "  --skip-front   跳过前端构建"
      echo "  --skip-rust    跳过 Rust 编译"
      echo "  --no-install   仅打包 APK，不安装到设备"
      echo "  --clean        先清理构建产物"
      exit 0
      ;;
  esac
done

# ── 颜色 ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC}  $1"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $1"; exit 1; }

# ── 环境自动检测 ──────────────────────────────────────────
detect_env() {
  # ANDROID_HOME
  if [ -z "$ANDROID_HOME" ]; then
    for candidate in \
      "$HOME/AppData/Local/Android/Sdk" \
      "/c/Users/$USERNAME/AppData/Local/Android/Sdk" \
      "/c/Users/admin/AppData/Local/Android/Sdk"; do
      if [ -d "$candidate" ]; then
        export ANDROID_HOME="$candidate"
        break
      fi
    done
  fi
  [ -z "$ANDROID_HOME" ] && fail "ANDROID_HOME 未设置，请设置后重试"
  export ANDROID_SDK_ROOT="$ANDROID_HOME"

  # NDK
  if [ -z "$ANDROID_NDK_HOME" ]; then
    NDK_VERSIONS=$(ls "$ANDROID_HOME/ndk/" 2>/dev/null | sort -V)
    if [ -n "$NDK_VERSIONS" ]; then
      LATEST_NDK=$(echo "$NDK_VERSIONS" | tail -1)
      export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$LATEST_NDK"
    fi
  fi

  # JAVA_HOME
  if [ -z "$JAVA_HOME" ]; then
    for candidate in \
      "/c/Program Files/Java/jdk-17"* \
      "/c/Program Files/Java/jdk-21"* \
      "/c/Program Files/Java/jdk-11"*; do
      if [ -d "$candidate" ]; then
        export JAVA_HOME="$candidate"
        break
      fi
    done
  fi
  [ ! -d "$JAVA_HOME" ] && fail "JAVA_HOME 无效: $JAVA_HOME"

  NDK_BIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/windows-x86_64/bin"
  # 查找可用的 clang（不同 API level）
  CLANG_PATH=$(ls "$NDK_BIN"/aarch64-linux-android*-clang.cmd 2>/dev/null | head -1)
  [ -z "$CLANG_PATH" ] && CLANG_PATH=$(ls "$NDK_BIN"/aarch64-linux-android*-clang 2>/dev/null | head -1)
  [ -z "$CLANG_PATH" ] && fail "找不到 NDK clang (aarch64-linux-android*-clang)"

  export CC_aarch64_linux_android="$CLANG_PATH"
  export AR_aarch64_linux_android="$NDK_BIN/llvm-ar.exe"
  export PATH="$HOME/.cargo/bin:$NDK_BIN:$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/build-tools/36.0.0:$ANDROID_HOME/build-tools/35.0.0:$ANDROID_HOME/build-tools/34.0.0:$PATH"

  ok "ANDROID_HOME = $ANDROID_HOME"
  ok "NDK         = $ANDROID_NDK_HOME"
  ok "JAVA_HOME   = $JAVA_HOME"
}

# ── 路径常量 ──────────────────────────────────────────────
RUST_TARGET="aarch64-linux-android"
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$PROJECT_ROOT"
TAURI_DIR="$PROJECT_ROOT/src-tauri"
GEN_DIR="$TAURI_DIR/gen/android"
SO_SOURCE="$PROJECT_ROOT/target/$RUST_TARGET/release/libventure_android_lib.so"
JNILIBS_DIR="$GEN_DIR/app/src/main/jniLibs/arm64-v8a"
ASSETS_DIR="$GEN_DIR/app/src/main/assets"
OUT_APK="$GEN_DIR/app/build/outputs/apk/arm64/release/app-arm64-release-unsigned.apk"
FINAL_APK="$PROJECT_ROOT/Venture-release-signed.apk"

# ── 清理 ──────────────────────────────────────────────────
if [ "$DO_CLEAN" = true ]; then
  info "清理构建产物..."
  rm -rf "$PROJECT_ROOT/dist/web" 2>/dev/null || true
  rm -f "$SO_SOURCE" 2>/dev/null || true
  rm -rf "$GEN_DIR/app/build" 2>/dev/null || true
fi

# ── 步骤 1: 构建前端 ─────────────────────────────────────
build_frontend() {
  if [ "$SKIP_FRONT" = true ]; then
    if [ -f "$FRONTEND_DIR/dist/web/index.html" ]; then
      warn "跳过前端构建"
      return
    else
      fail "--skip-front 但 dist/web/index.html 不存在，请去掉 --skip-front"
    fi
  fi

  info "构建前端..."
  cd "$FRONTEND_DIR"
  npm run build:tauri 2>&1 | tail -3
  if [ ! -f "$FRONTEND_DIR/dist/web/index.html" ]; then
    fail "前端构建失败"
  fi
  ok "前端构建完成 ($(ls -lh dist/web/index.html | awk '{print $5}'))"
}

# ── 步骤 2: 编译 Rust → .so ──────────────────────────────
build_rust() {
  if [ "$SKIP_RUST" = true ]; then
    if [ -f "$SO_SOURCE" ]; then
      warn "跳过 Rust 编译"
      return
    else
      fail "--skip-rust 但 .so 不存在，请去掉 --skip-rust"
    fi
  fi

  info "编译 Rust ($RUST_TARGET)..."
  cd "$PROJECT_ROOT"
  # Tauri 在前端 assets 编译期嵌入 .so；touch build.rs 强制 build.rs 重跑，
  # 避免 Rust 源码未变化时 cargo 跳过 build.rs 导致 .so 内嵌旧版前端。
  touch "$TAURI_DIR/build.rs"
  cargo build \
    --manifest-path "$TAURI_DIR/Cargo.toml" \
    --target "$RUST_TARGET" \
    --lib \
    --release \
    2>&1 | tail -5
  if [ ! -f "$SO_SOURCE" ]; then
    fail "Rust 编译失败"
  fi
  ok "Rust 编译完成 ($(ls -lh "$SO_SOURCE" | awk '{print $5}'))"
}

# ── 步骤 3: 复制产物 ─────────────────────────────────────
copy_artifacts() {
  info "复制前端到 assets..."
  mkdir -p "$ASSETS_DIR"
  rm -rf "$ASSETS_DIR"/*
  cp -r "$FRONTEND_DIR/dist/web/"* "$ASSETS_DIR/"
  [ ! -f "$ASSETS_DIR/index.html" ] && fail "前端复制失败"
  ok "前端已复制"

  info "复制 .so 到 jniLibs..."
  mkdir -p "$JNILIBS_DIR"
  cp "$SO_SOURCE" "$JNILIBS_DIR/"
  ok ".so 已复制 ($(ls -lh "$JNILIBS_DIR/libventure_android_lib.so" | awk '{print $5}'))"
}

# ── 步骤 4: Gradle 打包 APK ──────────────────────────────
build_gradle() {
  info "Gradle assembleRelease..."
  cd "$GEN_DIR"
  ./gradlew assembleRelease \
    -x :app:rustBuildArm64Release \
    -x :app:rustBuildArmRelease \
    -x :app:rustBuildX86Release \
    -x :app:rustBuildX86_64Release \
    --no-daemon \
    2>&1 | tail -8

  if [ ! -f "$OUT_APK" ]; then
    fail "Gradle 打包失败"
  fi
  ok "APK 构建成功 ($(ls -lh "$OUT_APK" | awk '{print $5}'))"
}

# ── 步骤 5: 签名 ──────────────────────────────────────────
sign_apk() {
  info "签名 APK..."
  DEBUG_KS="$HOME/.android/debug.keystore"
  if [ ! -f "$DEBUG_KS" ]; then
    fail "找不到 debug.keystore: $DEBUG_KS"
  fi

  UNSIGNED_APK="$OUT_APK"

  # 查找 apksigner
  APSIGNER=""
  for bt in "$ANDROID_HOME/build-tools"/*/apksigner.bat "$ANDROID_HOME/build-tools"/*/apksigner; do
    [ -f "$bt" ] && { APSIGNER="$bt"; break; }
  done

  if [ -z "$APSIGNER" ]; then
    fail "找不到 apksigner，请检查 build-tools"
  fi

  rm -f "$FINAL_APK" 2>/dev/null || true
  "$APSIGNER" sign \
    --ks "$DEBUG_KS" \
    --ks-pass pass:android \
    --ks-key-alias androiddebugkey \
    --key-pass pass:android \
    --out "$FINAL_APK" \
    "$UNSIGNED_APK" 2>/dev/null

  if [ ! -f "$FINAL_APK" ]; then
    fail "签名失败"
  fi
  ok "签名完成 ($(ls -lh "$FINAL_APK" | awk '{print $5}'))"
}

# ── 步骤 6: ADB 安装 ──────────────────────────────────────
install_apk() {
  info "检查 ADB 设备..."
  DEVICES=$(adb devices 2>/dev/null | grep -v "List of devices attached" | grep -v "^$" | grep "device$" || true)
  if [ -z "$DEVICES" ]; then
    warn "没有检测到已连接的 ADB 设备，跳过安装"
    warn "APK 位于: $FINAL_APK"
    return
  fi

  DEVICE_COUNT=$(echo "$DEVICES" | wc -l)
  info "检测到 $DEVICE_COUNT 个设备"
  echo "$DEVICES"

  info "安装 APK (覆盖安装，保留应用数据)..."
  # 注意：禁止卸载后重装兜底——会清空应用数据（聊天记录/配置/技能均丢失，曾发生事故）。
  # 覆盖安装失败（通常为签名不一致）时仅提示，由用户决定如何处理。
  if ! adb install -r "$FINAL_APK" 2>&1; then
    fail "覆盖安装失败（请检查签名是否一致）。已放弃自动卸载重装以避免数据丢失。
APK 位于: $FINAL_APK
如需强制重装（会清空应用数据），请手动执行: adb uninstall com.venture.app && adb install $FINAL_APK"
  fi
  ok "安装完成！"
}

# ═══════════════════════════════════════════════════════════
#  主流程
# ═══════════════════════════════════════════════════════════
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║        Venture Android 一键打包+安装脚本             ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

detect_env

START_TIME=$(date +%s)

# 顺序构建：前端必须先于 Rust，确保 build.rs 嵌入的是最新 dist
build_frontend
build_rust

copy_artifacts
build_gradle
sign_apk

if [ "$NO_INSTALL" = false ]; then
  install_apk
fi

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))
MIN=$((DURATION / 60))
SEC=$((DURATION % 60))

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo -e "║  ${GREEN}全部完成!${NC}  耗时: ${MIN}m${SEC}s                    ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  APK: Venture-release-signed.apk                    ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
