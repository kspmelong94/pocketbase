// CK 공통 유틸리티
// PocketBase v0.23+ 호환: 핸들러 내부에서 require()로 로드됨

const HENRIKDEV_BASE = "https://api.henrikdev.xyz";
const CK_CACHE_TTL = {
  account: 3600000,      // 1시간
  mmr: 1800000,          // 30분
  matches: 300000,       // 5분 (검증용 짧게)
  matchDetail: 3600000,  // 1시간
};

const CK_RATE_LIMIT_PER_MIN = 30; // 키당 분당 30콜 (HenrikDev 무료 티어)

// 현재 시즌 가져오기
function CKGetCurrentSeason() {
  const settings = CKGetSettings();
  const s = settings ? settings.getString("season") : "";
  return s || "2025-s1";
}

// 다음 시즌 계산 (필요시)
function CKGetNextSeason() {
  const current = CKGetCurrentSeason();
  const match = current.match(/^(\d{4})-(s[12])$/);
  if (!match) return "2025-s1";
  const year = parseInt(match[1], 10);
  const half = match[2];
  return half === "s1" ? `${year}-s2` : `${year + 1}-s1`;
}

// 설정 조회 (캐싱)
let _settingsCache = null;
let _settingsCacheAt = 0;
function CKGetSettings() {
  const now = Date.now();
  if (_settingsCache && now - _settingsCacheAt < 60000) return _settingsCache; // 1분 캐시
  try {
    const rows = $app.findRecordsByFilter("game_settings", "id != ''", "-id", 1, 0);
    if (rows && rows.length > 0) {
      _settingsCache = rows[0];
      _settingsCacheAt = now;
      return _settingsCache;
    }
  } catch (e) {
    /* 무시 */
  }
  return null;
}

// 설정 강제 갱신
function CKRefreshSettings() {
  _settingsCache = null;
  return CKGetSettings();
}

// 현재 시간 ISO 문자열
function CKNow() {
  return new Date().toISOString();
}

// ELO 소프트 리셋: 1000으로 50% 수렴
function CKSoftResetElo(prevElo) {
  return Math.round(1000 + (prevElo - 1000) * 0.5);
}

// 티어 번호 → 티어명
const TIER_NAMES = [
  "Unranked",
  "Iron 1", "Iron 2", "Iron 3",
  "Bronze 1", "Bronze 2", "Bronze 3",
  "Silver 1", "Silver 2", "Silver 3",
  "Gold 1", "Gold 2", "Gold 3",
  "Platinum 1", "Platinum 2", "Platinum 3",
  "Diamond 1", "Diamond 2", "Diamond 3",
  "Ascendant 1", "Ascendant 2", "Ascendant 3",
  "Immortal 1", "Immortal 2", "Immortal 3",
  "Radiant",
];

function CKTierKey(tierNum) {
  if (tierNum < 0 || tierNum >= TIER_NAMES.length) return "Unranked";
  return TIER_NAMES[tierNum];
}

function CKTierFromMMR(mmr) {
  // HenrikDev MMR → 티어 번호 근사치 (참고용)
  if (mmr < 100) return 0;
  if (mmr < 400) return 1 + Math.floor((mmr - 100) / 100); // Iron
  if (mmr < 700) return 4 + Math.floor((mmr - 400) / 100); // Bronze
  if (mmr < 1000) return 7 + Math.floor((mmr - 700) / 100); // Silver
  if (mmr < 1300) return 10 + Math.floor((mmr - 1000) / 100); // Gold
  if (mmr < 1600) return 13 + Math.floor((mmr - 1300) / 100); // Platinum
  if (mmr < 1900) return 16 + Math.floor((mmr - 1600) / 100); // Diamond
  if (mmr < 2200) return 19 + Math.floor((mmr - 1900) / 100); // Ascendant
  if (mmr < 2500) return 22 + Math.floor((mmr - 2200) / 100); // Immortal
  return 24; // Radiant
}

