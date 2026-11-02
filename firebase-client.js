// 메인 페이지(index.html)와 감상 플레이어(player/)가 함께 쓰는 Firebase 연결 모듈.
//
// ★ firestore-lite 를 쓰는 이유 ★
// 일반 Firestore SDK의 getDocs()는 내부적으로 실시간 Listen 채널(WebChannel)을 열어서 결과를 받기 때문에
// 핸드셰이크 → 백채널 → 쿼리 등록 → 수신까지 여러 번 서버를 왕복한다. 해외(중국 등) 망처럼 왕복 한 번이
// 수백 ms인 환경에서는 이 왕복 횟수가 곧 로딩 시간이 된다.
// 이 앱은 실시간 업데이트가 필요 없으므로, REST 요청 한 번으로 끝나는 lite SDK를 쓴다(SDK 크기도 훨씬 작다).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore-lite.js";

const firebaseConfig = {
    apiKey: "AIzaSyCTwOAC_LrrKH8CKepUOTf0pyd9qRv4y_8",
    authDomain: "cnation-project.firebaseapp.com",
    projectId: "cnation-project",
    storageBucket: "cnation-project.firebasestorage.app",
    messagingSenderId: "1004154104261",
    appId: "1:1004154104261:web:0eac4c7ded38262ae5c3ac",
    measurementId: "G-7PW1NSP5EQ"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const collectionName = "cnation-ccm-list";

// Storage SDK는 곡 등록/수정(관리자 기능)에서만 필요하므로 첫 화면에서 받지 않고, 필요할 때 처음 한 번만 불러온다.
let storageModulePromise = null;
export async function loadStorage() {
    if (!storageModulePromise) {
        storageModulePromise = import("https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js")
            .catch((err) => { storageModulePromise = null; throw err; });
    }
    const mod = await storageModulePromise;
    return { ...mod, storage: mod.getStorage(app) };
}

// ★ 느린 망에서도 끝까지 기다리는 요청 ★
// 예전 방식(8초 안에 안 오면 버리고 처음부터 다시)은 응답에 8초 이상 걸리는 망에서는 영원히 성공할 수 없었고,
// 버린 요청도 백그라운드에서 계속 돌며 대역폭을 나눠 먹었다.
// 이제는 진행 중인 요청을 절대 버리지 않는다.
//  - 요청이 실패(에러)하거나 빈 결과면: 잠깐 쉬고 다시 요청
//  - 요청이 오래 멈춰 있으면(STALL_MS): 기존 요청은 그대로 둔 채 새 요청을 하나 더 보내고, 먼저 오는 응답을 쓴다
// makeRequest 는 성공 시 결과를, "아직 못 받음"이면 null 을 돌려줘야 한다.
// isActive() 가 false 가 되면(취소/새 요청으로 대체) null 로 끝난다.
const RETRY_GAP_MS = 1500;
const STALL_MS = 20000;
const MAX_PARALLEL = 3;

export function fetchPatiently(makeRequest, isActive) {
    return new Promise((resolve) => {
        let inFlight = 0;
        let finished = false;
        let stallTimer = null;
        let watchTimer = null;

        const finish = (result) => {
            if (finished) return;
            finished = true;
            clearTimeout(stallTimer);
            clearInterval(watchTimer);
            resolve(result);
        };
        const armStallTimer = () => {
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
                if (finished) return;
                if (inFlight < MAX_PARALLEL) launch();
                else armStallTimer();
            }, STALL_MS);
        };
        const retryLater = () => {
            if (!finished && inFlight === 0) setTimeout(launch, RETRY_GAP_MS);
        };
        const launch = () => {
            if (finished) return;
            if (!isActive()) { finish(null); return; }
            inFlight++;
            armStallTimer();
            Promise.resolve()
                .then(makeRequest)
                .then((result) => {
                    inFlight--;
                    if (finished) return;
                    if (!isActive()) { finish(null); return; }
                    if (result) finish(result);
                    else retryLater();
                }, (error) => {
                    inFlight--;
                    console.error("불러오기 에러 (재시도함):", error);
                    retryLater();
                });
        };
        // 취소되면 매달린 요청이 끝나길 기다리지 않고 바로 정리
        watchTimer = setInterval(() => { if (!isActive()) finish(null); }, 500);
        launch();
    });
}

// ★ 마지막으로 받은 목록을 기기에 저장해두고, 다음에 열 때 서버 응답 전에 바로 보여주기 ★
// 브라우저 저장소가 막혀 있어도(사생활 보호 모드 등) 앱은 정상 동작해야 하므로 모든 접근을 try/catch 로 감싼다.
const CACHE_VERSION = 1;
export function readCache(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed?.v !== CACHE_VERSION || !Array.isArray(parsed.songs) || parsed.songs.length === 0) return null;
        return parsed.songs;
    } catch { return null; }
}
export function writeCache(key, songs) {
    try {
        localStorage.setItem(key, JSON.stringify({ v: CACHE_VERSION, savedAt: Date.now(), songs }));
    } catch { /* 저장 공간 부족 등은 무시 */ }
}
// Firestore 문서를 캐시에 넣을 수 있는 순수 데이터로 변환 (Timestamp 등은 화면에 쓰지 않으므로 제외)
export function toPlainSong(docSnap) {
    const { createdAt, ...rest } = docSnap.data();
    return { id: docSnap.id, ...rest };
}
