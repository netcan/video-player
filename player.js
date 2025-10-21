const DEFAULT_STREAM_URL = "https://zhiyb.me/hls_ffmpeg/stream-hevc.m3u8";

const qualitySelect = document.getElementById("qualitySelect");
const reloadButton = document.getElementById("reloadButton");
const statusLabel = document.getElementById("status");
const videoEl = document.getElementById("liveVideo");

let hlsInstance = null;
let variants = [];
let currentSourceUrl = "";
let playbackMode = "idle"; // idle | mse | native | unsupported

document.addEventListener("DOMContentLoaded", () => {
  void initPlayer();
});

async function initPlayer() {
  currentSourceUrl = getStreamUrl();
  setStatus("加载画质信息…");

  try {
    await setupPlayback(currentSourceUrl, { forceReload: true });
  } catch (error) {
    console.error(error);
    setStatus("播放器初始化失败，请检查日志或网络。");
  }
}

function getStreamUrl() {
  const params = new URLSearchParams(window.location.search);
  const customSrc = params.get("src");
  if (customSrc) {
    try {
      return new URL(customSrc, window.location.href).toString();
    } catch (error) {
      console.warn("Illegal custom src parameter, fallback to default.", error);
    }
  }
  return DEFAULT_STREAM_URL;
}

async function setupPlayback(manifestUrl, { forceReload = false } = {}) {
  cleanupPlayer();

  if (canUseMseHls()) {
    await setupWithHlsJs(manifestUrl);
    return;
  }

  if (canUseNativeHls(videoEl)) {
    playbackMode = "native";
    if (forceReload || variants.length === 0) {
      try {
        const parsedVariants = await loadVariants(manifestUrl);
        variants = parsedVariants;
        populateQualityOptions(variants);
        setStatus("已加载画质选项，可切换。");
      } catch (error) {
        console.warn("Failed to load variants (likely CORS).", error);
        variants = [];
        populateQualityOptions(variants);
        setStatus("跨域限制导致无法读取画质列表，仅支持自动画质。");
      }
    }
    setupNativePlayback(manifestUrl);
    return;
  }

  playbackMode = "unsupported";
  setStatus("当前浏览器不支持 HLS 或 HEVC。请在支持 HEVC 的 Safari 或 iPhone 上尝试。");
}

function canUseMseHls() {
  return window.Hls && window.Hls.isSupported();
}

function canUseNativeHls(video) {
  if (!video) {
    return false;
  }
  return (
    video.canPlayType("application/vnd.apple.mpegurl") !== "" ||
    video.canPlayType('video/mp4; codecs="hvc1.1.L123.B0"') !== ""
  );
}

function setupWithHlsJs(manifestUrl) {
  return new Promise((resolve, reject) => {
    playbackMode = "mse";
    hlsInstance = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
    });

    const handleManifestParsed = () => {
      const levelVariants = mapLevelsToVariants(hlsInstance.levels || [], manifestUrl);
      variants = levelVariants;
      populateQualityOptions(variants);
      setStatus("已使用 hls.js 准备播放。");
      cleanupListeners();
      resolve();
    };

    const handleError = (event, data) => {
      console.warn("HLS error:", event, data);
      if (!data?.fatal) {
        return;
      }
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          setStatus("网络错误，尝试重新连接…");
          hlsInstance.startLoad();
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          setStatus("媒体错误，尝试恢复…");
          hlsInstance.recoverMediaError();
          break;
        default:
          cleanupListeners();
          reject(new Error("hls.js 遇到致命错误，需要重新加载。"));
          break;
      }
    };

    const cleanupListeners = () => {
      hlsInstance.off(Hls.Events.MANIFEST_PARSED, handleManifestParsed);
      hlsInstance.off(Hls.Events.ERROR, handleError);
    };

    hlsInstance.on(Hls.Events.MEDIA_ATTACHED, () => {
      hlsInstance.loadSource(manifestUrl);
    });

    hlsInstance.attachMedia(videoEl);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, handleManifestParsed);
    hlsInstance.on(Hls.Events.ERROR, handleError);
  });
}

