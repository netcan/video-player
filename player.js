const REMOTE_STREAM_URL = "https://zhiyb.me/hls_ffmpeg/stream-hevc.m3u8";
const PROXY_PREFIX = "/proxy/";

const qualitySelect = document.getElementById("qualitySelect");
const reloadButton = document.getElementById("reloadButton");
const fullscreenButton = document.getElementById("fullscreenButton");
const statusLabel = document.getElementById("status");
const videoEl = document.getElementById("liveVideo");
const streamPanel = document.getElementById("streamPanel");
const streamPanelSummary = streamPanel ? streamPanel.querySelector(".stream-panel__summary") : null;
const streamForm = document.getElementById("streamForm");
const streamInput = document.getElementById("streamInput");
const proxyToggle = document.getElementById("proxyToggle");
const streamOptionContainer = document.getElementById("streamOptions");
const streamOptionSelect = document.getElementById("streamOptionSelect");

let hlsInstance = null;
let variants = [];
let playbackMode = "idle"; // idle | mse | native | unsupported
let proxyEnabled = true;
let streamOptions = [];
let manifestAlternatives = [];
let activeOptionIndex = 0;
let currentSourceUrl = "";
let lastRemoteSource = "";
let userInputValue = REMOTE_STREAM_URL;
let currentKey = null;
let keyPosterUrl = null;
let pendingLevelIndex = null;
let isAudioOnlyStream = false;
let posterRequestToken = 0;
let initialVariantIndex = null;

document.addEventListener("DOMContentLoaded", () => {
  initializeStateFromQuery();
  initControls();
  void loadStreamFromInput(userInputValue, { updateInputValue: true, persistState: false, initial: true });
});

function initializeStateFromQuery() {
  const params = new URLSearchParams(window.location.search);
  proxyEnabled = !(params.get("proxy") === "0" || params.get("noProxy") === "1");
  const keyParam = params.get("key");
  const srcParam = params.get("src");
  const variantParam = params.get("variant");

  if (typeof variantParam === "string") {
    const parsed = Number.parseInt(variantParam, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      initialVariantIndex = parsed;
    }
  }

  if (keyParam) {
    currentKey = keyParam.trim();
    userInputValue = currentKey || REMOTE_STREAM_URL;
  } else if (srcParam) {
    userInputValue = srcParam.trim();
  } else {
    userInputValue = REMOTE_STREAM_URL;
  }
}

function initControls() {
  if (streamInput) {
    streamInput.value = userInputValue;
    streamInput.addEventListener("focus", () => {
      openStreamPanelIfCollapsed();
    });
  }
  if (proxyToggle) {
    proxyToggle.checked = proxyEnabled;
    proxyToggle.addEventListener("change", handleProxyToggle);
  }
  if (streamForm) {
    streamForm.addEventListener("submit", handleStreamSubmit);
  }
  if (streamOptionSelect && !streamOptionSelect.dataset.bound) {
    streamOptionSelect.addEventListener("change", handleStreamOptionChange);
    streamOptionSelect.dataset.bound = "true";
  }
  if (reloadButton && !reloadButton.dataset.bound) {
    reloadButton.addEventListener("click", () => {
      void reloadPlayer();
    });
    reloadButton.dataset.bound = "true";
  }

  if (fullscreenButton && !fullscreenButton.dataset.bound) {
    fullscreenButton.addEventListener("click", toggleFullscreen);
    fullscreenButton.dataset.bound = "true";
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
  }

  if (streamPanel && !streamPanel.dataset.initialized) {
    applyInitialPanelState();
    streamPanel.dataset.initialized = "true";
  }
}

async function handleStreamSubmit(event) {
  event.preventDefault();
  if (proxyToggle) {
    proxyEnabled = proxyToggle.checked;
  }
  const value = streamInput ? streamInput.value : "";
  await loadStreamFromInput(value);
}

