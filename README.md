# 视频流播放器

简易网页播放器示例，自动解析 HLS (m3u8) 多码率流，提供画质切换，兼容 HEVC/HDR 以及 iPhone Safari 原生播放。

## 功能
- 自动抓取播放列表的码率、分辨率、HDR/HEVC 信息，生成画质选项。
- `hls.js`（浏览器支持 MSE 时）和 Safari 原生 HLS 双模式。
- 手动切换画质或保持自动自适应。
- 重新载入按钮，便于调试流。
- 支持通过 URL 参数 `?src=` 指定自定义流地址。
- 若播放源未配置 CORS，播放器会提示并退回“自动画质”模式，仍可正常播放。

## 使用方式
1. 启动内置服务器（同时提供静态文件与 CORS 代理）：
   ```bash
   node server.js
   ```
   默认监听 `http://localhost:3000`。
2. 浏览器访问 `http://localhost:3000`，即可播放默认 HEVC/HDR 示例流。
3. 若需测试其他流，可在地址后加 `?src=流地址.m3u8`。若该流跨域受限，会自动通过本地代理请求，无需额外配置。
4. 如需关闭代理，可额外加 `&proxy=0`（例如 `http://localhost:3000/?src=https://...&proxy=0`）。

## 跨域说明
- 默认情况下，所有非同源的 `m3u8` 流和分片请求都会通过 `/proxy/...` 转发，自动带上允许跨域的响应头，解决 Chrome/Edge 的 CORS 限制。
- 在支持 HEVC/HDR 的 Safari（含 iPhone/iPad）上，即使不使用代理也能播放；如果想强制直连，可加 `proxy=0`。
- 若目标流本身提供完整的 CORS 头，也可选择不代理以减少跳转。

## 测试说明
- 推荐在支持 HEVC/HDR 的 Safari（特别是 iPhone 或 Apple Silicon Mac）验证效果。
- 在 Chrome/Edge 等浏览器中，会使用 `hls.js`，仅能播放非 HEVC 轨道；若播放失败，请切换至 Safari。
- 网络断开或媒体错误时，播放器会在状态栏提示，可通过“重新载入”按钮恢复。
