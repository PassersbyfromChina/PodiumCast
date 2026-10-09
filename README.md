# PodiumCast

**多平台摄像头投屏与拍摄控制套件。** 一个摄像头，两个预览，可选两个存储。

> **本项目由 AI 编写（AI-generated project）。** 从协议设计、核心逻辑、界面、Electron 与 Capacitor 外壳到构建脚本与本文档，全部由 AI 生成，由人类维护者负责审阅、发布与问题处理。请据此评估它在你的生产环境中的适用性。

仓库：<https://github.com/PassersbyfromChina/PodiumCast>
落地页（GitHub Pages）：<https://passersbyfromchina.github.io/PodiumCast/>

**目录**

- [PodiumCast 是什么](#podiumcast-是什么)
- [下载](#下载)
- [两个应用](#两个应用)
- [功能](#功能)
  - [启动配置](#启动配置)
  - [界面](#界面)
  - [拍摄与回放](#拍摄与回放)
  - [存储与互传](#存储与互传)
  - [无摄像头时的测试画面](#无摄像头时的测试画面)
  - [快捷键](#快捷键)
- [连接方式](#连接方式)
- [截图与界面说明](#截图与界面说明)
- [目录结构](#目录结构)
- [构建](#构建)
- [架构](#架构)
- [已知限制](#已知限制)
- [隐私](#隐私)
- [许可与致谢](#许可与致谢)

## PodiumCast 是什么

PodiumCast 把「一块摄像头」拆成两个角色：

- **PodiumCast-Cast（拍摄端）** 独占摄像头。它显示实时预览、拍照、录制视频、回放素材，并持续把预览画面推给大屏端。
- **PodiumCast-Stage（大屏端）** 在同一局域网内显示同一路实时预览，并且**可以选择性地远程操控拍摄端**：快门、录制、变焦、回放。

两个角色由同一个 TypeScript 代码库构建而成，共享协议、录制规格协商、会话状态机与界面组件；区别只在宿主编译目标（桌面 / Android）与运行时扮演的角色。

视频文件**默认保存在拍摄端**。你也可以改成只存大屏端，或者两端都存；任意一端都能从对端「互相拉取」文件。

这是一套为**现场演示、课堂教学、直播间、会议投屏**准备的轻量工具：不需要云服务、不需要账号、不需要外网，两台设备之间一条本地链路就够。

再次强调：**本项目由 AI 编写**。它被真实构建、真实打包、真实跑过端到端冒烟测试，但请把它当成一个来源透明的开源工具来对待。

## 下载

全部 10 个产物都附在 GitHub Releases 上（[最新发布页](https://github.com/PassersbyfromChina/PodiumCast/releases/latest)）：

| 平台 | 拍摄端（Cast） | 大屏端（Stage） |
| --- | --- | --- |
| Windows x64 | [PodiumCast-Cast-x64-installer.exe](https://github.com/PassersbyfromChina/PodiumCast/releases/latest/download/PodiumCast-Cast-x64-installer.exe) | [PodiumCast-Stage-x64-installer.exe](https://github.com/PassersbyfromChina/PodiumCast/releases/latest/download/PodiumCast-Stage-x64-installer.exe) |
| Windows x86 | [PodiumCast-Cast-x32-installer.exe](https://github.com/PassersbyfromChina/PodiumCast/releases/latest/download/PodiumCast-Cast-x32-installer.exe) | [PodiumCast-Stage-x32-installer.exe](https://github.com/PassersbyfromChina/PodiumCast/releases/latest/download/PodiumCast-Stage-x32-installer.exe) |
| Windows ARM64 | [PodiumCast-Cast-arm-installer.exe](https://github.com/PassersbyfromChina/PodiumCast/releases/latest/download/PodiumCast-Cast-arm-installer.exe) | [PodiumCast-Stage-arm-installer.exe](https://github.com/PassersbyfromChina/PodiumCast/releases/latest/download/PodiumCast-Stage-arm-installer.exe) |
| macOS（universal：x64 + arm64） | [PodiumCast-Cast-macos-installer.dmg](https://github.com/PassersbyfromChina/PodiumCast/releases/latest/download/PodiumCast-Cast-macos-installer.dmg) | [PodiumCast-Stage-macos-installer.dmg](https://github.com/PassersbyfromChina/PodiumCast/releases/latest/download/PodiumCast-Stage-macos-installer.dmg) |
| Android | [PodiumCast-Cast.apk](https://github.com/PassersbyfromChina/PodiumCast/releases/latest/download/PodiumCast-Cast.apk) | [PodiumCast-Stage.apk](https://github.com/PassersbyfromChina/PodiumCast/releases/latest/download/PodiumCast-Stage.apk) |

产物清单：

- `PodiumCast-Cast-x64-installer.exe`
- `PodiumCast-Cast-x32-installer.exe`
- `PodiumCast-Cast-arm-installer.exe`
- `PodiumCast-Cast-macos-installer.dmg`
- `PodiumCast-Cast.apk`
- `PodiumCast-Stage-x64-installer.exe`
- `PodiumCast-Stage-x32-installer.exe`
- `PodiumCast-Stage-arm-installer.exe`
- `PodiumCast-Stage-macos-installer.dmg`
- `PodiumCast-Stage.apk`

所有历史版本与发布说明见 [Releases 页面](https://github.com/PassersbyfromChina/PodiumCast/releases)。仓库根目录的 `index.html` 是同一份下载入口的网页版（亮 / 暗主题，直接指向 Release 下载），已发布到 <https://passersbyfromchina.github.io/PodiumCast/>；想在本地看，可以用 `npm run serve:pages`（默认 <http://127.0.0.1:8788/>）。

## 两个应用

### PodiumCast-Cast（拍摄端）

- 打开时枚举本机可用的录制规格：色域 / 清晰度 / 比例 / 帧率，供你和 Stage 协商。
- 独占摄像头，显示实时预览，并把这路预览持续推给已连接的大屏端。
- 拍照、录制视频、回放照片与视频。
- 录制过程中可以变焦。
- 接收并执行 Stage 发来的远程指令：快门、录制、变焦、回放。
- 素材默认存在本机；按设置也可以推给大屏端，或从大屏端拉取。
- 横屏布局，黑色背景；预览外的黑边用来放读数与按键（见「截图与界面说明」）。
- 运行 `adb reverse`，让 Android 大屏端能通过 USB 连上它（桌面端才做这件事）。

### PodiumCast-Stage（大屏端）

- 显示 Cast 推来的同一路实时预览，全屏铺满大屏。
- 默认把所有操控**隐藏成左下角与右下角两个小图标**，点开才展开抽屉，不挡画面。
- 可以选择性地远程驱动 Cast：快门、录制、变焦、回放。
- 可以自己拍照、录制（此时媒体落在 Stage 上），也可以按设置接收 Cast 推送过来的录像文件。
- 可以从 Cast 的拍摄库里拉取文件到本机。
- 打开时读取并上报自己的大屏规格（比例、分辨率、帧率、色域），参与比例匹配。
- 找不到 Cast 时，用 UDP 广播（端口 8766）自动发现，或扫描自己所在网段的 8765。

两个角色可以跑在同一台设备上（Stage 连 `127.0.0.1:8765`），也可以分处两台设备（局域网 / USB / 手动输入地址）。

## 功能

### 启动配置

- **Cast 打开时**枚举本机可用的录制规格：色域、清晰度、比例、帧率。这是它能提供的全部拍摄能力。
- **Stage 打开时**读取自己这块大屏的规格：比例、分辨率、帧率、色域。
- **首次连接大屏时，自动匹配与大屏相同或最接近的拍摄比例**——实现是 `packages/core/src/specs.ts` 里的 `matchSpec()`。
- 匹配结果与**匹配理由**（为什么选它、差在哪里）会在两端同时显示，方便你手动改选。
- 预览推流的分辨率 / 帧率 / 画质都可以在设置里调整：宽度 640 / 960 / 1280 / 1920，帧率 10–30fps，画质 低 / 标准 / 高 / 最高。
- Android 默认建议 960px / 15fps：Capacitor 桥接以 base64 传输预览帧，比 Electron 的结构化克隆更贵，压低一档更稳。

### 界面

- 黑色背景、无复杂动画——为长时间点亮的大屏和现场环境准备。
- **Cast 横屏**。录制比例与屏幕比例不一致时，画面两侧（或上下）会出现黑边；帧率 / 分辨率读数、操控按键、设置按钮都放在**预览外的黑边里**，不遮挡构图。
- **按键行数 / 列数由黑边宽度自动推导**：`computeLetterbox()` 算出黑边可用尺寸并写进 CSS 变量 `--bar-slots`，布局据此决定每条边排几个键。
- 用户可以在设置里选择三种排布：「按键在左右」/「按键在上下」/「悬浮在画面上」。
- 比例**完全匹配**时没有黑边，此时控件默认悬浮在画面上。
- **Stage 把所有操控隐藏为左下角与右下角两个小图标**，点开才展开抽屉；合上时画面是干净的。

### 拍摄与回放

- 两端实时预览同一路画面。
- **任意一端都能拍照 / 录像**：Cast 用自己的摄像头，Stage 通过远端指令驱动 Cast，或把媒体落在自己这边。
- **录制过程中可变焦**，不用停下来重新开始。
- 回放照片与视频。
- **回放时可放大**：滚轮 / 双指 / 按钮，范围 1–8×。
- **回放时可改变倍速**：0.25 / 0.5 / 1 / 1.5 / 2 / 4×。

### 存储与互传

- 默认：**视频文件保存在拍摄端**。
- 可选「仅大屏端」或「两端都存」；选择后，录制结束会自动把文件推送到已连接的大屏端（`CastSession.pushFile()`）。
- 也可以在拍摄库里手动**「拉取到本机」**，方向是**双向**的：Stage 从 Cast 拉，Cast 从 Stage 拉。
- 传输走同一条 WebSocket 的二进制通道，分块进行，4 GB 的文件也不会撑爆内存（见「架构」）。
- 存储位置：
  - **Windows / macOS** 默认写入系统「视频」目录下的 `PodiumCast`（即 Windows 的 `视频\PodiumCast`，macOS 的 `Movies/PodiumCast`），其中 `photos/` 放照片、`videos/` 放录像，另有 `.podiumcast-index.json` 记录元数据；可以在设置里改。
  - **Android** 写入应用专属外部存储 `Android/data/<包名>/files/PodiumCast`，**无需任何存储权限**。

### 无摄像头时的测试画面

- **没有摄像头时，Cast 输出测试画面**：彩条 + 移动圆环 + 分辨率 / 计时文字。
- 这样即使机器上没有摄像头，也能完成握手、比例匹配、预览推流，并让 CI 冒烟测试跑通全流程。

### 快捷键

| 场景 | 键 | 作用 |
| --- | --- | --- |
| Cast | `P` | 拍照 |
| Cast | `R` | 开始 / 停止录像 |
| Cast | `L` | 拍摄库 |
| Cast | `S` | 设置 |
| Cast | `F` | 全屏 |
| Stage | `P` | 远端拍照 |
| Stage | `R` | 远端录像 |
| Stage | `L` | 远端拍摄库 |
| Stage | `C` | 连接对话框 |
| Stage | `F` | 全屏 |
| Stage | `↑` / `↓` | 变焦 |
| 回放中 | `空格` | 播放 / 暂停 |
| 回放中 | `←` / `→` | 后退 / 前进 5 秒 |
| 回放中 | `+` / `-` | 缩放（1–8×） |
| 回放中 | `0` | 缩放复位 |
| 回放中 | `Esc` | 关闭回放 |

## 连接方式

**Cast 永远是 WebSocket 服务端，Stage 永远是客户端。** 这条规则在四种连接方式下都不变，因此协议只有一份。

| 方式 | 适用场景 | 说明 |
| --- | --- | --- |
| 本机（同一台设备） | 一台机器上同时开两个应用，做演示或自测 | Stage 直接连 `127.0.0.1:8765` |
| 局域网 | 手机拍、电脑 / 大屏显示，或两台电脑 | 桌面 Cast 每秒在 UDP **8766** 端口广播一次信标；Stage 收到就能拿到地址。若 Stage 打不开 UDP socket（Android WebView），则改为扫描自己所在的 /24 网段，找出开放 8765 的主机 |
| USB | 现场没有可用的 Wi-Fi，或网络不稳 | 桌面 Cast 执行 `adb reverse tcp:8765 tcp:8765`，Android Stage 于是能在自己的 `127.0.0.1:8765` 上够到它——局域网那套代码路径原样复用，一行不改 |
| 手动输入地址 | 任何自动发现都失效时的兜底 | 连接对话框里始终可以手填 `主机:端口` |

端口与版本：

| 项目 | 值 |
| --- | --- |
| Cast 默认端口 | `8765` |
| 发现（UDP 信标）端口 | `8766` |
| 协议版本 | `1` |

补充说明：

- 一台设备上同时跑 Cast 与 Stage 是支持的，「本机」就是为这个场景准备的。
- 「本机」场景目前同样走回环 socket，协议与局域网完全一致（原因见「已知限制」）。
- USB 方式需要 `adb` 在 PATH 里；这是桌面 Cast 主动做的事，Android 端不需要 root，也不需要额外权限。

## 截图与界面说明

仓库里**没有截图**（也不打算放占位图）。下面是两端的布局规则，用文字和 ASCII 草图说明。

### Cast：黑边分槽布局

Cast 固定横屏。预览按录制比例等比缩放后居中，剩下的区域就是黑边。黑边不是浪费——它是控制区：

1. `computeLetterbox()` 先算出预览的可用尺寸与四条黑边的实际宽度。
2. 黑边宽度换算成「槽位」数量，写进 CSS 变量 `--bar-slots`。
3. 按键的行数 / 列数**由黑边宽度自动推导**：黑边窄就少排几个，黑边宽就多排几个，不需要为每种比例手写布局。

三种排布可在设置里切换（`split-h` / `split-v` / `overlay`）：

```text
split-h（按键在左右）        split-v（按键在上下）        overlay（悬浮在画面上）

┌────┬──────────────┬────┐   ┌────────────────────────┐   ┌────────────────────────┐
│ ▶  │              │ ⚙  │   │  ▶   ●   ⏺   ⚙   ⤢    │   │        ·  ●  ⏺  ·     │
│ ●  │    预览      │ ⤢  │   ├────────────────────────┤   │   ┌──────────────┐   │
│ ⏺  │  （等比居中）│ ⏱  │   │                        │   │   │    预览      │   │
│ 12 │              │1080│   │    预览（等比居中）    │   │   │  等比居中    │   │
│ 0p │              │ p  │   │                        │   │   └──────────────┘   │
│    │              │    │   ├────────────────────────┤   │   ▶   ●  ⏺   ⚙   ⤢   │
└────┴──────────────┴────┘   └────────────────────────┘   └────────────────────────┘
  黑边放按键与读数              黑边放按键与读数            无黑边时控件悬浮画面
```

- 比例完全匹配、没有黑边时，控件自然落到 `overlay` 形态，悬浮在画面上。
- 读数（帧率 / 分辨率、录制比例）和设置按钮与按键共用这些槽位。

### Stage：两角抽屉

Stage 默认**什么都不显示**，只有两个小图标：

```text
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│                                                                │
│                  实时预览（铺满整块大屏）                      │
│                                                                │
│                                                                │
│  ▣                                                          ▣  │
│ 左下角小图标                                          右下角小图标│
└────────────────────────────────────────────────────────────────┘
        │ 点开                                    │ 点开
        ▼                                         ▼

┌───────────────────────┐                 ┌───────────────────────┐
│ 拍摄                   │                 │ ⤢ 全屏                │
│  ● 拍照   ⏺ 录像       │                 │ 🔍 变焦 − / +         │
│  ▶ 回放   📁 拍摄库    │                 │ ⚙ 设置                │
│                        │                 │ 🔗 连接 / 断开        │
└───────────────────────┘                 └───────────────────────┘
   左下抽屉：拍摄与素材                        右下抽屉：显示与连接
```

合上抽屉时，大屏上只剩画面本身；需要操作时点开对应角落即可，不需要在观众面前翻菜单。

## 目录结构

```text
packages/core/    平台无关的协议、录制规格协商、会话状态机（CastSession / StageSession）、文件分块传输
  src/protocol.ts      Wire protocol: text = JSON control messages, binary = media frames
  src/specs.ts         Recording-spec enumeration + display matching
  src/session/         cast-session.ts, stage-session.ts
  src/node/            Node-only transports (ws + node:dgram) and the filesystem media store
packages/ui/      两个应用共用的界面（TypeScript + 手写 CSS，无框架）
  src/cast.ts, src/stage.ts, src/camera.ts, src/playback.ts, src/panels.ts, src/dom.ts, src/styles.css
  src/platform/       Host channel: electron-channel.ts / capacitor-channel.ts / bridges.ts
apps/desktop/     Electron 外壳（同一份 main 进程代码按角色打两个包）
  src/main.ts, src/preload.ts
apps/android/     Capacitor 外壳 + 两个原生 Java 插件
  android/app/src/main/java/io/github/passersbyfromchina/podiumcast/
    PodiumCastLanPlugin.java    内嵌 WebSocket 服务端（Java-WebSocket）+ UDP 发现 + 设备信息
    PodiumCastStorePlugin.java  RandomAccessFile 追加式媒体存储，支持真正的区间读取
    MainActivity.java           显式注册两个插件
scripts/          构建与工具脚本（build-windows.mjs / build-android.mjs / build-macos.mjs / smoke-test.mjs …）
scripts/toolchain/bootstrap-android.ps1   在无 Java/无 Android SDK 的机器上装好便携工具链
.github/workflows/build.yml               CI：三平台构建 + 发布
index.html        GitHub Pages 落地页（亮/暗主题，指向 Release 下载）
```

## 构建

### 环境要求

- **Node.js ≥ 20** 与 **npm**。
- Windows 安装包需要 Windows；Android APK 需要 Java 与 Android SDK（下面有一键引导）；macOS 的 dmg 只能在 macOS 上打。

### 安装

```bash
npm install
```

### npm 脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev:cast` | Electron 开发模式，跑拍摄端；UI 改动热重建 |
| `npm run dev:stage` | Electron 开发模式，跑大屏端；UI 改动热重建 |
| `npm run build:web` | 只打包两端网页资源 |
| `npm run build:desktop` | Electron 主进程 / 预加载 / 渲染层 |
| `npm run build:windows` | 六个 Windows 安装包 → `交付物/` |
| `npm run build:android` | 两个 APK → `交付物/` |
| `npm run build:macos` | 两个 dmg（**只能在 macOS 上运行**） |
| `npm run build` | 按当前平台尽可能多地构建 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run smoke` | 19 项端到端断言：握手、比例匹配、远端指令、预览帧、700 KiB 文件分块互传、心跳 |
| `npm run verify:ui` | 27 项界面验证：用 CDP 驱动真实 Electron 窗口，断言布局/角标抽屉/预览像素，并把截图写到 `.podiumcast-out/shots/` |
| `npm run serve:pages` | 本地预览 `index.html`，<http://127.0.0.1:8788/> |
| `npm run clean` | 清理构建产物 |

`npm run verify:ui` 会带上 `PODIUMCAST_FORCE_TEST_PATTERN=1`，让拍摄端忽略硬件摄像头、改画测试画面 —— 否则在构建机上「预览到底有没有出画面」是无法判断的（摄像头可能不存在，也可能对着黑屋子）。想在本地手动进入这个模式，设置同名环境变量即可。

### Android 工具链引导

在一台**没有 Java、也没有 Android SDK** 的机器上：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/toolchain/bootstrap-android.ps1
```

它会：

- 下载便携版 Temurin JDK 21 与 Android command-line SDK（platform 35/36、build-tools 35/36）；
- 全部放进 `~/.podiumcast-tools`；
- 写出 `env.txt`，`build-android.mjs` 会自动读取。

APK 用构建脚本首次运行时生成的**自签名密钥**签名：这是 debug 级别的签名，Android 会弹出「未知开发者」提示。Play 商店用的密钥绝不应该放进仓库。

### macOS 说明

- dmg **无法在非 macOS 上构建**：需要 `hdiutil` / `codesign`，所以本地只在 macOS 上跑 `npm run build:macos`。
- `.github/workflows/build.yml` 用 `macos-14` runner 来产出这两个 dmg。
- 两个角色都编译为 **universal** 二进制（x64 + arm64），所以每个角色只有一个 dmg。

### CI

`.github/workflows/build.yml` 在 `windows-latest` / `macos-14` / `ubuntu-latest` 上构建，并把 **10 个产物**发布到 GitHub Release。

## 架构

### 单一 TypeScript 代码库

- `packages/core` 是平台无关的纯逻辑：协议、录制规格协商、会话状态机、文件分块传输。
- `packages/ui` 是两端共用的界面（TypeScript + 手写 CSS，无框架）。
- Electron 把**同一份 main 进程代码打包两次**，用 `extraMetadata.podiumcastRole` 区分角色；Android 用 Gradle product flavour 一次构建产出两个 APK。

### 平台接缝

浏览器既不能监听 TCP 端口，也不能开 UDP socket，所以「服务端 + 发现 + 文件系统」这三项能力必须由宿主提供：

- 桌面宿主是 Node：`ws` + `node:dgram`，配合文件系统媒体存储（`packages/core/src/node/`）。
- Android 宿主是两个 Java 插件：`PodiumCastLanPlugin.java`（内嵌 WebSocket 服务端 + UDP 发现）与 `PodiumCastStorePlugin.java`（追加式媒体存储，支持真正的区间读取）。

全部接口定义在 `packages/core/src/bridge.ts`。上层逻辑只认这个接口，不认平台。

### 二进制分帧

- **文本帧**是 JSON 控制消息。
- **二进制帧**的首字节区分用途：`0x01` = 预览 JPEG，`0x02` = 文件分块。
- 单帧上限 **256 KiB**；发送时按 8 块一次做背压等待（等对端确认再继续），因此 **4 GB 的文件也不会撑爆内存**。

### 安全

- Electron 保持 `contextIsolation`。
- `apps/desktop/src/preload.ts` 只暴露两个函数：`request(op, payload)` 与 `onEvent(cb)`。
- 主进程对每个 `op` 做白名单校验，不认识的直接拒绝。
- 网页层有 CSP。

## 已知限制

- **同机零拷贝通道尚未实现。** `说明\连接方式.xlsx` 里提到的 Binder + Ashmem、共享内存 + 命名事件、Mach 端口这三种同机零拷贝方案都还没有落地。当前所有「本机」场景都走**回环 socket**，协议与局域网完全一致。好处是只有一条代码路径，代价是同机转发多一次拷贝；共享内存快路径是后续优化项，不是已交付能力。
- **Windows 安装包与 APK 未经签名认证。** Windows 上会出现 SmartScreen 提示；macOS 上未做公证（notarization），Gatekeeper 会拦下 dmg，需要手动放行。Android APK 用仓库内首次构建生成的自签名密钥签名，会触发「未知开发者」提示。请自行判断是否信任并安装。
- **`.dmg` 由 CI 产出，而不是本地。** 不能在非 macOS 机器上构建，所以本地 `npm run build:macos` 只在 macOS 上可行，其余情况请下载 Release 里由 `macos-14` runner 打出的文件。
- **Android 端预览走 base64 桥接，代价更高。** Capacitor 桥接以 base64 传输预览帧，比 Electron 的结构化克隆更贵，所以 Android 默认建议 960px / 15fps。把分辨率或帧率拉满可能掉帧。
- **局域网链路没有加密。** 数据在你自己搭的本地链路上以明文 WebSocket 传输，任何能接入同一网段的人都可能看到预览帧与文件。不要在不可信网络上使用。
- **发现机制依赖 UDP 广播。** 部分企业 Wi-Fi / 交换机（AP 隔离、组播抑制）会拦截广播；此时请用 USB 或手动输入地址。
- **没有截图、没有安装包校验和。** 仓库不附带截图（见「截图与界面说明」），也没有发布校验和文件；Release 页面上的文件就是全部。
- 本项目由 AI 编写，可能仍有未被发现的问题。遇到异常请开 issue。

## 隐私

- **没有遥测。** 不收集、不上报任何使用数据。
- **没有云端。** 除了你自己建立的那条本地链路（回环 / 局域网 / USB），应用不访问网络。
- **不登录、不注册、不需要账号。**
- **摄像头与麦克风只在拍摄时使用**：预览、拍照、录像期间才会打开；停止后即释放。
- **素材留在你自己的设备上。** 文件写到上面「存储与互传」里说的目录；跨设备传输只发生在你主动连接的两端之间，不经过任何服务器。
- **没有第三方分析 SDK。**

## 许可与致谢

- 本项目以 **MIT 许可证**发布，详见仓库根目录的 `LICENSE` 文件。
- **本项目由 AI 编写（AI-generated project）**：代码与文档由 AI 生成，人类维护者负责审阅、构建、发布与响应 issue。再次提醒你据此评估风险。
- 致谢依赖的开源项目：
  - **Electron** —— 桌面端外壳（Cast / Stage 的 Windows 与 macOS 安装包）。
  - **Capacitor**（MIT）—— Android 外壳，以及网页层与原生插件之间的桥。
  - **Java-WebSocket**（MIT）—— `PodiumCastLanPlugin.java` 里内嵌的 WebSocket 服务端。
  - 其余依赖见 `package.json`。

问题与建议请提到 <https://github.com/PassersbyfromChina/PodiumCast/issues>。