function mapLevelsToVariants(levels, manifestUrl) {
  return levels.map((level, idx) => {
    const width = Number(level.width) || null;
    const height = Number(level.height) || null;
    const resolution = width && height ? `${width}x${height}` : "";
    const bandwidth = numberOrNull(level.maxBitrate ?? level.bitrate ?? level.bandwidth);
    const averageBandwidth = numberOrNull(level.avgBitrate ?? level.averageBitrate);
    const frameRate = numberOrNull(level.frameRate ?? level.attrs?.["FRAME-RATE"]);
    const codecs = normalizeCodecs(level.codecs ?? level.codecSet ?? "");
    const videoRange = level.attrs?.["VIDEO-RANGE"] || "";
    const uri = resolveLevelUrl(level, manifestUrl, idx);

    return {
      uri,
      bandwidth,
      averageBandwidth,
      resolution,
      frameRate,
      codecs,
      videoRange,
    };
  });
}

function resolveLevelUrl(level, manifestUrl, index) {
  const candidate = Array.isArray(level?.url) ? level.url[0] : level?.url;
  if (typeof candidate === "string" && candidate.length) {
    try {
      return new URL(candidate, manifestUrl).toString();
    } catch (error) {
      console.warn("Failed to resolve level URL, fallback to candidate.", error);
      return candidate;
    }
  }
  return `${manifestUrl}#level-${index}`;
}

function normalizeCodecs(codecs) {
  if (Array.isArray(codecs)) {
    return codecs.join(",");
  }
  return typeof codecs === "string" ? codecs : "";
}

async function loadVariants(manifestUrl) {
  const response = await fetch(manifestUrl, { mode: "cors" });
  if (!response.ok) {
    throw new Error(`无法获取播放列表：HTTP ${response.status}`);
  }
  const manifest = await response.text();
  const parsed = parseMasterPlaylist(manifest, manifestUrl);
  if (!parsed.length) {
    throw new Error("未在播放列表中检测到多码率信息。");
  }
  return parsed;
}

function parseMasterPlaylist(content, manifestUrl) {
  const lines = content.split(/\r?\n/);
  const base = new URL(manifestUrl);
  const results = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) {
      continue;
    }
    const attributes = parseExtInfAttributes(line);
    let uriLine = lines[i + 1] ? lines[i + 1].trim() : "";

    while (uriLine.startsWith("#")) {
      i += 1;
      uriLine = lines[i + 1] ? lines[i + 1].trim() : "";
    }

    if (!uriLine) {
      continue;
    }

    const absoluteUri = new URL(uriLine, base).toString();
    const variant = {
      uri: absoluteUri,
      bandwidth: numberOrNull(attributes.BANDWIDTH),
      averageBandwidth: numberOrNull(attributes["AVERAGE-BANDWIDTH"]),
      resolution: attributes.RESOLUTION || "",
      frameRate: numberOrNull(attributes["FRAME-RATE"]),
      codecs: attributes.CODECS ? stripQuotes(attributes.CODECS) : "",
      videoRange: attributes["VIDEO-RANGE"] ? stripQuotes(attributes["VIDEO-RANGE"]) : "",
    };
    results.push(variant);
  }

  return results;
}

function parseExtInfAttributes(line) {
  const attributes = {};
  const attributeString = line.substring(line.indexOf(":") + 1);
  const regex = /([A-Z0-9-]+)=("[^"]+"|[^,]*)/g;
  let match = regex.exec(attributeString);
  while (match) {
    attributes[match[1]] = match[2];
    match = regex.exec(attributeString);
  }
  return attributes;
}

function populateQualityOptions(list) {
  qualitySelect.innerHTML = "";
  addQualityOption("自动", "auto");

  list.forEach((variant, idx) => {
    const label = buildQualityLabel(variant);
    const value = variant.uri || `level-${idx}`;
    addQualityOption(label, value, idx);
  });

  qualitySelect.disabled = list.length === 0;
  qualitySelect.selectedIndex = 0;

  if (!qualitySelect.dataset.bound) {
    qualitySelect.addEventListener("change", handleQualityChange);
    qualitySelect.dataset.bound = "true";
  }
  if (!reloadButton.dataset.bound) {
    reloadButton.addEventListener("click", () => {
      void reloadPlayer();
    });
    reloadButton.dataset.bound = "true";
  }
}