async function handleProxyToggle() {
  proxyEnabled = proxyToggle ? proxyToggle.checked : proxyEnabled;
  await loadStreamFromInput(userInputValue, { updateInputValue: false, persistState: true });
}

async function handleStreamOptionChange(event) {
  const index = Number(event.target.value);
  if (!Number.isFinite(index)) {
    return;
  }
  await applyStreamOption(index, { updateHistory: true });
}

async function loadStreamFromInput(rawInput, { updateInputValue = true, persistState = true, initial = false } = {}) {
  const trimmed = (rawInput || "").trim();
  const treatAsKey = isLikelyKey(trimmed);
  const candidateValue = treatAsKey ? trimmed : trimmed || REMOTE_STREAM_URL;

  userInputValue = candidateValue;
  if (updateInputValue && streamInput) {
    streamInput.value = candidateValue;
  }
  if (proxyToggle) {
    proxyToggle.checked = proxyEnabled;
  }

  let options = [];
  let selectedIndex = 0;

  if (treatAsKey) {
    currentKey = candidateValue;
    options = await buildStreamOptionsFromKey(currentKey);
    if (!options.length) {
      setStatus("未找到匹配的播放源，请检查 key 是否正确。");
      return;
    }
    if (typeof initialVariantIndex === "number" && initialVariantIndex >= 0 && initialVariantIndex < options.length) {
      selectedIndex = initialVariantIndex;
    } else {
      selectedIndex = 0;
    }
    initialVariantIndex = null;
    await ensureKeyPoster(currentKey);
  } else {
    currentKey = null;
    keyPosterUrl = null;
    posterRequestToken += 1;
    videoEl.removeAttribute("poster");
    try {
      const resolved = resolveUrl(candidateValue);
      const remote = stripProxyPrefix(resolved);
      options = [
        {
          label: "自定义",
          remoteUrl: remote,
          type: "direct",
        },
      ];
    } catch (error) {
      console.warn("Invalid stream url.", error);
      setStatus("请输入合法的地址或 key。");
      return;
    }
  }

  streamOptions = options;
  manifestAlternatives = recomputeManifestAlternatives(streamOptions);
  activeOptionIndex = selectedIndex;
  updateStreamOptionSelect();

  await applyStreamOption(selectedIndex, {
    updateHistory: persistState,
    initialLoad: initial,
  });
}

async function buildStreamOptionsFromKey(key) {
  const descriptors = [
    {
      remoteUrl: `https://zhiyb.me/hls_ffmpeg/${key}-hevc.m3u8`,
      label: "HDR (HEVC)",
      type: "hevc",
    },
    {
      remoteUrl: `https://zhiyb.me/hls_ffmpeg/${key}.m3u8`,
      label: "SDR (AVC)",
      type: "sdr",
    },
    {
      remoteUrl: `https://zhiyb.me/hls_data/${key}.m3u8`,
      label: "数据源",
      type: "data",
    },
    {
      remoteUrl: `https://zhiyb.me/hls_fm/${key}.m3u8`,
      label: "FM 音频",
      type: "fm",
    },
  ];

  const available = [];
  for (const descriptor of descriptors) {
    // eslint-disable-next-line no-await-in-loop
    const accessible = await checkStreamAvailability(descriptor.remoteUrl);
    if (accessible) {
      available.push(descriptor);
    }
  }
  return available;
}

async function checkStreamAvailability(remoteUrl) {
  const tryUrls = [];
  if (proxyEnabled) {
    tryUrls.push(ensureProxy(remoteUrl));
  }
  tryUrls.push(remoteUrl);

  for (const candidate of tryUrls) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(candidate, { method: "GET", cache: "no-store" });
      if (response.ok) {
        return true;
      }
    } catch (error) {
      console.warn("Stream availability check failed:", candidate, error);
    }
  }

  return false;
}