// 설정에서 티어별 초기 ELO 조회
function CKTierElo(settings, tierKey) {
  if (!settings) return null;
  // v0.39 Record 에 getJSON 이 없으므로 get() 으로 읽어 문자열이면 파싱
  let map = null;
  try {
    const raw = settings.get("ck_tier_elo");
    map = typeof raw === "string" ? CKSafeParse(raw, null) : raw;
  } catch (e) {
    map = null;
  }
  if (!map || typeof map !== "object") return null;
  return map[tierKey] || null;
}

// 랭킹 레코드 조회 (시즌별)
function CKRankingOf(userId, season) {
  const targetSeason = season || CKGetCurrentSeason();
  try {
    return $app.findFirstRecordByFilter("rankings", "user = {:u} && season = {:s}", {
      u: userId,
      s: targetSeason,
    });
  } catch (e) {
    return null;
  }
}

// 랭킹 생성/보장 (최초 등록 시)
function CKEnsureRanking(userId, initialElo, season) {
  const targetSeason = season || CKGetCurrentSeason();
  let ranking = CKRankingOf(userId, targetSeason);
  if (ranking) return ranking;
  const col = $app.findCollectionByNameOrId("rankings");
  ranking = new Record(col);
  ranking.set("user", userId);
  ranking.set("season", targetSeason);
  ranking.set("elo", initialElo || 1000);
  ranking.set("wins", 0);
  ranking.set("losses", 0);
  ranking.set("draws", 0);
  ranking.set("streak", "");
  ranking.set("peak_elo", initialElo || 1000);
  return ranking;
}

// 로깅 헬퍼
function CKLog(category, message, data) {
  const prefix = "[CK:" + category + "]";
  if (data !== undefined) {
    console.log(prefix, message, JSON.stringify(data));
  } else {
    console.log(prefix, message);
  }
  // 관리자 로그에도 기록 (선택적)
  try {
    $app.create("bz_admin_logs", {
      kind: "ck-" + category,
      message: message + (data ? " " + JSON.stringify(data) : ""),
    });
  } catch (e) {
    /* 무시 */
  }
}

// Riot ID 파싱 "Name#Tag" → { name, tag }
function CKParseRiotId(riotId) {
  const match = String(riotId || "").trim().match(/^(.+)#(.+)$/);
  if (!match) return null;
  return { name: match[1], tag: match[2] };
}

// JSON 안전 파싱
function CKSafeParse(jsonStr, fallback) {
  try {
    return JSON.parse(jsonStr);
  } catch {
    return fallback;
  }
}

// 팀 멤버 배열에서 userId로 팀 판별
function CKTeamOf(room, userId) {
  const teamA = CKSafeParse(room.getString("team_a"), []);
  const teamB = CKSafeParse(room.getString("team_b"), []);
  if (teamA.some((p) => p.user === userId)) return "a";
  if (teamB.some((p) => p.user === userId)) return "b";
  return null;
}

// 방의 모든 참가자 userId 배열
function CKAllUserIds(room) {
  const teamA = CKSafeParse(room.getString("team_a"), []);
  const teamB = CKSafeParse(room.getString("team_b"), []);
  return [...teamA.map((p) => p.user), ...teamB.map((p) => p.user)];
}

// 방 상태 유효성 검사
function CKIsActiveRoom(room) {
  const status = room.getString("status");
  return status === "ready" || status === "playing" || status === "settling";
}

// ELO 합계 계산 (배열 또는 JSON 문자열 모두 허용)
function CKEloSum(team) {
  let arr = team;
  if (typeof arr === "string") arr = CKSafeParse(arr, []);
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((sum, p) => sum + Number(p && p.elo || 0), 0);
}

module.exports = {
  HENRIKDEV_BASE,
  CK_CACHE_TTL,
  CK_RATE_LIMIT_PER_MIN,
  CKGetCurrentSeason,
  CKGetNextSeason,
  CKGetSettings,
  CKRefreshSettings,
  CKNow,
  CKSoftResetElo,
  CKTierKey,
  CKTierFromMMR,
  CKTierElo,
  CKRankingOf,
  CKEnsureRanking,
  CKLog,
  CKParseRiotId,
  CKSafeParse,
  CKTeamOf,
  CKAllUserIds,
  CKIsActiveRoom,
  CKEloSum,
  TIER_NAMES,
};