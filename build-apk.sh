#!/bin/bash
# ============================================================
#  Venture Android 一键打包脚本
#  用法: cd E:\Rust\Venture-android && bash build-apk.sh
# ============================================================
set -eo pipefail

# ── 环境变量配置 ──────────────────────────────────────────
export ANDROID_HOME="${ANDROID_HOME:-C:/Users/admin/AppData/Local/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk/29.0.14206865}"
export JAVA_HOME="${JAVA_HOME:-C:/Program Files/Java/jdk-17.0.1}"
NDK_BIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/windows-x86_64/bin"
export PATH="$HOME/.cargo/bin:$NDK_BIN:$PATH"
export CC_aarch64_linux_android="$NDK_BIN/aarch64-linux-android35-clang.cmd"
export AR_aarch64_linux_android="$NDK_BIN/llvm-ar.exe"

# ── 路径常量 ──────────────────────────────────────────────
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$PROJECT_ROOT"
TAURI_DIR="$PROJECT_ROOT/src-tauri"
GEN_DIR="$TAURI_DIR/gen/android"
SO_SOURCE="$PROJECT_ROOT/target/aarch64-linux-android/release/libventure_android_lib.so"
JNILIBS_DIR="$GEN_DIR/app/src/main/jniLibs/arm64-v8a"
OUT_APK="$GEN_DIR/app/build/outputs/apk/arm64/release/app-arm64-release-unsigned.apk"
FINAL_APK="$PROJECT_ROOT/Venture-release.apk"

echo "============================================================"
echo " Venture Android APK Builder"
echo "============================================================"
echo ""
echo "[check] 环境:"
echo "  ANDROID_HOME = $ANDROID_HOME"
echo "  JAVA_HOME    = $JAVA_HOME"
echo "  rustc        = $(rustc --version 2>/dev/null || echo 'NOT FOUND')"
echo ""

# ── 步骤 1: 构建前端 ─────────────────────────────────────
echo "[1/5] 构建前端..."
cd "$FRONTEND_DIR"
npm run build:tauri 2>&1 | tail -3
echo "  => 前端构建完成"
echo ""

# ── 步骤 2: 编译 Rust → .so ──────────────────────────────
echo "[2/5] 编译 Rust backend (aarch64-linux-android)..."
cd "$PROJECT_ROOT"
cargo build \
    --manifest-path "$TAURI_DIR/Cargo.toml" \
    --target aarch64-linux-android \
    --lib \
    --release \
    2>&1 | tail -5
    2>&1 | tail -5
echo "  => Rust 编译完成"
echo ""

# ── 步骤 3: 复制前端 + .so 到 Android 项目 ──────────────────
echo "[3/5] 复制前端和 .so..."
# 前端
ASSETS_DIR="$GEN_DIR/app/src/main/assets"
mkdir -p "$ASSETS_DIR"
rm -rf "$ASSETS_DIR"/*
cp -r "$PROJECT_ROOT/dist/web/"* "$ASSETS_DIR/"
echo "  前端: $(ls "$ASSETS_DIR/index.html" 2>/dev/null && echo 'OK' || echo 'MISSING!')"
# .so
mkdir -p "$JNILIBS_DIR"
cp "$SO_SOURCE" "$JNILIBS_DIR/"
ls -lh "$JNILIBS_DIR/libventure_android_lib.so"
echo "  => 前端和 .so 已就绪"
echo ""

# ── 步骤 4: Gradle 打包 APK ──────────────────────────────────
echo "[4/5] Gradle 打包 APK..."
cd "$GEN_DIR"

# 跳过所有 rustBuild 任务（Rust 已手动编译）
./gradlew assembleRelease \
    -x :app:rustBuildArm64Release \
    -x :app:rustBuildArmRelease \
    -x :app:rustBuildX86Release \
    -x :app:rustBuildX86_64Release \
    --no-daemon \
    2>&1 | tail -8

echo ""
echo "============================================================"
if [ -f "$OUT_APK" ]; then
    SIZE=$(ls -lh "$OUT_APK" | awk '{print $5}')
    cp "$OUT_APK" "$FINAL_APK"
    echo "  APK 构建成功!"
    echo "  大小: $SIZE"
    echo "  输出: $FINAL_APK"
else
    echo "  APK 构建失败，请查看上方日志"
    exit 1
fi

# ── 步骤 5: 签名 APK ──────────────────────────────────────
echo "[5/5] 签名 APK..."
APKSIGNER="$ANDROID_HOME/build-tools/36.0.0/apksigner.bat"
DEBUG_KS="$HOME/.android/debug.keystore"
SIGNED_APK="$PROJECT_ROOT/Venture-release-signed.apk"

if [ -f "$DEBUG_KS" ] && [ -f "$SIGNED_APK" ]; then
    "$APKSIGNER" sign \
        --ks "$DEBUG_KS" \
        --ks-pass pass:android \
        --ks-key-alias androiddebugkey \
        --key-pass pass:android \
        --out "$SIGNED_APK" \
        "$FINAL_APK" \
        2>/dev/null
    echo "  已签名: $SIGNED_APK"
else
    echo "  (跳过，debug.keystore 不存在或非 bash 环境)"
fi
echo "============================================================"
