import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { initializeFirestore, collection, getDocs } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCTwOAC_LrrKH8CKepUOTf0pyd9qRv4y_8",
  authDomain: "cnation-project.firebaseapp.com",
  projectId: "cnation-project",
  storageBucket: "cnation-project.firebasestorage.app",
  messagingSenderId: "1004154104261",
  appId: "1:1004154104261:web:0eac4c7ded38262ae5c3ac",
  measurementId: "G-7PW1NSP5EQ"
};

const app = initializeApp(firebaseConfig);
// 사내망/공용 와이파이 등 스트리밍(WebChannel) 연결이 막힌 네트워크에서도 동작하도록
// 필요할 때만 자동으로 롱폴링으로 전환한다.
const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
const collectionName = "cnation-ccm-list";

const SORT_LABELS = { new: "최신순", old: "오래된순", shuffle: "랜덤" };
const STORAGE_KEY_SORT = "ccmPlayer.sortMode";
const STORAGE_KEY_REPEAT = "ccmPlayer.repeatMode";

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function getTitleInitial(title) {
  const sourceText = (title || "").replace(/\s/g, "");
  return escapeHTML(Array.from(sourceText)[0] || "?");
}

function readStoredMode(key, allowed, fallback) {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v) ? v : fallback;
  } catch { return fallback; }
}
function writeStoredMode(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode 등에서 실패해도 무시 */ }
}

// ---- 이퀄라이저용 클릭음 (echo와 동일하게 Web Audio로 합성) ----
let sfxCtx = null;
function ensureSfxCtx() {
  if (!sfxCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    sfxCtx = new Ctx();
  }
  if (sfxCtx.state === "suspended") sfxCtx.resume();
  return sfxCtx;
}
function playClick() {
  const ctx = ensureSfxCtx();
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(1200, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.22, now + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.04);
}

const EQ_BARS = 24;
const eqEl = document.getElementById("eq");
for (let i = 0; i < EQ_BARS; i++) eqEl.appendChild(document.createElement("span"));

const els = {
  screen: document.getElementById("screen"),
  standby: document.getElementById("viewStandby"),
  standbySub: document.getElementById("standbySub"),
  playing: document.getElementById("viewPlaying"),
  library: document.getElementById("viewLibrary"),
  libList: document.getElementById("libList"),
  art: document.getElementById("art"),
  npIndex: document.getElementById("npIndex"),
  npBadge: document.getElementById("npBadge"),
  npTitle: document.getElementById("npTitle"),
  npSub: document.getElementById("npSub"),
  loadingHint: document.getElementById("loadingHint"),
  eq: Array.from(eqEl.children),
  progressFill: document.getElementById("progressFill"),
  timeCur: document.getElementById("timeCur"),
  timeDur: document.getElementById("timeDur"),
  audio: document.getElementById("audio"),
  btnPrev: document.getElementById("btnPrev"),
  btnPlay: document.getElementById("btnPlay"),
  btnNext: document.getElementById("btnNext"),
  btnMenu: document.getElementById("btnMenu"),
  sortNewBtn: document.getElementById("sortNewBtn"),
  sortOldBtn: document.getElementById("sortOldBtn"),
  sortShuffleBtn: document.getElementById("sortShuffleBtn"),
  repeatBtn: document.getElementById("repeatBtn")
};

let allSongs = [];        // Firestore에서 읽은 곡 전체 (메타데이터만, mp3/원본이미지는 아직 안 받음)
let songsById = new Map();
let queue = [];            // 현재 정렬/셔플 모드에 따른 재생 순서 (곡 id 배열)
let queuePos = -1;
let sortMode = readStoredMode(STORAGE_KEY_SORT, ["new", "old", "shuffle"], "new");
let repeatMode = readStoredMode(STORAGE_KEY_REPEAT, ["all", "one"], "all");
let libraryOpen = false;

// ---- 실제 음향 분석(이퀄라이저) 지원 여부 감지 ----
// Firebase Storage 버킷에 CORS가 열려 있어야 Web Audio API로 mp3를 분석할 수 있다.
// CORS가 안 열려 있는 상태에서 재생용 <audio>에 crossOrigin을 걸면 로드 자체가 실패할
// 수 있으므로, 별도의 "탐지용" Audio로 먼저 조용히 확인한 뒤에만 재생 경로에 반영한다.
let corsSupported = false;
let corsProbed = false;
let audioCtx = null;
let analyser = null;

