# Venture 源码构建与使用教程

本教程将指导你从解压源码开始，完成环境配置、依赖安装、项目构建和运行。

---

## 一、环境要求

| 环境 | 版本要求 | 用途 |
|------|----------|------|
| **Node.js** | 18.0 或更高 | 前端构建、Electron 桌面应用打包 |
| **npm** | 随 Node.js 自带 | 管理前端依赖 |
| **Rust** | 最新稳定版 | 编译后端服务 |
| **Windows** | 10/11 (x64) | 当前仅支持 Windows 平台 |

---

## 二、环境安装与下载

### 1. 安装 Node.js

Node.js 是运行前端构建工具的基础环境。

- **下载地址**：https://nodejs.org/
- **推荐版本**：选择 **LTS（长期支持）** 版本，确保 >= 18.0
- **安装方式**：下载 `.msi` 安装包，双击按提示一路 Next 即可。安装时建议勾选 "Add to PATH"。

安装完成后，打开 PowerShell 或 CMD 验证：

```bash
node -v    # 应输出 v18.x.x 或更高
npm -v     # 应输出对应的 npm 版本
```

> 如果你需要管理多个 Node.js 版本，推荐使用 [nvm-windows](https://github.com/coreybutler/nvm-windows)。

### 2. 安装 Rust

后端服务使用 Rust 编写，需要安装 Rust 工具链。

- **下载地址**：https://rustup.rs
- **安装方式**：下载并运行 `rustup-init.exe`，按提示选择默认安装（选项 1）即可。

安装完成后，**重新打开一个新的 PowerShell 窗口**，验证安装：

```bash
rustc --version    # 应输出 rustc 1.xx.x
cargo --version    # 应输出 cargo 1.xx.x
```

> Rust 安装时会自动下载 MSVC 构建工具。如果提示缺少 Visual Studio Build Tools，请安装 [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，并勾选 "Desktop development with C++" 工作负载。

### 3. 添加 Rust 交叉编译目标

项目构建脚本指定了 `x86_64-pc-windows-gnu` 目标，需要添加该 target：

```bash
rustup target add x86_64-pc-windows-gnu
```

> 如果你使用默认的 MSVC 工具链，也可以直接构建。项目脚本中指定了 `--target x86_64-pc-windows-gnu`，确保该 target 已安装即可。

---

## 三、解压源码

将 `Venture_源码.zip` 解压到你想要的目录，例如：

```
C:\Users\你的用户名\Desktop\Venture
```

解压后的目录结构大致如下：

```
Venture/
├── src/              # 前端 React 源码
├── backend/          # 后端 Rust 源码
├── electron/         # Electron 主进程
├── scripts/          # 构建脚本
├── package.json      # 前端依赖配置
├── vite.config.ts    # Vite 构建配置
└── ...
```

---

## 四、安装 Node.js 依赖

打开 PowerShell，进入项目根目录：

```bash
cd C:\Users\你的用户名\Desktop\Venture
```

执行依赖安装：

```bash
npm install
```

这一步会：
- 根据 `package.json` 下载所有前端依赖（React、Tailwind CSS、Electron 等）
- 生成 `node_modules/` 目录
- 生成 `package-lock.json` 锁定依赖版本

> **注意**：首次安装可能需要几分钟，取决于网络速度。如果下载 Electron 很慢，可以设置国内镜像：
>
> ```bash
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> npm install
> ```

安装成功后，你会看到 `node_modules` 文件夹出现在项目根目录。

---

## 五、构建项目

### 完整构建（推荐）

一条命令完成所有步骤（清理 → 编译后端 → 构建前端 → 打包桌面应用）：

```bash
npm run build
```

构建产物输出到 `dist/` 目录，包含：
- `dist/Venture-Setup-0.0.1.exe` — Windows 安装包
- `dist/Venture.exe` — 可直接运行的桌面应用
- `dist/web/` — 前端静态文件

### 分步构建

如果只想构建某一部分：

```bash
# 仅编译 Rust 后端
npm run build:backend

# 仅构建前端（Electron 模式）
npm run build:desktop-web

# 仅打包桌面应用
npm run build:desktop
```

### 构建便携版（免安装）

```bash
npm run build:portable
```

生成可直接运行、无需安装的便携版本。

### 构建安装包

```bash
npm run build:installer
```

生成 NSIS 安装包 `.exe` 文件。

---

## 六、运行项目

### 开发模式

同时启动前端、Electron 和后端（适合开发调试）：

```bash
npm run dev
```

这会：
1. 启动 Vite 开发服务器（端口 5174）
2. 启动 Rust 后端服务（端口 49527）
3. 启动 Electron 桌面窗口

### 单独运行各部分

```bash
# 仅启动前端开发服务器
npm run dev:web

# 仅启动后端
npm run dev:backend

# 仅启动 Electron（需先启动前端开发服务器）
npm run start
```

### 运行构建后的版本

```bash
# 直接运行打包好的应用
dist\Venture.exe

# 或运行安装程序
dist\Venture-Setup-0.0.1.exe
```

### Web 预览模式

```bash
npm run preview:web
```

在浏览器中访问 `http://127.0.0.1:4173` 预览前端页面。

---

## 七、常见问题

### Q: `npm install` 报错 "EACCES" 或权限不足？

以管理员身份运行 PowerShell，或检查目录权限。

### Q: 后端编译失败，提示找不到 `cc` 或链接器？

确保已安装 Visual Studio Build Tools 并勾选了 "Desktop development with C++"。

### Q: Electron 下载很慢或超时？

设置国内镜像后重新安装：

```bash
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

### Q: 运行 `npm run dev` 后端口被占用？

检查 5173、5174、49527 端口是否被其他程序占用，关闭占用程序或修改对应配置。

### Q: 构建产物在哪里？

所有构建产物都在 `dist/` 目录下：
- 安装包：`dist/Venture-Setup-0.0.1.exe`
- 便携版：`dist/Venture.exe`
- 前端文件：`dist/web/`

---

## 八、快速命令速查

```bash
# 1. 进入项目目录
cd C:\path\to\Venture

# 2. 安装依赖
npm install

# 3. 开发模式（前端 + 后端 + Electron）
npm run dev

# 4. 完整构建
npm run build

# 5. 运行构建后的应用
dist\Venture.exe
```

---

## 九、技术栈概览

| 层级 | 技术 |
|------|------|
| 前端 | React 18 + TypeScript + Tailwind CSS + Vite |
| 后端 | Rust + Axum + Tokio |
| 桌面 | Electron 37 + electron-builder |
| 状态管理 | Zustand |
| UI 组件 | shadcn/ui (Radix UI) |

---

如有问题，请查看项目根目录的 `README.md` 获取更多信息。
