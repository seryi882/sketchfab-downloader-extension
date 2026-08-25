# Sketchfab Public Downloader

**v1.0**

**Language / Язык / 语言：** [English](README.md) | [Русский](README.ru.md) | **简体中文**

这是一个 Chrome Manifest V3 扩展，可将 Sketchfab **公共 3D 模型**下载为包含 **glTF (`.glb`)** 的 ZIP 文件。无需 Sketchfab 账号、登录或 API 令牌。

即使模型没有官方的 Download 按钮也能使用。

界面支持**英文、俄文和简体中文**，并提供浅色与深色主题。

项目地址：https://github.com/seryi882/sketchfab-downloader-extension

---

## v1.0 功能

| 功能 | 说明 |
|---|---|
| 公共模型 | 从公共查看器获取网格和可选纹理 |
| glTF 输出 | 生成带 PBR 材质的 `.glb`（Blender：文件 → 导入 → glTF 2.0） |
| 纹理 | 可选，默认关闭。使用查看器中的 `pk` 密钥还原受保护的贴图 |
| 设置 | 主题、语言、归档类型和纹理尺寸立即生效；纹理和开发者模式需点击**应用设置** |
| 两套一致的界面 | 扩展弹窗和模型页面上的浮动 **⬇** 面板 |
| 批量下载 | 在专用页面中粘贴多个公共模型链接 |
| 大型模型 | 在离屏工作进程中执行解密、纹理还原和 ZIP 打包（支持 2K–8K 纹理包） |
| 开发者模式 | 在界面中显示详细日志，并将 `download-log.txt` 加入 ZIP |

---

## 安装（开发者模式）

1. 从 [Releases](https://github.com/seryi882/sketchfab-downloader-extension/releases) 下载 **v1.0** 源代码，或克隆仓库：

   ```bash
   git clone https://github.com/seryi882/sketchfab-downloader-extension.git
   cd sketchfab-downloader-extension
   ```

2. 在 Chrome 中打开 `chrome://extensions`。
3. 开启**开发者模式**。
4. 点击**加载已解压的扩展程序**，选择此项目文件夹。
5. 每次重新加载扩展后，请刷新 Sketchfab 模型页面（`Ctrl+F5`）。

---

## 下载模型

1. 打开一个 Sketchfab **公共模型**页面。
2. 在扩展弹窗或浮动 ⬇ 面板中打开**设置**。
3. 如需贴图，请开启**下载纹理**并点击**应用设置**；关闭纹理可更快地获得仅含网格的 ZIP。
4. 主题、语言、归档类型和纹理尺寸会在修改后立即生效。
5. 从**下载**标签页或浮动 ⬇ 面板开始下载。

| 入口 | 操作 |
|---|---|
| 浮动 **⬇** 按钮 | 打开页面面板，然后点击**下载 glTF ZIP** |
| 扩展弹窗 | 点击**下载此模型** |
| 批量下载页 | 在弹窗中点击**打开批量下载页面…**，粘贴链接后点击**全部下载** |

尚未应用的**下载纹理**或**开发者模式**选项不会影响下载；下载任务使用最近一次已应用的设置。

在 Blender 中选择**文件 → 导入 → glTF 2.0**并打开 `.glb`。按 **Z → 材质预览**查看纹理，实体模式不会显示纹理。

---

## 设置

| 设置 | 默认值 | 生效时间 |
|---|---|---|
| 下载纹理 | 关闭 | 点击**应用设置**后；ZIP 文件名会以 `-textures` 结尾 |
| 开发者模式 | 关闭 | 点击**应用设置**后；显示详细日志并打包 `download-log.txt` |
| 主题 | 浅色 | 立即生效 |
| 语言 | 浏览器语言（EN / RU / ZH） | 立即生效 |
| 归档 | 完整归档 | 立即生效；**仅 GLB**只保留 `.glb`、`README.txt` 和 `info.json` |
| 纹理尺寸 | 原始尺寸 | 立即生效；原始尺寸选择最大贴图，也可限制为 **≤ 2K / ≤ 4K** |

---

## ZIP 内容

**完整归档：**

```text
ModelName-abcd1234.zip              # 或 ModelName-abcd1234-textures.zip
├── ModelName.glb                   # 在 Blender 中打开此文件
├── model.gltf + model.bin          # 外部 glTF
├── textures/                       # 仅在启用纹理时存在
├── file.osgjs
├── model_file.bin
├── model_file_wireframe.bin        # 如果模型包含此文件
├── README.txt                      # 项目链接
├── info.json
└── download-log.txt                # 仅在开发者模式下存在
```

**仅 GLB**模式保留 `ModelName.glb`、`README.txt`、`info.json`，开启开发者模式时还会保留 `download-log.txt`。如果 deflate 能减小文件大小，ZIP 条目会使用 deflate 压缩。

扩展会还原受保护的 Sketchfab 贴图（PNG/JPEG，包括 4K/8K）。如果某张贴图无法解码，将保留公共 CDN 文件，并在 `MISSING_BLIT.txt` 中记录（仅完整归档模式）。

---

## 工作原理

1. 读取公共嵌入页/查看器数据，包括 UID、材质、网格 URL 和 `diter.b`。
2. 从 Sketchfab 当前使用的 JavaScript 中提取静态解密密钥。
3. 下载 `.binz` 文件并通过 WASM 解密。
4. 如果启用纹理，则以最多 3 个并发任务下载公共贴图，按设置选择原始尺寸、≤2K 或 ≤4K，并使用 `pk` 还原受保护贴图。
5. 将 osgjs 转换为 glTF，并转换为 Y 轴向上，使模型在 Blender 中保持直立。
6. 在离屏文档中创建压缩 ZIP，避免 Service Worker 保存大型 4K/8K RGBA 纹理包时内存不足。

---

## 系统要求

- Chrome / Chromium / Edge（Manifest V3）
- 能够访问 sketchfab.com、media.sketchfab.com 和 static.sketchfab.com

---

## 权限说明

| 权限 | 用途 |
|---|---|
| `downloads` | 保存 ZIP 文件 |
| `storage` | 保存纹理、主题、语言、开发者模式、归档类型和纹理尺寸设置 |
| `tabs` / `activeTab` | 与当前模型页面通信 |
| `offscreen` | 解密、还原纹理并打包大型纹理文件 |
| Sketchfab 主机访问权限 | 获取公共查看器数据和 CDN 贴图 |

---

## 隐私

- 不包含分析或遥测功能
- 不需要 Sketchfab 登录信息或 API 令牌
- 仅使用公共查看器和 CDN 数据

---

## 法律声明

本项目仅用于个人访问公共查看器数据。请遵守 [Sketchfab 服务条款](https://sketchfab.com/terms)及每个模型作者指定的许可证。

---

## 相关项目

- 命令行工具：https://github.com/seryi882/sketchfab-cli

---

## 许可证

[GNU General Public License v3.0](LICENSE)，详情请参阅 [LICENSE](LICENSE)。

Copyright (C) 2026 seryi882

本程序是自由软件：你可以根据自由软件基金会发布的 GNU 通用公共许可证第 3 版（或你选择的任何更高版本）重新发布和/或修改本程序。