function probeCorsSupport(sampleUrl) {
  if (corsProbed || !sampleUrl) return;
  corsProbed = true;
  const probe = new Audio();
  probe.crossOrigin = "anonymous";
  probe.preload = "metadata";
  probe.addEventListener("loadedmetadata", () => { corsSupported = true; }, { once: true });
  probe.src = sampleUrl;
}

function ensureAudioGraph() {
  if (audioCtx) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    const source = audioCtx.createMediaElementSource(els.audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch (e) {
    console.warn("오디오 분석 그래프 연결 실패, CSS 애니메이션으로 대체:", e);
    audioCtx = null;
    analyser = null;
  }
}

function formatTime(sec) {
  if (!Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function setScreenState(state) {
  els.screen.dataset.state = state;
  els.standby.hidden = state !== "standby";
  els.playing.hidden = state !== "playing";
  els.library.hidden = state !== "library";
}

// ---- 정렬/셔플 큐 구성 ----
function sortedIdsByDate(direction) {
  return [...allSongs]
    .sort((a, b) => {
      const da = a.creationDate || "";
      const db = b.creationDate || "";
      if (da === db) return 0;
      const cmp = da < db ? -1 : 1;
      return direction === "asc" ? cmp : -cmp;
    })
    .map((s) => s.id);
}
function shuffledIds() {
  const ids = allSongs.map((s) => s.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}
function rebuildQueue(mode) {
  const currentId = queuePos >= 0 ? queue[queuePos] : null;
  if (mode === "new") queue = sortedIdsByDate("desc");
  else if (mode === "old") queue = sortedIdsByDate("asc");
  else queue = shuffledIds();
  sortMode = mode;
  queuePos = currentId ? queue.indexOf(currentId) : -1;
}

function updateSortChips() {
  [els.sortNewBtn, els.sortOldBtn, els.sortShuffleBtn].forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.sort === sortMode);
  });
}
function updateRepeatButton() {
  const isOne = repeatMode === "one";
  els.repeatBtn.textContent = isOne ? "🔂 1곡반복" : "🔁 전체반복";
  els.repeatBtn.classList.toggle("active", isOne);
}

function renderLibrary() {
  els.libList.innerHTML = "";
  if (queue.length === 0) {
    els.libList.innerHTML = '<p class="lib-empty">불러온 곡이 없습니다.</p>';
    return;
  }
  queue.forEach((id, pos) => {
    const song = songsById.get(id);
    if (!song) return;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "lib-row" + (pos === queuePos ? " active" : "");

    const thumbHtml = song.thumbnailUrl
      ? `<img class="lib-thumb" src="${escapeHTML(song.thumbnailUrl)}" loading="lazy" alt="">`
      : `<div class="lib-thumb-fallback">${getTitleInitial(song.title)}</div>`;

    const dateStr = song.creationDate ? song.creationDate.split("-").join(". ") + "." : "";
    row.innerHTML = `
      ${thumbHtml}
      <div class="lib-meta">
        <div class="lib-title">${escapeHTML(song.title || "(제목 없음)")}</div>
        <div class="lib-sub">${escapeHTML(song.creator || "")}${song.creator && dateStr ? " · " : ""}${dateStr}</div>
      </div>
      ${pos === queuePos ? '<span class="lib-playing-mark">▶</span>' : ""}
    `;
    row.addEventListener("click", () => {
      playClick();
      playAtQueuePos(pos, true);
      closeLibrary();
    });
    els.libList.appendChild(row);
  });
}

function playAtQueuePos(pos, autoplay = true) {
  if (queue.length === 0) return;
  queuePos = ((pos % queue.length) + queue.length) % queue.length;
  const song = songsById.get(queue[queuePos]);
  if (!song) return;

  els.art.classList.toggle("no-image", !song.imageUrl);
  els.art.style.opacity = "0";
  els.art.innerHTML = "";
  requestAnimationFrame(() => {
    if (song.imageUrl) {
      els.art.style.backgroundImage = `url("${song.imageUrl}")`;
    } else {
      els.art.style.backgroundImage = "none";
      els.art.innerHTML = `<span class="art-initial">${getTitleInitial(song.title)}</span>`;
    }
    requestAnimationFrame(() => { els.art.style.opacity = "1"; });
  });

  els.npIndex.textContent = `${String(queuePos + 1).padStart(2, "0")} / ${queue.length} · ${SORT_LABELS[sortMode]}`;
  els.npBadge.textContent = song.type || "";
  els.npTitle.textContent = song.title || "(제목 없음)";
  const dateStr = song.creationDate ? song.creationDate.split("-").join(". ") + "." : "";
  els.npSub.textContent = [song.creator, dateStr].filter(Boolean).join(" · ");

  // CORS가 지원되는 걸로 확인된 세션에서만 crossOrigin을 걸어 실제 음향 분석을 시도한다
  // (미확인/미지원 상태에서 걸면 로드 자체가 실패할 수 있어 재생을 우선한다).
  if (corsSupported) {
    els.audio.crossOrigin = "anonymous";
  }
  els.audio.src = song.mp3Url || "";
  setScreenState("playing");
  if (autoplay) play();
  if (libraryOpen) renderLibrary();
}

function play() {
  if (queuePos === -1) {
    if (queue.length) playAtQueuePos(0, true);
    return;
  }
  if (!els.audio.src) return;
  // CORS 미지원 상태에서는 <audio>가 Web Audio 그래프 없이 직접 재생한다 (항상 안전).
  // CORS 지원이 확인된 뒤에만 그래프를 연결해 실제 음향 분석 이퀄라이저를 켠다.
  if (corsSupported) ensureAudioGraph();
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  els.audio.play().catch((err) => {
    console.error("재생 실패:", err);
    showPlaybackError();
  });
}
function pause() {
  els.audio.pause();
}
function togglePlay() {
  if (queuePos === -1) { play(); return; }
  if (els.audio.paused) play(); else pause();
}
function prev() {
  if (queue.length === 0) return;
  if (queuePos === -1) { playAtQueuePos(0, true); return; }
  let pos = queuePos - 1;
  if (pos < 0) pos = queue.length - 1;
  playAtQueuePos(pos, true);
}
function next() {
  if (queue.length === 0) return;
  if (queuePos === -1) { playAtQueuePos(0, true); return; }
  let pos = queuePos + 1;
  if (pos >= queue.length) {
    // 한 바퀴를 다 돌면(전체 반복), 랜덤 모드는 매번 새 순서로 다시 섞는다.
    if (sortMode === "shuffle") rebuildQueue("shuffle");
    pos = 0;
  }
  playAtQueuePos(pos, true);
}

function openLibrary() {
  libraryOpen = true;
  renderLibrary();
  setScreenState("library");
}
function closeLibrary() {
  libraryOpen = false;
  setScreenState(queuePos === -1 ? "standby" : "playing");
}
function toggleMenu() {
  if (libraryOpen) closeLibrary(); else openLibrary();
}

function updatePlayIcon() {
  els.btnPlay.classList.toggle("is-playing", !els.audio.paused);
}

// analyser가 연결돼 있으면(CORS 지원 확인됨) 실제 음향 데이터로 막대를 움직이고,
// 아니면 CSS 애니메이션으로 대체한다.
function updateEqualizer() {
  const live = !els.audio.paused;
  if (analyser) {
    eqEl.classList.remove("is-live");
  } else {
    eqEl.classList.toggle("is-live", live);
  }
}

function tickRealEqualizer() {
  requestAnimationFrame(tickRealEqualizer);
  if (!analyser) return;
  if (els.audio.paused) {
    els.eq.forEach((bar) => { bar.style.transform = "scaleY(0.06)"; });
    return;
  }
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  const usableBins = Math.floor(data.length * 0.6);
  const step = usableBins / els.eq.length;
  els.eq.forEach((bar, i) => {
    const v = data[Math.floor(i * step)] / 255;
    bar.style.transform = `scaleY(${Math.max(0.06, v)})`;
  });
}

els.audio.addEventListener("timeupdate", () => {
  const { currentTime, duration } = els.audio;
  els.progressFill.style.width = duration ? `${(currentTime / duration) * 100}%` : "0%";
  els.timeCur.textContent = formatTime(currentTime);
  els.timeDur.textContent = formatTime(duration);
});

const LOADING_HINT_TEXT = "음원을 불러오고 있습니다…";
let loadingHintTimer = null;
function showLoadingHint() {
  els.loadingHint.textContent = LOADING_HINT_TEXT;
  clearTimeout(loadingHintTimer);
  loadingHintTimer = setTimeout(() => els.loadingHint.classList.add("visible"), 150);
}
function hideLoadingHint() {
  clearTimeout(loadingHintTimer);
  els.loadingHint.classList.remove("visible");
}
function showPlaybackError() {
  clearTimeout(loadingHintTimer);
  els.loadingHint.textContent = "이 곡을 재생할 수 없습니다. 다음 곡으로 넘어가려면 ▶▶를 눌러주세요.";
  els.loadingHint.classList.add("visible");
}
els.audio.addEventListener("loadstart", showLoadingHint);
els.audio.addEventListener("canplay", hideLoadingHint);
els.audio.addEventListener("playing", hideLoadingHint);
els.audio.addEventListener("error", () => {
  hideLoadingHint();
  showPlaybackError();
});

els.audio.addEventListener("ended", () => {
  if (repeatMode === "one") {
    els.audio.currentTime = 0;
    els.audio.play().catch(() => {});
  } else {
    next();
  }
});
els.audio.addEventListener("play", () => { updatePlayIcon(); updateEqualizer(); });
els.audio.addEventListener("pause", () => { updatePlayIcon(); updateEqualizer(); });

els.btnPrev.addEventListener("click", () => { playClick(); prev(); });
els.btnNext.addEventListener("click", () => { playClick(); next(); });
els.btnPlay.addEventListener("click", () => { playClick(); togglePlay(); });
els.btnMenu.addEventListener("click", () => { playClick(); toggleMenu(); });

const pressButtons = [els.btnPrev, els.btnPlay, els.btnNext, els.btnMenu];
pressButtons.forEach((btn) => {
  btn.addEventListener("pointerdown", () => btn.classList.add("is-pressed"));
});
function releaseAllPressed() {
  pressButtons.forEach((btn) => btn.classList.remove("is-pressed"));
}
window.addEventListener("pointerup", releaseAllPressed);
window.addEventListener("pointercancel", releaseAllPressed);

[els.sortNewBtn, els.sortOldBtn, els.sortShuffleBtn].forEach((btn) => {
  btn.addEventListener("click", () => {
    playClick();
    const mode = btn.dataset.sort;
    if (mode === sortMode && mode !== "shuffle") return;
    rebuildQueue(mode);
    writeStoredMode(STORAGE_KEY_SORT, sortMode);
    updateSortChips();
    renderLibrary();
    if (queuePos >= 0) {
      const song = songsById.get(queue[queuePos]);
      els.npIndex.textContent = `${String(queuePos + 1).padStart(2, "0")} / ${queue.length} · ${SORT_LABELS[sortMode]}`;
    }
  });
});

els.repeatBtn.addEventListener("click", () => {
  playClick();
  repeatMode = repeatMode === "all" ? "one" : "all";
  writeStoredMode(STORAGE_KEY_REPEAT, repeatMode);
  updateRepeatButton();
});

// ---- Firestore에서 전체 곡(메타데이터만) 로드 ----
async function loadSongs() {
  els.standbySub.textContent = "곡을 불러오는 중…";
  try {
    const snapshot = await getDocs(collection(db, collectionName));
    allSongs = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
    songsById = new Map(allSongs.map((s) => [s.id, s]));

    if (allSongs.length === 0) {
      els.standbySub.textContent = "등록된 곡이 없습니다.";
      return;
    }

    rebuildQueue(sortMode);
    updateSortChips();
    updateRepeatButton();
    els.standbySub.textContent = `${allSongs.length}곡 · 감상 준비완료`;
    probeCorsSupport(allSongs[0].mp3Url);
  } catch (error) {
    console.error("곡 목록 로딩 에러:", error);
    els.standbySub.textContent = "곡을 불러오지 못했습니다. 새로고침 해주세요.";
  }
}

setScreenState("standby");
tickRealEqualizer();
loadSongs();
