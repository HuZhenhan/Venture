# Venture Android版构建打包说明文档

> 流程预览：拉取源码 → 环境配置 → 前端构建 → Rust 交叉编译 → Gradle 打包 → 签名

---

## 一、项目结构

```
Venture-Android\            ← Android 打包工程（本指南主角）
├── src\                    # 前端源码（React + Vite + MUI + Tailwind）
├── src-tauri\              # Tauri 壳（Rust侧）
│   ├── Cargo.toml          # venture-android crate（依赖 ../backend）
│   ├── build.rs            # 构建脚本（前端 assets 嵌入.so的关键）
│   ├── tauri.conf.json     # Tauri 配置（productName、版本、identifier）
│   ├── src\                # Rust 入口（tauri应用 + 后端集成）
│   └── gen\android\        # 注意：Tauri 生成的 Android 原生工程
│       └── app\
│           ├── tauri.properties   # 特别注意：versionCode / versionName 在这里
│           └── src\main\java\com\venture\app\MainActivity.kt  # 启动清缓存逻辑
├── backend\                # Rust后端（作为crate依赖被引用）
├── dist\web\               # 前端构建产物（vite build输出）
├── target\aarch64-linux-android\release\   # Rust 交叉编译产物
├── build-apk.cmd           # 一键打包脚本（UTF-8 编码，CMD 使用）
├── build-apk-gbk.cmd       # 一键脚本 GBK 编码版（中文乱码时用）
├── build-apk.sh            # 一键打包脚本（Git Bash 使用）
└── Venture-release-signed.apk  # 最终产物（签名后）

```

> 整个Android应用构成为：前端静态文件（assets）+ Rust 后端（`.so` 动态库）+ Tauri Android 原生壳。前端和 `.so` 会被分别打进 APK。

---

## 二、环境准备

| 组件 | 要求 | 用途 |
|------|------|------|
| Node.js + npm | ≥ 18（推荐 LTS） | 前端构建 |
| Rust 工具链 | stable（rustup 安装） | 编译后端 |
| JDK | **17** | Android 编译、apksigner |
| Android SDK | 含 platform-tools、build-tools 34~37 | gradle 打包、adb |
| Android NDK | r26+ | 交叉编译 clang |
| 交叉编译 target | `aarch64-linux-android` | cargo 编 .so |

### 1. Rust 安装与国内镜像（需要镜像提速）

```bash
# 安装 rustup（国内用镜像加速）
export RUSTUP_DIST_SERVER=https://rsproxy.cn
export RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup
# 或 Windows 下设置环境变量 RUSTUP_DIST_SERVER / RUSTUP_UPDATE_ROOT 后运行 rustup-init.exe

# 安装交叉编译 target
rustup target add aarch64-linux-android
```

### 2. 环境变量

脚本会自动检测，若未设置需手动配置：

```
ANDROID_HOME      = C:\Users\<用户>\AppData\Local\Android\Sdk
ANDROID_NDK_HOME  = <ANDROID_HOME>\ndk\<版本>   （脚本自动取最高版本）
JAVA_HOME         = C:\Users\<用户>\.jdks\jdk-17.x.x 或 C:\Program Files\Java\jdk-17*
```

### 3. Node 依赖

```bash
cd C:\path\to\Venture-Android
npm install
# Electron 相关下载慢时使用镜像提速：
#  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

---

## 三、一键构建（推荐）

### Windows CMD

```bat
cd C:\path\to\Venture-Android
build-apk.cmd                rem 完整构建 + 安装
build-apk.cmd --no-install   rem 仅打包不安装
build-apk.cmd --skip-front   rem 跳过前端构建（仅Rust变更时）
build-apk.cmd --skip-rust    rem 跳过Rust编译（仅前端变更时，注意**有风险**见第八节）
build-apk.cmd --clean        rem 清理后重新构建
```

> 中文乱码时使用 `build-apk-gbk.cmd`（两者逻辑一致）。

### Git Bash

```bash
cd /c/path/to/Venture-Android
bash build-apk.sh                # 参数同上
```

### 脚本做的六件事

| 步骤 | 动作 | 产物 |
|------|------|------|
| 1/6 | `npm run build:tauri`（vite build） | `dist\web\` |
| 2/6 | `touch build.rs` + `cargo build --target aarch64-linux-android --lib --release` | `target\...\libventure_android_lib.so` |
| 3/6 | 复制前端 → `gen\android\app\src\main\assets\`，复制 .so → `jniLibs\arm64-v8a\` | — |
| 4/6 | `gradlew assembleRelease -x :app:rustBuild* --no-daemon` | `app-arm64-release-unsigned.apk` |
| 5/6 | `apksigner sign`（debug.keystore） | `Venture-release-signed.apk` |
| 6/6 | `adb install -r` 覆盖安装 | 设备上运行 |

---

## 四、分步手动构建（与脚本对应，仅排查问题时用）

### 步骤 1：构建前端

```bash
cd C:\venture\Venture-Android
npm run build:tauri
# 产物: dist\web\index.html等静态文件
```

### 步骤 2：编译 Rust（aarch64-linux-android）

```bash
cd C:\venture\Venture-Android
set CC_aarch64_linux_android=<NDK>\toolchains\llvm\prebuilt\windows-x86_64\bin\aarch64-linux-android35-clang.cmd
set AR_aarch64_linux_android=<NDK>\toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-ar.exe

