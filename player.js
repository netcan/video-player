const REMOTE_STREAM_URL = "https://zhiyb.me/hls_ffmpeg/stream-hevc.m3u8";
const PROXY_PREFIX = "/proxy/";

const qualitySelect = document.getElementById("qualitySelect");
const reloadButton = document.getElementById("reloadButton");
const statusLabel = document.getElementById("status");
const videoEl = document.getElementById("liveVideo");
const streamForm = document.getElementById("streamForm");
const streamInput = document.getElementById("streamInput");
const proxyToggle = document.getElementById("proxyToggle");

let hlsInstance = null;
let variants = [];
let currentSourceUrl = "";
let userInputUrl = REMOTE_STREAM_URL;
let playbackMode = "idle"; // idle | mse | native | unsupported
let proxyEnabled = true;
let pendingLevelIndex = null;
let lastRemoteSource = REMOTE_STREAM_URL;
let isAudioOnlyStream = false;
let posterRequestToken = 0;

document.addEventListener("DOMContentLoaded", () => {
  initializeSourceState();
  initControls();
  void initPlayer();
});

async function initPlayer() {
  setStatus("加载画质信息…");
  try {
    await setupPlayback(currentSourceUrl, { forceReload: true });
  } catch (error) {
    console.error(error);
    setStatus("播放器初始化失败，请检查日志或网络。");
  }
}

function initializeSourceState() {
  const params = new URLSearchParams(window.location.search);
  proxyEnabled = !(params.get("proxy") === "0" || params.get("noProxy") === "1");
  const rawSrc = params.get("src");
  userInputUrl = rawSrc ? rawSrc : REMOTE_STREAM_URL;

  try {
    const absolute = resolveUrl(userInputUrl);
    const remote = stripProxyPrefix(absolute);
    lastRemoteSource = remote;
    currentSourceUrl = proxyEnabled ? ensureProxy(remote) : remote;
  } catch (error) {
    console.warn("Invalid initial src provided, fallback to default stream.", error);
    userInputUrl = REMOTE_STREAM_URL;
    const fallbackAbsolute = resolveUrl(userInputUrl);
    const remote = stripProxyPrefix(fallbackAbsolute);
    lastRemoteSource = remote;
    currentSourceUrl = proxyEnabled ? ensureProxy(remote) : remote;
  }
}

function initControls() {
  if (streamInput) {
    streamInput.value = userInputUrl;
  }
  if (proxyToggle) {
    proxyToggle.checked = proxyEnabled;
    proxyToggle.addEventListener("change", handleProxyToggle);
  }
  if (streamForm) {
    streamForm.addEventListener("submit", handleStreamSubmit);
  }
  if (reloadButton && !reloadButton.dataset.bound) {
    reloadButton.addEventListener("click", () => {
      void reloadPlayer();
    });
    reloadButton.dataset.bound = "true";
  }
}

async function handleStreamSubmit(event) {
  event.preventDefault();
  if (proxyToggle) {
    proxyEnabled = proxyToggle.checked;
  }
  const value = streamInput ? streamInput.value : "";
  await loadStream(value);
}

async function handleProxyToggle() {
  proxyEnabled = proxyToggle ? proxyToggle.checked : proxyEnabled;
  await loadStream(streamInput ? streamInput.value : userInputUrl, { updateInputValue: false });
}