function addQualityOption(label, value, variantIndex = null) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  if (variantIndex !== null) {
    option.dataset.variantIndex = variantIndex.toString();
  }
  qualitySelect.appendChild(option);
}

function buildQualityLabel(variant) {
  const parts = [];

  if (variant.resolution) {
    const resolutionParts = variant.resolution.split("x");
    if (resolutionParts.length === 2) {
      const height = Number(resolutionParts[1]);
      if (Number.isFinite(height)) {
        parts.push(`${height}p`);
      }
    }
  }

  if (variant.frameRate && variant.frameRate > 0) {
    parts.push(`${Math.round(variant.frameRate)}fps`);
  }

  if (variant.videoRange && /PQ|HLG/i.test(variant.videoRange)) {
    parts.push("HDR");
  }

  if (variant.codecs && /hvc|hev1|h265/i.test(variant.codecs)) {
    parts.push("HEVC");
  }

  if (!parts.length) {
    parts.push("自定义");
  }

  const bandwidth = variant.averageBandwidth || variant.bandwidth;
  if (bandwidth) {
    const mbps = (bandwidth / 1000000).toFixed(2);
    parts.push(`${mbps} Mbps`);
  }

  return parts.join(" · ");
}

function handleQualityChange(event) {
  const selectedOption = event.target.selectedOptions[0];
  if (!selectedOption) {
    return;
  }

  if (playbackMode === "mse") {
    if (selectedOption.value === "auto") {
      if (hlsInstance && hlsInstance.levels && hlsInstance.levels.length) {
        hlsInstance.currentLevel = -1;
      }
      setStatus("使用自动画质。");
      return;
    }
    const levelIndex = getVariantIndexFromOption(selectedOption);
    if (levelIndex !== null && hlsInstance && hlsInstance.levels && levelIndex < hlsInstance.levels.length) {
      hlsInstance.currentLevel = levelIndex;
      setStatus(`已切换到 ${selectedOption.textContent}。`);
    }
    return;
  }

  if (playbackMode === "native") {
    if (selectedOption.value === "auto" || qualitySelect.disabled) {
      videoEl.src = currentSourceUrl;
      void videoEl.play().catch((error) => {
        console.warn("Playback blocked on auto selection", error);
      });
      setStatus("使用自动画质。");
      return;
    }
    const index = getVariantIndexFromOption(selectedOption);
    const variant = index !== null ? variants[index] : null;
    if (!variant) {
      return;
    }
    videoEl.src = variant.uri;
    void videoEl.play().catch((error) => {
      console.warn("Playback blocked on manual selection", error);
    });
    setStatus(`已切换到 ${selectedOption.textContent}。`);
  }
}

async function reloadPlayer() {
  setStatus("重新载入流…");
  const previousValue = qualitySelect.value;
  try {
    await setupPlayback(currentSourceUrl, { forceReload: true });
    const optionExists = Boolean(qualitySelect.querySelector(`option[value="${previousValue}"]`));
    qualitySelect.value = optionExists ? previousValue : "auto";
    applyQualitySelection();
  } catch (error) {
    console.error(error);
    setStatus("重新载入失败，请检查网络。");
  }
}

function setupNativePlayback(manifestUrl) {
  playbackMode = "native";
  videoEl.src = manifestUrl;
  videoEl.addEventListener(
    "error",
    () => {
      setStatus("原生播放器加载失败，请确认流可用。");
    },
    { once: true },
  );
}

function cleanupPlayer() {
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  videoEl.removeAttribute("src");
  videoEl.load();
}

function setStatus(message) {
  if (statusLabel) {
    statusLabel.textContent = message;
  }
}

function applyQualitySelection() {
  const selectedOption = qualitySelect.selectedOptions[0];
  if (!selectedOption) {
    return;
  }
  handleQualityChange({ target: qualitySelect });
}

function getVariantIndexFromOption(option) {
  const variantIndex = Number(option.dataset.variantIndex);
  return Number.isFinite(variantIndex) ? variantIndex : null;
}

function numberOrNull(value) {
  if (value === null || typeof value === "undefined") {
    return null;
  }
  const cleaned = typeof value === "string" ? value.replace(/"/g, "") : value;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function stripQuotes(value) {
  return value.replace(/^"(.*)"$/, "$1");
}
