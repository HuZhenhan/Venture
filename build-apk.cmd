@echo off
REM ============================================================
REM  Venture Android 一键打包+安装脚本 (Windows CMD)
REM  支持并行构建、自动签名、ADB 安装
REM
REM  用法:
REM    build-apk.cmd             完整构建+安装
REM    build-apk.cmd --no-install 仅打包不安装
REM    build-apk.cmd --skip-rust  跳过 Rust 编译
REM    build-apk.cmd --skip-front 跳过前端构建
REM    build-apk.cmd --clean      清理后重新构建
REM ============================================================
setlocal enabledelayedexpansion

REM ── 解析参数 ──────────────────────────────────────────────
set "SKIP_FRONT="
set "SKIP_RUST="
set "NO_INSTALL="
set "DO_CLEAN="

:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--skip-front"  set SKIP_FRONT=1
if /i "%~1"=="--skip-rust"   set SKIP_RUST=1
if /i "%~1"=="--no-install"  set NO_INSTALL=1
if /i "%~1"=="--clean"       set DO_CLEAN=1
if /i "%~1"=="--help" goto show_help
if /i "%~1"=="-h" goto show_help
shift
goto parse_args

:show_help
echo 用法: build-apk.cmd [选项]
echo   --skip-front   跳过前端构建
echo   --skip-rust    跳过 Rust 编译
echo   --no-install   仅打包 APK，不安装到设备
echo   --clean        先清理构建产物
endlocal
exit /b 0

:args_done

REM ── 环境自动检测 ──────────────────────────────────────────
if "%ANDROID_HOME%"=="" (
    if exist "%LOCALAPPDATA%\Android\Sdk" (
        set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
    )
)
if "%ANDROID_HOME%"=="" (
    echo [FAIL] ANDROID_HOME 未设置
    endlocal
    exit /b 1
)
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"

if "%ANDROID_NDK_HOME%"=="" (
    for /f "delims=" %%d in ('dir /b "%ANDROID_HOME%\ndk\" 2^>nul ^| sort /r') do (
        set "ANDROID_NDK_HOME=%ANDROID_HOME%\ndk\%%d"
        goto ndk_found
    )
)
:ndk_found

if "%JAVA_HOME%"=="" (
    if exist "C:\Program Files\Java\" (
        for /f "delims=" %%d in ('dir /b "C:\Program Files\Java\jdk-17*" 2^>nul') do (
            set "JAVA_HOME=C:\Program Files\Java\%%d"
            goto java_found
        )
    )
)
:java_found
if not exist "%JAVA_HOME%" (
    echo [FAIL] JAVA_HOME 无效: %JAVA_HOME%
    endlocal
    exit /b 1
)

REM NDK bin
set "NDK_BIN=%ANDROID_NDK_HOME%\toolchains\llvm\prebuilt\windows-x86_64\bin"
set "PATH=%USERPROFILE%\.cargo\bin;%NDK_BIN%;%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%ANDROID_HOME%\build-tools\36.0.0;%ANDROID_HOME%\build-tools\35.0.0;%ANDROID_HOME%\build-tools\34.0.0;%PATH%"

REM ── 路径常量 ──────────────────────────────────────────────
set "PROJECT_ROOT=%~dp0"
set "TAURI_DIR=%PROJECT_ROOT%src-tauri"
set "GEN_DIR=%TAURI_DIR%\gen\android"
set "SO_SOURCE=%PROJECT_ROOT%target\aarch64-linux-android\release\libventure_android_lib.so"
set "JNILIBS_DIR=%GEN_DIR%\app\src\main\jniLibs\arm64-v8a"
set "ASSETS_DIR=%GEN_DIR%\app\src\main\assets"
set "OUT_APK=%GEN_DIR%\app\build\outputs\apk\arm64\release\app-arm64-release-unsigned.apk"
set "FINAL_APK=%PROJECT_ROOT%Venture-release-signed.apk"

echo.
echo ============================================================
echo  Venture Android 一键打包+安装脚本
echo ============================================================
echo.
echo [环境]
echo   ANDROID_HOME = %ANDROID_HOME%
echo   ANDROID_NDK  = %ANDROID_NDK_HOME%
echo   JAVA_HOME    = %JAVA_HOME%
echo.

REM ── 清理 ──────────────────────────────────────────────────
if defined DO_CLEAN (
    echo [INFO] 清理构建产物...
    if exist "%PROJECT_ROOT%dist\web" rmdir /s /q "%PROJECT_ROOT%dist\web"
    if exist "%GEN_DIR%\app\build" rmdir /s /q "%GEN_DIR%\app\build"
)

REM ── CMD 不支持并行，改用顺序执行 ──────────────────────────

