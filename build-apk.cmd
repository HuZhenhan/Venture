@echo off
REM ============================================================
REM  Venture Android 一键打包脚本 (Windows CMD)
REM  用法: build-apk.cmd
REM  或双击运行
REM ============================================================
setlocal enabledelayedexpansion

REM ── 环境变量配置 ──────────────────────────────────────────
if "%ANDROID_HOME%"=="" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if "%ANDROID_NDK_HOME%"=="" set "ANDROID_NDK_HOME=%ANDROID_HOME%\ndk\29.0.14206865"
if "%JAVA_HOME%"=="" set "JAVA_HOME=C:\Program Files\Java\jdk-17.0.1"
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
set "PATH=%USERPROFILE%\.cargo\bin;%ANDROID_NDK_HOME%\toolchains\llvm\prebuilt\windows-x86_64\bin;%PATH%"

REM ── 路径常量 ──────────────────────────────────────────────
set "PROJECT_ROOT=%~dp0"
set "FRONTEND_DIR=%PROJECT_ROOT%"
set "TAURI_DIR=%PROJECT_ROOT%src-tauri"
set "GEN_DIR=%TAURI_DIR%\gen\android"
set "SO_SOURCE=%PROJECT_ROOT%target\aarch64-linux-android\release\libventure_android_lib.so"
set "JNILIBS_DIR=%GEN_DIR%\app\src\main\jniLibs\arm64-v8a"
set "OUT_APK=%GEN_DIR%\app\build\outputs\apk\arm64\release\app-arm64-release-unsigned.apk"
set "FINAL_APK=%PROJECT_ROOT%Venture-release.apk"

echo ============================================================
echo  Venture Android APK Builder
echo ============================================================
echo.
echo [check] 环境:
echo   ANDROID_HOME = %ANDROID_HOME%
echo   JAVA_HOME    = %JAVA_HOME%
echo.

REM ── 步骤 1: 构建前端 ─────────────────────────────────────
echo [1/4] 构建前端...
cd /d "%FRONTEND_DIR%"
call npm run build:tauri
if %errorlevel% neq 0 (
    echo ERROR: 前端构建失败
    exit /b 1
)
echo   =^> 前端构建完成
echo.

REM ── 步骤 2: 编译 Rust → .so ──────────────────────────────
echo [2/4] 编译 Rust backend ^(aarch64-linux-android^)...
cd /d "%PROJECT_ROOT%"
cargo build --manifest-path "%TAURI_DIR%\Cargo.toml" --target aarch64-linux-android --lib --release
if %errorlevel% neq 0 (
    echo ERROR: Rust 编译失败
    exit /b 1
)
echo   =^> Rust 编译完成
echo.

REM ── 步骤 3: 复制前端 + .so ───────────────────────────────
echo [3/5] 复制前端和 .so 文件...
set "ASSETS_DIR=%GEN_DIR%\app\src\main\assets"
if not exist "%ASSETS_DIR%" mkdir "%ASSETS_DIR%"
if exist "%ASSETS_DIR%\*" del /q "%ASSETS_DIR%\*" 2>nul
xcopy /e /y "%PROJECT_ROOT%dist\web\*" "%ASSETS_DIR%\" >nul
if not exist "%ASSETS_DIR%\index.html" (
    echo ERROR: 前端复制失败 - index.html 不存在
    exit /b 1
)
echo   前端: OK
if not exist "%JNILIBS_DIR%" mkdir "%JNILIBS_DIR%"
copy /y "%SO_SOURCE%" "%JNILIBS_DIR%\" >nul
echo   .so: OK
echo   =^> 前端和 .so 已就绪
echo.

REM ── 步骤 4: Gradle 打包 APK ──────────────────────────────
echo [4/5] Gradle 打包 APK...
cd /d "%GEN_DIR%"
call gradlew.bat assembleRelease ^
    -x :app:rustBuildArm64Release ^
    -x :app:rustBuildArmRelease ^
    -x :app:rustBuildX86Release ^
    -x :app:rustBuildX86_64Release ^
    --no-daemon
if %errorlevel% neq 0 (
    echo ERROR: Gradle 打包失败
    exit /b 1
)

echo.
echo ============================================================
if exist "%OUT_APK%" (
    copy /y "%OUT_APK%" "%FINAL_APK%" >nul
    for %%A in ("%FINAL_APK%") do echo   APK 构建成功! 大小: %%~zA bytes
    echo   输出: %FINAL_APK%
) else (
    echo   APK 构建失败，请查看上方日志
    exit /b 1
)
echo ============================================================

endlocal
