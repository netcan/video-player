# 视频流播放器

简易网页播放器示例，自动解析 HLS (m3u8) 多码率流，提供画质切换，兼容 HEVC/HDR 以及 iPhone Safari 原生播放。

## 功能
- 自动抓取播放列表的码率、分辨率、HDR/HEVC 信息，生成画质选项。
- `hls.js`（浏览器支持 MSE 时）和 Safari 原生 HLS 双模式。
- 手动切换画质或保持自动自适应。
- 重新载入按钮，便于调试流。
- 页面内可输入自定义 m3u8 地址，并可一键切换是否走本地代理。
- 纯音频流会自动尝试匹配同名图片作为封面（例如 `*.m3u8` → `*.png` 或 `hls_fm` → `hls_data`）。
- 支持通过 URL 参数 `?src=` 指定自定义流地址。
- 若播放源未配置 CORS，播放器会提示并退回“自动画质”模式，仍可正常播放。

## 使用方式
1. 启动内置服务器（同时提供静态文件与 CORS 代理）：
   ```bash
   node server.js
   ```
   默认监听 `http://localhost:3000`。
2. 浏览器访问 `http://localhost:3000`，即可播放默认 HEVC/HDR 示例流。
3. 支持两种输入方式：
   - **直接粘贴 m3u8 地址**：点击“播放”即可加载。
   - **仅输入 key（如 `tingfm_58`）**：播放器会按顺序尝试 `-hevc`, `hls_ffmpeg`, `hls_data`, `hls_fm` 四类地址，并设置 `https://zhiyb.me/hls_data/$key.png` 为封面。若检测到 HEVC，会额外提供 SDR 选项。
4. 播放源设置在移动端默认折叠，可展开卡片后编辑；桌面端默认展开。
5. 页面上的“流类型”下拉框会列出可用源（HDR/SDR/音频等），实时切换无需刷新。
6. 底部控件提供“重新载入”与“全屏”按钮；全屏按钮再次点击即可退出。
7. 仍可通过地址栏参数 `?src=` 指定初始流或使用 `?key=` 指定初始 key；若需禁用代理，在地址栏或表单里取消勾选，或加 `&proxy=0`。

### Key 模式规则
当输入框内容匹配 `^[A-Za-z0-9_-]+$` 时，会启用 key 模式并按照以下逻辑执行：
1. 依次探测并记录可用的播放源：
   - `https://zhiyb.me/hls_ffmpeg/${key}-hevc.m3u8`
   - `https://zhiyb.me/hls_ffmpeg/${key}.m3u8`
   - `https://zhiyb.me/hls_data/${key}.m3u8`
   - `https://zhiyb.me/hls_fm/${key}.m3u8`
2. 任意源可访问即加入“流类型”下拉框；若检测到 HEVC/SDR 组合，会直接在画质选择中出现“HDR (HEVC)”与“SDR (AVC)”选项进行切换。
3. 封面图片默认从 `https://zhiyb.me/hls_data/${key}.png` 获取，若代理开启则自动走 `/proxy/` 以解决 CORS；纯音频流会保持方形布局并继续尝试同名 `.jpg/.jpeg/.webp`。
4. 地址栏会同步更新 `?key=...` 和 `?variant=` 参数，刷新后可直接恢复同一 key 与流类型。

## 跨域说明
- 默认情况下，所有非同源的 `m3u8` 流和分片请求都会通过 `/proxy/...` 转发，自动带上允许跨域的响应头，解决 Chrome/Edge 的 CORS 限制。
- 在支持 HEVC/HDR 的 Safari（含 iPhone/iPad）上，即使不使用代理也能播放；如果想强制直连，可加 `proxy=0`。
- 若目标流本身提供完整的 CORS 头，也可选择不代理以减少跳转。

## 测试说明
- 推荐在支持 HEVC/HDR 的 Safari（特别是 iPhone 或 Apple Silicon Mac）验证效果。
- 在 Chrome/Edge 等浏览器中，会使用 `hls.js`，仅能播放非 HEVC 轨道；若播放失败，请切换至 Safari。
- 网络断开或媒体错误时，播放器会在状态栏提示，可通过“重新载入”按钮恢复。
