# 第三方代码、数据与商标声明

本项目（OSR2 / SR6 中文控制器）在以下方面使用了第三方内容。作者对本项目的自有代码
采用 MIT 许可（见 `LICENSE`），**第三方内容的权利仍归各自作者**。

---

## 1. ayvajs / Ayva Stroker Lite（MIT）

- 项目：https://github.com/ayvasoftware/ayvajs
- 许可证：MIT（全文见 `LICENSE-ayvajs.txt`）
- 本项目使用的内容：
  - `strokes.json` 里的 42 个 Tempest 动作参数（`from / to / phase / ecc`），
    依据该项目的 `defaultTempestStrokeLibrary` 改写整理；
  - Tempest 运动公式 `pos = mid - half * cos(h + ecc * sin(h))`；
  - 动作库的参数命名与交互思路（Strokes / Output / Parameters /
    Acceleration / Transition Duration 等）。

## 2. 3D 模型数据（来源说明）

- 文件：`static/device-osr2.bin`、`static/device-osr2.json`、`model-src/parts/*.obj`
- 来源：从 **Ayva Stroker Lite**（https://www.ayva-stroker-lite.io/ ，其代码仓库为
  MIT 许可的 `ayvasoftware/ayvajs`）站点包中提取并重新打包的低面数模型，
  仅用于本地 3D 预览。
- 说明：
  - 本项目**没有**使用、也没有分发 OSR2 / SR6 的任何**打印用 CAD/STL 文件**；
  - 该模型是低精度示意网格，不含配合公差、装配结构等可用于加工的设计信息；
  - 若该模型的可再分发权属另有说明，以权利人意见为准。**权利人若认为此处使用
    不妥，请联系作者，本项目会立即移除相关文件。**

## 3. OSR2 / SR6 硬件与 TCode 协议

- **OSR2**（Open Source Stroker Robot）与 **SR6** 是各自作者发布的开源硬件项目，
  例如 `multiaxis/OSR2-Arduino`（2 轴固件）。硬件设计与固件的权利归各自作者。
- **TCode** 是社区使用的设备通信协议。本项目按 TCode v0.4 的轴命名
  （`L0 / R0 / R1 / R2 / L1 / L2`）与 `DSTOP` 语义实现**客户端**，
  **未复制任何固件或第三方协议实现代码**；协议存在多个不同许可证的实现，
  本项目与它们均无代码往来。
- 本项目与 OSR2、SR6、TCode、Ayva 的官方**没有关联、合作或背书关系**，
  不提供硬件、不提供固件、不提供售后。
- 文中出现的 "OSR2"、"SR6"、"TCode"、"Ayva" 等名称仅用于说明兼容性，
  相关商标归各自所有者。

## 4. 未包含的内容

- 早期版本曾镜像 Ayva 的网页构建产物（`ayva_site/`），**当前版本已完全移除**，
  也不再通过本地端口为其提供 WebSocket 中继。
- Ayva 站内的商品图片、宣传文案、"Ayva" 商标等素材，本项目未复制、未再分发。

---

## 转发/再分发时请保留

1. `LICENSE`、`LICENSE-ayvajs.txt`、本文件；
2. 上面关于模型来源、硬件无关的两段说明；
3. 不要声称对 OSR2 / SR6 硬件设计或 TCode 协议拥有权利。