# 注意：必须 touch build.rs！否则 cargo 缓存跳过 build.rs，
#    前端 assets 不会重新嵌入 .so（详见第八节坑 3）
touch src-tauri\build.rs

cargo build --manifest-path src-tauri\Cargo.toml --target aarch64-linux-android --lib --release
# 产物: target\aarch64-linux-android\release\libventure_android_lib.so
```

> NDK 版本对应 clang 后缀：NDK r26+ 为`aarch64-linux-android35-clang`。脚本自动检测，手动执行时注意版本号。

### 步骤 3：复制产物

```bat
xcopy /e /y dist\web\* src-tauri\gen\android\app\src\main\assets\
copy /y target\aarch64-linux-android\release\libventure_android_lib.so src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a\
```

### 步骤 4：Gradle 打包

```bash
cd C:\venture\Venture-Android\src-tauri\gen\android
gradlew assembleRelease -x :app:rustBuildArm64Release -x :app:rustBuildArmRelease -x :app:rustBuildX86Release -x :app:rustBuildX86_64Release --no-daemon
# 产物: app\build\outputs\apk\arm64\release\app-arm64-release-unsigned.apk
```

> `-x :app:rustBuild*` 跳过 gradle 内嵌的 rust 编译任务——Rust 已在步骤 2 手动编好，避免 gradle 重复编译（慢且易失败）。

### 步骤 5：签名

```bash
apksigner sign --ks %USERPROFILE%\.android\debug.keystore --ks-pass pass:android --ks-key-alias androiddebugkey --key-pass pass:android --out Venture-release-signed.apk <unsigned.apk>
# 验证：
apksigner verify --print-certs Venture-release-signed.apk
```

### 步骤 6：ADB 安装

```bash
adb devices          # 确认设备在线（设备上需已授权 USB 调试）
adb install -r Venture-release-signed.apk
# 验证：
adb shell dumpsys package com.venture.app | findstr versionCode
```

> 由于默认使用了内部目录来储存所有数据，**务必使用 `-r` 覆盖安装**，禁止先 `adb uninstall` 再装（会清空应用数据）。

---

## 五、版本管理（注意哈）

**versionCode 位置**：`src-tauri\gen\android\app\tauri.properties`

```
tauri.android.versionCode=2030（版本号仅示例，实际为准）
tauri.android.versionName=2
```

**每次发版必须递增 versionCode**：

**前端刷新机制**：`MainActivity.kt` 用versionCode判断版本是否变化。若 versionCode 没变，**设备上会一直显示旧版前端**（WebView 缓存未清理），新功能就不会生效！！！！！！请以当前版本号 +1 递增，如 2030 → 2031。versionName 可随版本随意改。

---

## 六、一些注意事项
### 1.注意完整安装构建环境

### 2.禁止跳过 Rust 编译

`--skip-rust`只在校验过 `libventure_android_lib.so`确实是最新时才能用。前端或backend代码有改动而跳过编译导致设备上运行旧逻辑。**改动代码后必须全量构建**。

### 3.小心cargo 缓存导致.so内嵌旧前端

Tauri 会在 `build.rs` 编译期把前端 assets 嵌入 `.so`。若 Rust 源码没变，cargo 会**跳过 build.rs**，导致 .so 内嵌上次构建的旧前端。  
因此需要编译前 `touch src-tauri\build.rs`（强制 build.rs 重跑）。脚本已内置此步骤，手动构建时务必加上

### 4.versionCode需每次构建递增（见第五节）


### 5.命令找不到报错

- `apksigner 找不到`：检查 build-tools 版本目录（34/35/36/37 任一存在即可，脚本自动找最新的）
- `Rust找不到clang`：确认`ANDROID_NDK_HOME`正确，NDK bin 目录下有`aarch64-linux-android35-clang`（或 .cmd）

### 6.Gradle必须--no-daemon

daemon会缓存旧的构建配置，改过 gradle 配置/依赖后可能用旧配置打包。脚本已内置 `--no-daemon`。

---

## 常见问题

| 问题 | 解决方案 |
|------|----------|
| npm install 极慢 | 设置 ELECTRON_MIRROR / npmmirror 镜像 |
| cargo 拉依赖极慢 | 配置 RUSTUP_DIST_SERVER / crates 镜像（rsproxy.cn） |
| gradle 首次构建极慢 | 正常，需下载gradle发行版+依赖，后续有缓存 |
| 打包成功但设备上功能没变 | 检查 versionCode 是否递增（参见第五节）|
| 前端改了但 APK 里没生效 | 确认 dist\web 已重新 build 且 assets 已复制（步骤 1/3）|

---

## 八、完整打包流程

```bash
# 1. 拉取/更新源码
git pull   （或解压新源码包）

# 2. 安装依赖（首次或 package.json 变更时）
cd C:\path\to\Venture-Android
npm install

# 3. 改代码、递增 versionCode
#    编辑src-tauri\gen\android\app\tauri.properties:
#    tauri.android.versionCode=2031   注意每次+1！

# 4. 一键打包 + 安装
build-apk.cmd

# 5. 验证
adb shell dumpsys package com.venture.app | findstr versionCode
```
完成后产物：`C:\path\to\Venture-Android\Venture-release-signed.apk`  

**如果按照此说明，依旧构建失败，请附带报错信息提交issue**