REM ── 步骤 1: 构建前端 ─────────────────────────────────────
if defined SKIP_FRONT (
    if exist "%PROJECT_ROOT%dist\web\index.html" (
        echo [WARN] 跳过前端构建
    ) else (
        echo [FAIL] --skip-front 但前端产物不存在
        endlocal & exit /b 1
    )
) else (
    echo [1/5] 构建前端...
    cd /d "%PROJECT_ROOT%"
    call npm run build:tauri
    if !errorlevel! neq 0 (
        echo [FAIL] 前端构建失败
        endlocal & exit /b 1
    )
    echo   =^> OK
)

REM ── 步骤 2: 编译 Rust → .so ──────────────────────────────
if defined SKIP_RUST (
    if exist "%SO_SOURCE%" (
        echo [WARN] 跳过 Rust 编译
    ) else (
        echo [FAIL] --skip-rust 但 .so 不存在
        endlocal & exit /b 1
    )
) else (
    echo [2/5] 编译 Rust (aarch64-linux-android)...
    cd /d "%PROJECT_ROOT%"
    set "CC_aarch64_linux_android=%NDK_BIN%\aarch64-linux-android35-clang.cmd"
    set "AR_aarch64_linux_android=%NDK_BIN%\llvm-ar.exe"
    cargo build --manifest-path "%TAURI_DIR%\Cargo.toml" --target aarch64-linux-android --lib --release
    if !errorlevel! neq 0 (
        echo [FAIL] Rust 编译失败
        endlocal & exit /b 1
    )
    echo   =^> OK
)

REM ── 步骤 3: 复制产物 ─────────────────────────────────────
echo [3/5] 复制产物到 Android 项目...
if not exist "%ASSETS_DIR%" mkdir "%ASSETS_DIR%"
if exist "%ASSETS_DIR%\*" del /q "%ASSETS_DIR%\*" 2>nul
xcopy /e /y "%PROJECT_ROOT%dist\web\*" "%ASSETS_DIR%\" >nul
if not exist "%ASSETS_DIR%\index.html" (
    echo [FAIL] 前端复制失败
    endlocal & exit /b 1
)
if not exist "%JNILIBS_DIR%" mkdir "%JNILIBS_DIR%"
copy /y "%SO_SOURCE%" "%JNILIBS_DIR%\" >nul
echo   前端 + .so =^> OK

REM ── 步骤 4: Gradle 打包 ──────────────────────────────────
echo [4/5] Gradle assembleRelease...
cd /d "%GEN_DIR%"
call gradlew.bat assembleRelease ^
    -x :app:rustBuildArm64Release ^
    -x :app:rustBuildArmRelease ^
    -x :app:rustBuildX86Release ^
    -x :app:rustBuildX86_64Release ^
    --no-daemon
if !errorlevel! neq 0 (
    echo [FAIL] Gradle 打包失败
    endlocal & exit /b 1
)
if not exist "%OUT_APK%" (
    echo [FAIL] APK 未生成
    endlocal & exit /b 1
)
echo   =^> APK 构建成功

REM ── 步骤 5: 签名 ──────────────────────────────────────────
echo [5/5] 签名 APK...
set "DEBUG_KS=%USERPROFILE%\.android\debug.keystore"
if not exist "%DEBUG_KS%" (
    echo [FAIL] 找不到 debug.keystore
    endlocal & exit /b 1
)

REM 查找 apksigner.bat
set "APKSIGNER="
for /f "delims=" %%d in ('dir /b "%ANDROID_HOME%\build-tools\" 2^>nul') do (
    if exist "%ANDROID_HOME%\build-tools\%%d\apksigner.bat" set "APKSIGNER=%ANDROID_HOME%\build-tools\%%d\apksigner.bat"
)
if "%APKSIGNER%"=="" (
    echo [FAIL] 找不到 apksigner.bat
    endlocal & exit /b 1
)

"%APKSIGNER%" sign --ks "%DEBUG_KS%" --ks-pass pass:android --ks-key-alias androiddebugkey --key-pass pass:android --out "%FINAL_APK%" "%OUT_APK%" 2>nul
if not exist "%FINAL_APK%" (
    echo [FAIL] 签名失败
    endlocal & exit /b 1
)
echo   =^> 签名完成

REM ── 步骤 6: ADB 安装 ─────────────────────────────────────
if not defined NO_INSTALL (
    echo.
    echo [6/6] ADB 安装...
    adb devices 2>nul | findstr "device$" >nul
    if !errorlevel! neq 0 (
        echo [WARN] 未检测到 ADB 设备，跳过安装
        echo   APK 位于: %FINAL_APK%
    ) else (
        adb uninstall com.venture.app 2>nul
        adb install "%FINAL_APK%"
        if !errorlevel! equ 0 (
            echo [OK] 安装完成!
        ) else (
            echo [FAIL] 安装失败
        )
    )
)

echo.
echo ============================================================
echo  全部完成!
echo  APK: %FINAL_APK%
echo ============================================================
echo.

endlocal