function updateStreamOptionSelect() {
  if (!streamOptionContainer || !streamOptionSelect) {
    return;
  }

  streamOptionSelect.innerHTML = "";

  const visibleOptions = streamOptions
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => !isManifestQualityOption(option));

  if (!visibleOptions.length) {
    streamOptionContainer.hidden = true;
    streamOptionSelect.disabled = true;
    streamOptionSelect.value = "";
    updateStreamPanelSummary();
    return;
  }

  visibleOptions.forEach(({ option, index }) => {
    const opt = document.createElement("option");
    opt.value = index.toString();
    opt.textContent = option.label;
    streamOptionSelect.appendChild(opt);
  });

  streamOptionSelect.disabled = false;
  streamOptionContainer.hidden = false;
  const activeVisible = visibleOptions.find(({ index }) => index === activeOptionIndex);
  if (activeVisible) {
    streamOptionSelect.value = activeVisible.index.toString();
  } else {
    streamOptionSelect.value = "";
    streamOptionSelect.selectedIndex = -1;
  }
  updateStreamPanelSummary();
}

async function applyStreamOption(index, { updateHistory = true, initialLoad = false } = {}) {
  const option = streamOptions[index];
  if (!option) {
    return;
  }

  activeOptionIndex = index;
  manifestAlternatives = recomputeManifestAlternatives(streamOptions);

  const remote = option.remoteUrl;
  lastRemoteSource = remote;
  currentSourceUrl = proxyEnabled ? ensureProxy(remote) : remote;
  pendingLevelIndex = null;
  variants = [];
  isAudioOnlyStream = false;
  posterRequestToken += 1;
  if (keyPosterUrl) {
    videoEl.poster = keyPosterUrl;
  } else {
    videoEl.removeAttribute("poster");
  }

  if (updateHistory) {
    persistStateToUrl({
      key: currentKey,
      src: currentKey ? null : option.remoteUrl,
      proxyFlag: proxyEnabled,
      variantIndex: currentKey && streamOptions.length > 1 ? activeOptionIndex : null,
    });
  } else if (initialLoad) {
    persistStateToUrl({
      key: currentKey,
      src: currentKey ? null : option.remoteUrl,
      proxyFlag: proxyEnabled,
      variantIndex: currentKey && streamOptions.length > 1 ? activeOptionIndex : null,
    });
  }

  setStatus(`加载流: ${option.label}…`);

  try {
    await setupPlayback(currentSourceUrl, { forceReload: true });
  } catch (error) {
    console.error(error);
    setStatus("加载流失败，请检查网络或地址。");
    updateStreamPanelSummary();
    return;
  }

  updateStreamPanelSummary();
  void updatePosterFromStream();
  collapseStreamPanelAfterSubmit();
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
          if (option && !isAudioOnlyStream) {
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

  const previousValue = preserveSelection ? qualitySelect.value : null;
  const manifestSelectionValue = getManifestSelectionValue();

  qualitySelect.innerHTML = "";
  addQualityOption("自动", "auto");

  manifestAlternatives.forEach((alt, altIdx) => {
    addManifestQualityOption(alt.label, altIdx, alt.streamIndex);
  });

  list.forEach((variant, idx) => {
    const label = buildQualityLabel(variant);
    const value = variant.uri || `level-${idx}`;
    addQualityOption(label, value, idx);
  });

  qualitySelect.disabled = list.length === 0 && manifestAlternatives.length === 0;

  if (previousValue && qualitySelect.querySelector(`option[value="${previousValue}"]`)) {
    qualitySelect.value = previousValue;
  } else if (manifestSelectionValue && qualitySelect.querySelector(`option[value="${manifestSelectionValue}"]`)) {
    qualitySelect.value = manifestSelectionValue;
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

function addManifestQualityOption(label, altIdx, streamIndex) {
  const option = document.createElement("option");
  option.value = manifestOptionValue(altIdx);
  option.textContent = label;
  option.dataset.manifestStreamIndex = streamIndex.toString();
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

  const manifestStreamIndex = getManifestStreamIndex(selectedOption);
  if (manifestStreamIndex !== null) {
    if (manifestStreamIndex !== activeOptionIndex) {
      void applyStreamOption(manifestStreamIndex, { updateHistory: true });
    }
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

function persistStateToUrl({ src, proxyFlag, key, variantIndex }) {
  const params = new URLSearchParams(window.location.search);

  if (key) {
    params.set("key", key);
    params.delete("src");
  } else if (src) {
    params.set("src", src);
    params.delete("key");
  } else {
    params.delete("key");
    params.delete("src");
  }

  if (key && typeof variantIndex === "number" && variantIndex >= 0 && streamOptions.length > 1) {
    params.set("variant", String(variantIndex));
  } else {
    params.delete("variant");
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
      videoEl.classList.add("video--audio");
    } else {
      videoEl.classList.remove("video--audio");
    }
    return;
  }
  isAudioOnlyStream = enable;
  if (enable) {
    videoEl.classList.add("video--audio");
    setStatus("检测到纯音频流，已显示封面。");
  } else {
    videoEl.classList.remove("video--audio");
  }
  void updatePosterFromStream();
}

async function updatePosterFromStream() {
  const token = ++posterRequestToken;
  const poster = await selectPosterImage(lastRemoteSource);
  if (posterRequestToken !== token) {
    return;
  }

  if (poster) {
    videoEl.poster = poster;
  } else if (keyPosterUrl) {
    videoEl.poster = keyPosterUrl;
  } else {
    videoEl.removeAttribute("poster");
  }
  if (isAudioOnlyStream) {
    videoEl.classList.add("video--audio");
  } else {
    videoEl.classList.remove("video--audio");
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
    return keyPosterUrl;
  }

  const candidates = buildPosterCandidates(parsed);
  const attemptUrls = buildPosterAttemptUrls(candidates);
  for (const candidate of attemptUrls) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await doesImageExist(candidate.url);
    if (exists) {
      if (candidate.sameOrigin || candidate.allowCrossOrigin) {
        return candidate.url;
      }
      if (!candidate.sameOrigin) {
        console.warn("Poster found but cross-origin without proxy; skipping to avoid CORS warnings.", candidate.url);
      }
    }
  }
  return keyPosterUrl;
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

function buildPosterAttemptUrls(candidates) {
  const attempts = [];
  const seen = new Set();
  candidates.forEach((remoteUrl) => {
    if (!remoteUrl) {
      return;
    }
    const proxied = proxyEnabled ? ensureProxy(remoteUrl) : remoteUrl;
    const proxiedSameOrigin = isSameOriginUrl(proxied);
    if (proxiedSameOrigin && !seen.has(proxied)) {
      attempts.push({ url: proxied, sameOrigin: true, allowCrossOrigin: false });
      seen.add(proxied);
    }
    if (!seen.has(remoteUrl)) {
      const allowCrossOrigin = !proxyEnabled;
      attempts.push({ url: remoteUrl, sameOrigin: isSameOriginUrl(remoteUrl), allowCrossOrigin });
      seen.add(remoteUrl);
    }
  });
  return attempts;
}

function doesImageExist(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
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

function isSameOriginUrl(spec) {
  try {
    const parsed = new URL(spec, window.location.href);
    return parsed.origin === window.location.origin;
  } catch {
    return false;
  }
}

function isLikelyKey(value) {
  if (!value) {
    return false;
  }
  if (value.includes("://") || value.includes(".m3u8")) {
    return false;
  }
  return /^[A-Za-z0-9_-]+$/.test(value);
}

async function ensureKeyPoster(key) {
  const remote = `https://zhiyb.me/hls_data/${key}.png`;
  const attempts = [];
  if (proxyEnabled) {
    attempts.push(ensureProxy(remote));
  }
  attempts.push(remote);

  for (const url of attempts) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await doesImageExist(url);
    if (exists) {
      keyPosterUrl = url;
      videoEl.poster = keyPosterUrl;
      return keyPosterUrl;
    }
  }

  keyPosterUrl = null;
  videoEl.removeAttribute("poster");
  return null;
}

function toggleFullscreen() {
  if (!videoEl) {
    return;
  }
  if (isFullscreen()) {
    exitFullscreen();
  } else {
    requestFullscreen(videoEl);
  }
}

function requestFullscreen(element) {
  if (element.requestFullscreen) {
    void element.requestFullscreen();
  } else if (element.webkitRequestFullscreen) {
    element.webkitRequestFullscreen();
  } else if (element.msRequestFullscreen) {
    element.msRequestFullscreen();
  }
}

function exitFullscreen() {
  if (document.exitFullscreen) {
    void document.exitFullscreen();
  } else if (document.webkitExitFullscreen) {
    document.webkitExitFullscreen();
  } else if (document.msExitFullscreen) {
    document.msExitFullscreen();
  }
}

function isFullscreen() {
  return Boolean(
    document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.msFullscreenElement,
  );
}

function handleFullscreenChange() {
  if (!fullscreenButton) {
    return;
  }
  const active = isFullscreen();
  fullscreenButton.textContent = active ? "退出全屏" : "全屏";
  fullscreenButton.setAttribute("aria-pressed", active ? "true" : "false");
  if (active) {
    setStatus("已进入全屏模式。");
  } else {
    setStatus("已退出全屏模式。");
  }
}

function applyInitialPanelState() {
  if (!streamPanel) {
    return;
  }
  const preferCollapsed = window.innerWidth < 640;
  if (preferCollapsed) {
    streamPanel.open = false;
  } else {
    streamPanel.open = true;
  }
}

function openStreamPanelIfCollapsed() {
  if (streamPanel && !streamPanel.open) {
    streamPanel.open = true;
  }
}

function updateStreamPanelSummary() {
  if (!streamPanelSummary) {
    return;
  }
  const current = streamOptions[activeOptionIndex];
  if (current) {
    let suffix = null;
    if (manifestAlternatives.some((alt) => alt.streamIndex === activeOptionIndex)) {
      suffix = current.label;
    } else if (streamOptions.length > 1) {
      suffix = current.label;
    } else if (currentKey) {
      suffix = currentKey;
    } else if (current.label && current.label !== "自定义") {
      suffix = current.label;
    }
    streamPanelSummary.textContent = suffix ? `播放源设置 · ${suffix}` : "播放源设置";
    return;
  }
  if (currentKey) {
    streamPanelSummary.textContent = `播放源设置 · ${currentKey}`;
    return;
  }
  streamPanelSummary.textContent = "播放源设置";
}

function collapseStreamPanelAfterSubmit() {
  if (!streamPanel) {
    return;
  }
  if (window.innerWidth < 640) {
    streamPanel.open = false;
  }
}

function recomputeManifestAlternatives(options) {
  return options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => isManifestQualityOption(option))
    .map(({ option, index }) => ({
      label: option.label,
      streamIndex: index,
      type: option.type,
    }));
}

function isManifestQualityOption(option) {
  return option?.type === "hevc" || option?.type === "sdr";
}

function manifestOptionValue(altIdx) {
  return `manifest-${altIdx}`;
}

function getManifestSelectionValue() {
  const altIdx = manifestAlternatives.findIndex((alt) => alt.streamIndex === activeOptionIndex);
  return altIdx >= 0 ? manifestOptionValue(altIdx) : null;
}

function getManifestStreamIndex(option) {
  const value = option.dataset.manifestStreamIndex;
  if (typeof value === "undefined") {
    return null;
  }
  const idx = Number(value);
  return Number.isFinite(idx) ? idx : null;
}