async function loadStream(rawUrl, { updateInputValue = true } = {}) {
  const trimmed = (rawUrl || "").trim();
  const candidate = trimmed || REMOTE_STREAM_URL;

  let absolute;
  try {
    absolute = resolveUrl(candidate);
  } catch (error) {
    console.warn("Invalid stream url.", error);
    setStatus("请输入合法的 m3u8 地址。");
    return;
  }

  userInputUrl = candidate;
  const remote = stripProxyPrefix(absolute);
  lastRemoteSource = remote;
  currentSourceUrl = proxyEnabled ? ensureProxy(remote) : remote;
  pendingLevelIndex = null;
  variants = [];
  setAudioOnlyState(false);

  if (updateInputValue && streamInput) {
    streamInput.value = userInputUrl;
  }
  if (proxyToggle) {
    proxyToggle.checked = proxyEnabled;
  }

  persistStateToUrl(userInputUrl, proxyEnabled);
  setStatus("加载流…");

  try {
    await setupPlayback(currentSourceUrl, { forceReload: true });
  } catch (error) {
    console.error(error);
    setStatus("加载新流失败，请检查地址或网络。");
  }
}

async function reloadPlayer() {
  setStatus("重新载入流…");
  const previousValue = qualitySelect ? qualitySelect.value : "auto";
  pendingLevelIndex = getSelectedVariantIndex();
  variants = [];
  try {
    await setupPlayback(currentSourceUrl, { forceReload: true });
    if (qualitySelect) {
      if (qualitySelect.querySelector(`option[value="${previousValue}"]`)) {
        qualitySelect.value = previousValue;
      }
      applyQualitySelection();
    }
  } catch (error) {
    console.error(error);
    setStatus("重新载入失败，请检查网络。");
  }
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
        handleVariantsUpdated(variants);
        populateQualityOptions(variants, { preserveSelection: pendingLevelIndex !== null });
        if (!pendingLevelIndex && !isAudioOnlyStream) {
          setStatus("已加载画质选项，可切换。");
        }
      } catch (error) {
        console.warn("Failed to load variants (likely CORS).", error);
        variants = [];
        populateQualityOptions(variants, { preserveSelection: false });
        const likelyAudio = isLikelyAudioStream(lastRemoteSource);
        setAudioOnlyState(likelyAudio);
        if (likelyAudio) {
          setStatus("未获取到画质列表，按音频流处理。");
        } else {
          setStatus("跨域限制导致无法读取画质列表，仅支持自动画质。");
        }
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
    const preservedIndex = pendingLevelIndex ?? getSelectedVariantIndex();
    pendingLevelIndex = preservedIndex;

    hlsInstance = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
    });

    const handleManifestParsed = () => {
      const levelVariants = mapLevelsToVariants(hlsInstance.levels || [], manifestUrl);
      variants = levelVariants;
      handleVariantsUpdated(variants);
      populateQualityOptions(variants, { preserveSelection: typeof pendingLevelIndex === "number" });

      if (typeof pendingLevelIndex === "number" && pendingLevelIndex >= 0) {
        if (pendingLevelIndex < hlsInstance.levels.length) {
          hlsInstance.currentLevel = pendingLevelIndex;
          const option = findOptionByVariantIndex(pendingLevelIndex);
          if (option) {
            qualitySelect.value = option.value;
            setStatus(`已切换到 ${option.textContent}。`);
          }
        } else {
          hlsInstance.currentLevel = -1;
          if (!isAudioOnlyStream) {
            setStatus("使用自动画质。");
          }
        }
      } else {
        hlsInstance.currentLevel = -1;
        if (isAudioOnlyStream) {
          setStatus("检测到纯音频流，已显示封面。");
        } else {
          setStatus("已使用 hls.js 准备播放。");
        }
      }

      pendingLevelIndex = null;
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

function setupNativePlayback(manifestUrl) {
  videoEl.src = manifestUrl;
  videoEl.addEventListener(
    "error",
    () => {
      setStatus("原生播放器加载失败，请确认流可用。");
    },
    { once: true },
  );
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

function populateQualityOptions(list, { preserveSelection = false } = {}) {
  if (!qualitySelect) {
    return;
  }

  const targetValue = preserveSelection ? qualitySelect.value : "auto";

  qualitySelect.innerHTML = "";
  addQualityOption("自动", "auto");

  list.forEach((variant, idx) => {
    const label = buildQualityLabel(variant);
    const value = variant.uri || `level-${idx}`;
    addQualityOption(label, value, idx);
  });

  qualitySelect.disabled = list.length === 0;

  if (qualitySelect.querySelector(`option[value="${targetValue}"]`)) {
    qualitySelect.value = targetValue;
  } else {
    qualitySelect.selectedIndex = 0;
  }

  if (!qualitySelect.dataset.bound) {
    qualitySelect.addEventListener("change", handleQualityChange);
    qualitySelect.dataset.bound = "true";
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
      pendingLevelIndex = null;
      if (!isAudioOnlyStream) {
        setStatus("使用自动画质。");
      }
      return;
    }
    const levelIndex = getVariantIndexFromOption(selectedOption);
    if (levelIndex !== null && hlsInstance && hlsInstance.levels && levelIndex < hlsInstance.levels.length) {
      hlsInstance.currentLevel = levelIndex;
      pendingLevelIndex = levelIndex;
      if (!isAudioOnlyStream) {
        setStatus(`已切换到 ${selectedOption.textContent}。`);
      }
    }
    return;
  }

  if (playbackMode === "native") {
    if (selectedOption.value === "auto" || qualitySelect.disabled) {
      videoEl.src = currentSourceUrl;
      void videoEl.play().catch((error) => {
        console.warn("Playback blocked on auto selection", error);
      });
      pendingLevelIndex = null;
      if (!isAudioOnlyStream) {
        setStatus("使用自动画质。");
      }
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
    pendingLevelIndex = null;
    if (!isAudioOnlyStream) {
      setStatus(`已切换到 ${selectedOption.textContent}。`);
    }
  }
}

function applyQualitySelection() {
  if (!qualitySelect) {
    return;
  }
  const selectedOption = qualitySelect.selectedOptions[0];
  if (!selectedOption) {
    return;
  }
  handleQualityChange({ target: qualitySelect });
}

function cleanupPlayer() {
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  playbackMode = "idle";
  videoEl.removeAttribute("src");
  videoEl.load();
}

function setStatus(message) {
  if (statusLabel) {
    statusLabel.textContent = message;
  }
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

function resolveUrl(spec) {
  const trimmed = (spec || "").trim();
  const candidate = trimmed || REMOTE_STREAM_URL;
  const parsed = new URL(candidate, window.location.href);
  return parsed.toString();
}

function stripProxyPrefix(spec) {
  try {
    const parsed = new URL(spec);
    if (parsed.origin === window.location.origin && parsed.pathname.startsWith(PROXY_PREFIX)) {
      const remote = `${parsed.pathname.slice(PROXY_PREFIX.length)}${parsed.search || ""}`;
      return remote;
    }
  } catch (error) {
    console.warn("Failed to strip proxy prefix.", error);
  }
  return spec;
}

function ensureProxy(url) {
  if (!isAbsoluteUrl(url)) {
    return url;
  }
  const origin = window.location.origin;
  try {
    const parsed = new URL(url);
    if (parsed.origin === origin) {
      return url;
    }
  } catch (error) {
    console.warn("Failed to parse URL for proxy check.", error);
    return url;
  }
  const alreadyProxied = url.startsWith(`${origin}${PROXY_PREFIX}`) || url.startsWith(PROXY_PREFIX);
  if (alreadyProxied) {
    return url;
  }
  return `${origin}${PROXY_PREFIX}${url}`;
}

function isAbsoluteUrl(spec) {
  try {
    new URL(spec);
    return true;
  } catch {
    return false;
  }
}

function persistStateToUrl(src, proxyFlag) {
  const params = new URLSearchParams(window.location.search);
  if (src && src !== REMOTE_STREAM_URL) {
    params.set("src", src);
  } else {
    params.delete("src");
  }

  if (!proxyFlag) {
    params.set("proxy", "0");
  } else {
    params.delete("proxy");
  }

  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history.replaceState({}, "", nextUrl);
}

function getVariantIndexFromOption(option) {
  const variantIndex = Number(option.dataset.variantIndex);
  return Number.isFinite(variantIndex) ? variantIndex : null;
}

function getSelectedVariantIndex() {
  if (!qualitySelect) {
    return null;
  }
  const option = qualitySelect.selectedOptions[0];
  if (!option || option.value === "auto") {
    return null;
  }
  return getVariantIndexFromOption(option);
}

function findOptionByVariantIndex(index) {
  if (!qualitySelect) {
    return null;
  }
  return qualitySelect.querySelector(`option[data-variant-index="${index}"]`);
}

function detectAudioOnly(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return false;
  }
  return list.every((variant) => {
    const hasResolution = Boolean(variant.resolution && /\d+x\d+/.test(variant.resolution));
    const hasVideoCodec = containsVideoCodec(variant.codecs || "");
    return !hasResolution && !hasVideoCodec;
  });
}

function containsVideoCodec(codecs) {
  if (!codecs) {
    return false;
  }
  const lower = codecs.toLowerCase();
  return ["avc", "hvc", "hev1", "h265", "vp9", "av01"].some((codec) => lower.includes(codec));
}

function handleVariantsUpdated(list) {
  const detectedAudio = detectAudioOnly(list);
  if (detectedAudio) {
    setAudioOnlyState(true);
  } else if (Array.isArray(list) && list.length > 0) {
    setAudioOnlyState(false);
  } else {
    const likelyAudio = isLikelyAudioStream(lastRemoteSource);
    setAudioOnlyState(likelyAudio);
  }
}

function setAudioOnlyState(enable) {
  if (isAudioOnlyStream === enable) {
    if (enable) {
      void updatePosterForAudioStream();
    }
    return;
  }
  isAudioOnlyStream = enable;
  if (!enable) {
    posterRequestToken += 1;
    videoEl.classList.remove("video--audio");
    videoEl.removeAttribute("poster");
    return;
  }
  void updatePosterForAudioStream();
}

async function updatePosterForAudioStream() {
  const token = ++posterRequestToken;
  const poster = await selectPosterImage(lastRemoteSource);
  if (posterRequestToken !== token) {
    return;
  }

  if (poster) {
    videoEl.poster = poster;
  } else {
    videoEl.removeAttribute("poster");
  }
  videoEl.classList.add("video--audio");
  if (isAudioOnlyStream) {
    setStatus("检测到纯音频流，已显示封面。");
  }
}

async function selectPosterImage(streamUrl) {
  if (!streamUrl) {
    return null;
  }
  const raw = stripProxyPrefix(streamUrl);
  let parsed;
  try {
    parsed = new URL(raw, window.location.href);
  } catch (error) {
    console.warn("Unable to parse stream url for poster.", error);
    return null;
  }

  const candidates = buildPosterCandidates(parsed);
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await doesImageExist(candidate);
    if (exists) {
      return candidate;
    }
  }
  return null;
}

function buildPosterCandidates(url) {
  const candidates = new Set();
  const stem = url.pathname.replace(/\.[^/.]+$/, "");
  const basePaths = new Set([stem]);

  if (url.pathname.includes("/hls_fm/")) {
    basePaths.add(url.pathname.replace("/hls_fm/", "/hls_data/").replace(/\.[^/.]+$/, ""));
  }

  const extensions = [".png", ".jpg", ".jpeg", ".webp"];
  basePaths.forEach((basePath) => {
    extensions.forEach((ext) => {
      candidates.add(`${url.origin}${basePath}${ext}`);
    });
  });

  return Array.from(candidates);
}

function doesImageExist(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

function isLikelyAudioStream(url) {
  if (!url) {
    return false;
  }
  const lower = url.toLowerCase();
  return lower.includes("hls_fm") || lower.includes("audio") || lower.includes("radio") || lower.includes("podcast");
}
