// BATTLEZONE 발로란트 CK - 공용 헬퍼 모듈
// PUBG 킬내기(bz-lib.js)와 완전 분리된 CK(커스텀 5:5) 로직.
// PocketBase v0.23+ 핸들러 격리 환경에서 사용하므로 모든 헬퍼를 이 모듈로 내보낸다.
// 검증은 HenrikDev Unofficial Valorant API(v4) 를 서버에서 직접 호출한다.

const { BZBody, BZAuth, BZNow, BZFindById, BZFirst, BZLog, BZElo, BZStreakOf, BZNicknameOf } = require(`${__hooks}/bz-lib.js`);

// ---------- 상수 ----------

const CK_API = "https://api.henrikdev.xyz";
const CK_ACC_TTL = 30 * 24 * 3600 * 1000; // 계정(puuid/region): 30일
const CK_MMR_TTL = 6 * 3600 * 1000; // 티어(MMR): 6시간
const CK_LIST_TTL = 60 * 1000; // 매치 히스토리: 60초
const CK_MATCH_TTL = 7 * 24 * 3600 * 1000; // 매치 상세: 7일
const CK_VERIFY_TOL_MS = 15 * 60 * 1000; // 매치 시작 시각 허용 오차 (playing_at 기준 ±15분)
const CK_TEAM_SIZE = 5;
const CK_KEYS_MAX = 200;
const CK_MM_MAX_BATTLES_PER_TICK = 2; // 크론 틱당 최대 성사 대전 수
const CK_VERIFY_MAX_BATTLES = 50; // 크론 틱당 검증 재시도 상한
const CK_VERIFY_CONCURRENCY = 3; // 검증 동시 실행 수

// 키 레이트 리미터 (HenrikDev Basic 키 = 30 req/min)
const CK_RL_WINDOW_MS = 60000;
const CK_RL_MAX_PER_MIN = 30;

// 티어 키 → 초기 Elo 기본 매핑 (game_settings.ck_tier_elo JSON 으로 관리자 조정 가능)
// 키는 CKTierKey() 정규화 결과("iron1", "silver2", "radiant", "unranked" 등)와 일치해야 한다.
const CK_TIER_ELO_DEFAULT = {
  unranked: 1200,
  iron1: 650,
  iron2: 700,
  iron3: 750,
  bronze1: 800,
  bronze2: 850,
  bronze3: 900,
  silver1: 950,
  silver2: 1000,
  silver3: 1050,
  gold1: 1100,
  gold2: 1150,
  gold3: 1200,
  platinum1: 1300,
  platinum2: 1350,
  platinum3: 1400,
  diamond1: 1500,
  diamond2: 1550,
  diamond3: 1600,
  ascendant1: 1700,
  ascendant2: 1750,
  ascendant3: 1800,
  immortal1: 1900,
  immortal2: 2000,
  immortal3: 2100,
  radiant: 2300,
};
const CK_DEFAULT_INITIAL_ELO = 1200; // 언랭/데이터 없음

// ---------- 설정 ----------

/** CK 전용 설정 조회 (game_settings 단일 레코드의 ck_* 필드) */
function CKSettings() {
  const rec = BZFirst("game_settings", "");
  if (!rec) return null;
  return {
    season: rec.getString("season") || "시즌 1",
    target_rounds: Number(rec.get("ck_target_rounds") ?? 13) || 13,
    elo_k: Number(rec.get("ck_elo_k") ?? 32) || 32,
    initial_elo: Number(rec.get("ck_initial_elo") ?? CK_DEFAULT_INITIAL_ELO) || CK_DEFAULT_INITIAL_ELO,
    match_elo_range: Number(rec.get("ck_match_elo_range") ?? 250) || 250,
    relax_step: Number(rec.get("ck_relax_step") ?? 150) || 150,
    relax_after_min: Number(rec.get("ck_relax_after_min") ?? 3) || 3,
    matching_enabled: rec.getBool("ck_matching_enabled") !== false,
    timeout_min: Number(rec.get("ck_timeout_min") ?? 5) || 5,
    verify_max_min: Number(rec.get("ck_verify_max_min") ?? 10) || 10,
    tier_elo: CKParseTierElo(rec.get("ck_tier_elo")),
  };
}

function CKParseTierElo(raw) {
  if (!raw || typeof raw !== "object") return { ...CK_TIER_ELO_DEFAULT };
  const map = {};
  for (const [k, v] of Object.entries(CK_TIER_ELO_DEFAULT)) map[k] = v;
  for (const [k, v] of Object.entries(raw)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) map[String(k)] = n;
  }
  return map;
}

/** 티어 키("iron3" 등) → 초기 Elo (미정의/언랭 → 기본값) */
function CKTierElo(settings, tierKey) {
  const t = String(tierKey || "").trim().toLowerCase();
  if (settings && settings.tier_elo && settings.tier_elo[t]) return Number(settings.tier_elo[t]);
  return Number(CK_TIER_ELO_DEFAULT[t] ?? CK_DEFAULT_INITIAL_ELO);
}

/** HenrikDev 티어명("Iron 3", "Radiant", "Unranked") → 티어 키("iron3", "radiant", "unranked") */
function CKTierKey(tierName) {
  const t = String(tierName || "").trim().toLowerCase().replace(/[\s\-]/g, "");
  if (!t || t === "unrated" || t === "unknown" || t === "incomplete" || t === "none") return "unranked";
  return t;
}

// ---------- 캐시 (bz_valorant_cache) ----------

function CKCacheGet(key) {
  try {
    const rec = $app.findFirstRecordByFilter("bz_valorant_cache", "key = {:k}", { k: key });
    if (!rec) return null;
    const exp = rec.getString("expires_at");
    if (exp && new Date(exp).getTime() < Date.now()) return null;
    const raw = rec.getString("payload");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function CKCacheSet(key, payload, ttlMs) {
  try {
    let rec = null;
    try {
      rec = $app.findFirstRecordByFilter("bz_valorant_cache", "key = {:k}", { k: key });
    } catch (e) {
      rec = null;
    }
    if (!rec) {
      rec = new Record($app.findCollectionByNameOrId("bz_valorant_cache"));
      rec.set("key", key);
    }
    rec.set("payload", JSON.stringify(payload));
    rec.set("expires_at", new Date(Date.now() + ttlMs).toISOString());
    $app.save(rec);
  } catch (e) {
    /* 캐시 실패는 치명적이지 않음 */
  }
}

// ---------- 키 레이트 리미터 (bz_valorant_keys) ----------

function CKHasEnabledKeys() {
  try {
    const keys = $app.findRecordsByFilter("bz_valorant_keys", "enabled = true", "label", 1, 0);
    return Boolean(keys && keys.length);
  } catch (e) {
    return false;
  }
}

function CKWindowOf(keyId, now) {
  const storeKey = "ck_rl_" + keyId;
  let arr = $app.store().get(storeKey);
  if (!Array.isArray(arr)) {
    arr = [];
    $app.store().set(storeKey, arr);
  }
  const fresh = arr.filter((t) => now - t < CK_RL_WINDOW_MS);
  $app.store().set(storeKey, fresh);
  return fresh;
}

/** 여유가 있는 키 획득 (전부 소진이면 null) */
function CKAcquireKey() {
  let keys = [];
  try {
    keys = $app.findRecordsByFilter("bz_valorant_keys", "enabled = true", "label", CK_KEYS_MAX, 0);
  } catch (e) {
    return null;
  }
  if (!keys || !keys.length) return null;
  const now = Date.now();
  let best = null;
  for (const k of keys) {
    const arr = CKWindowOf(k.id, now);
    if (arr.length < CK_RL_MAX_PER_MIN && (!best || arr.length < best.used)) {
      best = { key: k, used: arr.length };
    }
  }
  if (!best) return null;
  const win = CKWindowOf(best.key.id, now);
  win.push(now);
  try {
    best.key.set("last_used_at", new Date(now).toISOString());
    $app.save(best.key);
  } catch (e) {
    /* 무시 */
  }
  return best.key;
}

function CKMarkKeyFailure(key, reason) {
  try {
    const fc = key.getInt("fail_count") + 1;
    key.set("fail_count", fc);
    if (fc >= 3) {
      key.set("enabled", false);
      BZLog("ck-keys", "발로란트 키 자동 비활성화 (연속 실패 " + fc + "회): " + key.getString("label") + " (" + reason + ")");
    } else {
      BZLog("ck-keys", "발로란트 키 실패 " + fc + "회: " + key.getString("label") + " (" + reason + ")");
    }
    $app.save(key);
  } catch (e) {
    /* 무시 */
  }
}

/** 관리자 UI 용: 키별 현재 윈도우 사용량 */
function CKRateUsage() {
  let keys = [];
  try {
    keys = $app.findRecordsByFilter("bz_valorant_keys", "", "label", CK_KEYS_MAX, 0);
  } catch (e) {
    return [];
  }
  const now = Date.now();
  return keys.map((k) => ({
    id: k.id,
    label: k.getString("label"),
    enabled: k.getBool("enabled"),
    used: CKWindowOf(k.id, now).length,
    limit: CK_RL_MAX_PER_MIN,
  }));
}

// ---------- HenrikDev API ----------

/**
 * HenrikDev API GET 요청 (레이트 리미터 통과).
 * @returns {{noKeys?: boolean, rateLimited?: boolean, notFound?: boolean, error?: string, json?: object}}
 */
async function CKValGet(path) {
  const key = CKAcquireKey();
  if (!key) {
    return CKHasEnabledKeys() ? { rateLimited: true } : { noKeys: true };
  }
  try {
    const sep = path.indexOf("?") >= 0 ? "&" : "?";
    const res = await $http.send({
      url: CK_API + path + sep + "api_key=" + encodeURIComponent(key.getString("key")),
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "BattleZone-App/1.0 (battlezoneapp.kro.kr)",
      },
      timeout: 20000,
    });
    if (res.statusCode === 404) return { notFound: true };
    if (res.statusCode === 429) return { rateLimited: true };
    if (res.statusCode !== 200) {
      if (res.statusCode === 401 || res.statusCode === 403) {
        CKMarkKeyFailure(key, "HenrikDev 인증 오류 " + res.statusCode);
        return { error: "HenrikDev 인증 오류 " + res.statusCode + " (키가 유효하지 않을 수 있습니다)" };
      }
      return { error: "HenrikDev API 오류 " + res.statusCode };
    }
    try {
      key.set("fail_count", 0);
      $app.save(key);
    } catch (e) {
      /* 무시 */
    }
    return { json: res.json || {} };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

/** Riot ID "이름#태그" 파싱 (형식 검증) */
function CKParseRiotId(riotId) {
  const raw = String(riotId || "").trim();
  const idx = raw.lastIndexOf("#");
  if (idx <= 0 || idx === raw.length - 1) return null;
  const name = raw.slice(0, idx).trim();
  const tag = raw.slice(idx + 1).trim();
  if (!name || name.length > 16) return null;
  if (!/^[A-Za-z0-9]{3,5}$/.test(tag)) return null;
  return { name, tag, key: (name + "#" + tag).toLowerCase() };
}

/**
 * Riot ID → 계정 정보 (puuid/region). 캐시 30일.
 * @returns {{ok?: boolean, error?: string, notFound?: boolean, rateLimited?: boolean, noKeys?: boolean, name?: string, tag?: string, puuid?: string, affinity?: string}}
 */
async function CKAccount(riotId) {
  const parsed = CKParseRiotId(riotId);
  if (!parsed) return { error: "Riot ID 형식이 올바르지 않습니다. (이름#TAG)" };
  const cacheKey = "ck:acc:" + parsed.key;
  const cached = CKCacheGet(cacheKey);
  if (cached) return { ok: true, ...cached };
  const res = await CKValGet(
    "/valorant/v2/account/" + encodeURIComponent(parsed.name) + "/" + encodeURIComponent(parsed.tag)
  );
  if (res.noKeys) return { noKeys: true };
  if (res.rateLimited) return { rateLimited: true };
  if (res.notFound || !res.json || !res.json.data) {
    return { notFound: true, error: "계정을 찾을 수 없습니다. Riot ID를 확인해 주세요." };
  }
  const d = res.json.data;
  const info = {
    name: String(d.name || parsed.name),
    tag: String(d.tag || parsed.tag),
    puuid: String(d.puuid || ""),
    affinity: String(d.region || d.affinity || "").toLowerCase(),
  };
  if (!info.puuid) return { error: "puuid 를 확인할 수 없습니다." };
  CKCacheSet(cacheKey, info, CK_ACC_TTL);
  return { ok: true, ...info };
}

/**
 * puuid → 현재 티어 (currenttier / currenttierpatched). 캐시 6시간.
 * @returns {{ok?: boolean, error?: string, rateLimited?: boolean, noKeys?: boolean, tier?: number, tierName?: string}}
 */
async function CKMMR(puuid, affinity) {
  const aff = String(affinity || "ap");
  const cacheKey = "ck:mmr:" + puuid;
  const cached = CKCacheGet(cacheKey);
  if (cached) return { ok: true, tier: cached.tier, tierName: cached.tierName };
  const res = await CKValGet("/valorant/v2/by-puuid/mmr/" + encodeURIComponent(aff) + "/" + encodeURIComponent(puuid));
  if (res.noKeys) return { noKeys: true };
  if (res.rateLimited) return { rateLimited: true };
  if (res.notFound || !res.json || !res.json.data) {
    return { ok: true, tier: 0, tierName: "" }; // MMR 없음 = 언랭
  }
  const cur = res.json.data.current_data || {};
  const tier = Number(cur.currenttier || 0);
  const tierName = String(cur.currenttierpatched || "");
  CKCacheSet(cacheKey, { tier, tierName }, CK_MMR_TTL);
  return { ok: true, tier, tierName };
}

/**
 * 최근 커스텀 매치 목록 (mode=Custom). 캐시 60초.
 * @returns {{ok?: boolean, error?: string, rateLimited?: boolean, noKeys?: boolean, matches?: object[]}}
 */
async function CKRecentCustomMatches(puuid, affinity) {
  const aff = String(affinity || "ap");
  const cacheKey = "ck:list:" + puuid;
  const cached = CKCacheGet(cacheKey);
  if (cached && Array.isArray(cached)) return { ok: true, matches: cached };
  const res = await CKValGet(
    "/valorant/v4/by-puuid/matches/" + encodeURIComponent(aff) + "/pc/" + encodeURIComponent(puuid) +
      "?mode=Custom&size=5"
  );
  if (res.noKeys) return { noKeys: true };
  if (res.rateLimited) return { rateLimited: true };
  if (res.error) return { error: res.error };
  const list = (res.json && res.json.data) || [];
  const matches = Array.isArray(list) ? list : [];
  if (matches.length) CKCacheSet(cacheKey, matches, CK_LIST_TTL);
  return { ok: true, matches };
}

// ---------- 랭킹 (bz_ck_rankings) ----------

function CKRankingOf(userId) {
  try {
    return BZFirst("bz_ck_rankings", "user = {:u}", { u: userId });
  } catch (e) {
    return null;
  }
}

function CKEnsureRanking(userId, initialElo) {
  let rec = CKRankingOf(userId);
  if (rec) return rec;
  rec = new Record($app.findCollectionByNameOrId("bz_ck_rankings"));
  rec.set("user", userId);
  rec.set("nickname", BZNicknameOf(userId));
  rec.set("elo", initialElo);
  rec.set("wins", 0);
  rec.set("losses", 0);
  rec.set("draws", 0);
  rec.set("streak", "");
  try {
    $app.save(rec);
  } catch (e) {
    /* 무시 */
  }
  return rec;
}

/** 랭킹에 저장된 puuid (Riot ID 등록 시 기록). 없으면 null */
function CKPuuidOf(userId) {
  const rec = CKRankingOf(userId);
  return rec && rec.getString("puuid") ? rec.getString("puuid") : null;
}

/** 랭킹에 저장된 affinity */
function CKAffinityOf(userId) {
  const rec = CKRankingOf(userId);
  return rec && rec.getString("affinity") ? rec.getString("affinity") : "ap";
}

// ---------- 대전/팀 헬퍼 (bz_ck_battles) ----------

function CKTeamA(battle) {
  try {
    const a = battle.get("team_a");
    return Array.isArray(a) ? a : [];
  } catch (e) {
    return [];
  }
}

function CKTeamB(battle) {
  try {
    const b = battle.get("team_b");
    return Array.isArray(b) ? b : [];
  } catch (e) {
    return [];
  }
}

function CKTeamOf(battle, userId) {
  if (CKTeamA(battle).some((p) => p.user === userId)) return "a";
  if (CKTeamB(battle).some((p) => p.user === userId)) return "b";
  return null;
}

function CKTeamUserIds(team) {
  return (team || []).map((p) => p.user).filter(Boolean);
}

function CKTeamEloSum(team) {
  return (team || []).reduce((s, p) => s + Number(p.elo || 0), 0);
}

function CKAllUserIds(battle) {
  return CKTeamUserIds(CKTeamA(battle)).concat(CKTeamUserIds(CKTeamB(battle)));
}

/** 경기 종료 신고 목록 */
function CKReports(battle) {
  try {
    const r = battle.get("reports");
    return Array.isArray(r) ? r : [];
  } catch (e) {
    return [];
  }
}

/** 팀 Elo 평균 (매칭 시점 elo_sum 사용 — 중간 변동 방지) */
function CKTeamAvgElo(battle, side) {
  const sum = side === "a" ? Number(battle.get("elo_sum_a") || 0) : Number(battle.get("elo_sum_b") || 0);
  const n = CK_TEAM_SIZE;
  return n > 0 ? sum / n : 0;
}

// ---------- 매칭 ----------

/**
 * 대기열에서 Elo 스프레드가 최소인 10인 그룹을 찾아 5:5 팀 분배 후 대전 생성.
 * 스프레드 한도는 가장 오래 기다린 유저의 대기 시간에 따라 점진 완화된다.
 * (기준 ±match_elo_range → relax_after_min 경과마다 +relax_step)
 * @returns {number} 성사된 대전 수
 */
function CKRunMatchmaking() {
  if ($app.store().get("ck_mm_busy")) return 0;
  $app.store().set("ck_mm_busy", true);
  try {
    const s = CKSettings();
    if (!s || !s.matching_enabled) return 0;

    let waiting = [];
    try {
      waiting = $app.findRecordsByFilter(
        "bz_ck_queue",
        "status = 'waiting' && season = {:s}",
        "created",
        100,
        0,
        { s: s.season }
      );
    } catch (e) {
      return 0;
    }
    if (waiting.length < CK_TEAM_SIZE * 2) return 0;

    // 대기 시간별 스프레드 한도 (점진 완화)
    const now = Date.now();
    const baseRange = s.match_elo_range;
    let oldestMs = now;
    for (const q of waiting) {
      const qMs = new Date(q.getString("queued_at") || q.getString("created") || "").getTime();
      if (qMs && qMs < oldestMs) oldestMs = qMs;
    }
    const waitMin = Math.max(0, (now - oldestMs) / 60000);
    const relaxLevel = s.relax_after_min > 0 ? Math.floor(waitMin / s.relax_after_min) : 0;
    const limit = baseRange + relaxLevel * s.relax_step;

    const sorted = waiting
      .map((q) => ({ q, elo: Number(q.getInt("elo") || 0) }))
      .sort((a, b) => a.elo - b.elo);

    // 인접 10인 슬라이딩 윈도우 중 스프레드 ≤ 한도 이면서 최소인 그룹 선택
    let best = null;
    for (let i = 0; i + CK_TEAM_SIZE * 2 <= sorted.length; i++) {
      const group = sorted.slice(i, i + CK_TEAM_SIZE * 2);
      const spread = group[group.length - 1].elo - group[0].elo;
      if (spread <= limit && (!best || spread < best.spread)) {
        best = { spread, group };
      }
    }
    if (!best) return 0;

    // 5:5 팀 분배: 내림차순 정렬 → 합이 낮은 팀에 순차 배정 → 인접 스왑 보정
    const desc = [...best.group].sort((a, b) => b.elo - a.elo);
    const teamA = [];
    const teamB = [];
    for (const p of desc) {
      const sumA = CKTeamEloSum(teamA);
      const sumB = CKTeamEloSum(teamB);
      if (sumA <= sumB) teamA.push(p);
      else teamB.push(p);
    }
    // 스왑 보정 (반복 횟수 제한)
    for (let pass = 0; pass < 10; pass++) {
      const diff = CKTeamEloSum(teamA) - CKTeamEloSum(teamB);
      if (Math.abs(diff) <= 1) break;
      let improved = false;
      for (let i = 0; i < teamA.length && !improved; i++) {
        for (let j = 0; j < teamB.length && !improved; j++) {
          const newDiff = diff - 2 * (teamA[i].elo - teamB[j].elo);
          if (Math.abs(newDiff) < Math.abs(diff)) {
            const tmp = teamA[i];
            teamA[i] = teamB[j];
            teamB[j] = tmp;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }

    const battle = new Record($app.findCollectionByNameOrId("bz_ck_battles"));
    const teamPayload = (team) =>
      team.map((p) => {
        const rec = CKRankingOf(p.q.getString("user"));
        return {
          user: p.q.getString("user"),
          nickname: rec ? rec.getString("nickname") : "",
          riot_id: rec ? rec.getString("riot_id") : "",
          puuid: rec ? rec.getString("puuid") : "",
          affinity: rec ? rec.getString("affinity") : "",
          elo: p.elo,
          tier: rec ? rec.getInt("tier") : 0,
          tier_name: rec ? rec.getString("tier_name") : "",
        };
      });
    battle.set("season", s.season);
    battle.set("target_rounds", s.target_rounds);
    battle.set("team_a", teamPayload(teamA));
    battle.set("team_b", teamPayload(teamB));
    battle.set("elo_sum_a", CKTeamEloSum(teamA));
    battle.set("elo_sum_b", CKTeamEloSum(teamB));
    battle.set("spread", best.spread);
    battle.set("status", "pending");
    battle.set("score_a", 0);
    battle.set("score_b", 0);
    battle.set("team_a_ready", false);
    battle.set("team_b_ready", false);
    battle.set("reports", []);
    battle.set("verify_attempts", 0);
    battle.set("elo_deltas", {});
    $app.save(battle);

    const all = [...teamA, ...teamB];
    for (const p of all) {
      p.q.set("status", "matched");
      p.q.set("battle_id", battle.id);
      $app.save(p.q);
    }

    BZLog("ck-match", "CK 매칭 성공: " + battle.id +
      " (A " + teamA.length + "인 합 " + battle.get("elo_sum_a") + " / B " + teamB.length + "인 합 " + battle.get("elo_sum_b") +
      " · 스프레드 " + best.spread + " · 한도 " + limit + ")");
    return 1;
  } catch (e) {
    BZLog("ck-match", "CK 매칭 실패: " + String((e && e.message) || e));
    return 0;
  } finally {
    $app.store().set("ck_mm_busy", false);
  }
}

/** 크론용 묶음 매칭. @returns {number} 성사된 대전 수 */
function CKRunMatchmakingDrain(maxBattles) {
  const cap = maxBattles ?? CK_MM_MAX_BATTLES_PER_TICK;
  let made = 0;
  while (made < cap) {
    const n = CKRunMatchmaking();
    if (!n) break;
    made += n;
  }
  return made;
}

// ---------- 대전 플로우 ----------

/** 시작 확인 (팀 단위: 팀 아무나 1명이 확인하면 해당 팀 준비 완료). @returns {{ok: boolean, message: string, started?: boolean}} */
function CKConfirmStart(battle, userId) {
  const side = CKTeamOf(battle, userId);
  if (!side) return { ok: false, message: "대전 참가자가 아닙니다." };
  const status = battle.getString("status");
  if (status !== "pending") return { ok: false, message: "대기 상태의 대전만 시작 확인할 수 있습니다." };
  const readyKey = side === "a" ? "team_a_ready" : "team_b_ready";
  if (battle.getBool(readyKey)) return { ok: false, message: "이미 시작 확인된 팀입니다." };
  battle.set(readyKey, true);
  const both = battle.getBool("team_a_ready") && battle.getBool("team_b_ready");
  if (both) {
    battle.set("status", "playing");
    battle.set("playing_at", BZNow());
  }
  $app.save(battle);
  return {
    ok: true,
    started: both,
    message: both ? "양 팀 시작 확인 완료. 대전이 시작되었습니다." : "팀 시작 확인이 완료되었습니다. 상대 팀의 확인을 기다립니다.",
  };
}

/** 경기 종료 신고 (스코어 미제출 — 스코어는 HenrikDev 검증 결과만 사용). @returns {{ok: boolean, message: string}} */
function CKReportEnd(battle, userId) {
  const side = CKTeamOf(battle, userId);
  if (!side) return { ok: false, message: "대전 참가자가 아닙니다." };
  const status = battle.getString("status");
  if (status !== "playing" && status !== "settling") {
    return { ok: false, message: "진행 중인 대전만 종료 신고할 수 있습니다." };
  }
  const reports = CKReports(battle);
  if (reports.some((r) => r.user === userId)) {
    return { ok: false, message: "이미 경기 종료를 신고했습니다." };
  }
  reports.push({ user: userId, at: BZNow() });
  battle.set("reports", reports);
  if (status === "playing") {
    battle.set("status", "settling");
    battle.set("verify_attempts", 0);
  }
  $app.save(battle);
  return { ok: true, message: "경기 종료가 신고되었습니다. 서버가 실제 매치를 검증 중입니다..." };
}

/**
 * HenrikDev 검증: 신고자 히스토리에서 대전 시간대의 커스텀 매치를 찾아
 * 10인 전원 포함 여부를 확인하고 스코어/승리팀을 API 결과로 확정한다.
 * @returns {{ok: boolean, found?: boolean, message: string}}
 */
async function CKVerifyBattle(battle) {
  const status = battle.getString("status");
  if (status !== "settling") return { ok: false, found: false, message: "검증 가능한 상태가 아닙니다." };
  if (battle.getString("finished_at")) return { ok: true, found: true, message: "이미 정산된 대전입니다." };

  const s = CKSettings();
  const maxAttempts = s && s.verify_max_min > 0 ? Math.ceil(s.verify_max_min / 2) : 5;
  const attempts = battle.getInt("verify_attempts") + 1;
  battle.set("verify_attempts", attempts);
  battle.set("last_verified_at", BZNow());

  const reports = CKReports(battle);
  const reporterId = reports.length ? reports[0].user : null;
  if (!reporterId) {
    $app.save(battle);
    return { ok: false, found: false, message: "종료 신고가 없습니다." };
  }
  const puuid = CKPuuidOf(reporterId);
  if (!puuid) {
    battle.set("status", "mismatch");
    $app.save(battle);
    return { ok: false, found: false, message: "신고자의 puuid 를 찾을 수 없습니다. Riot ID를 다시 등록해 주세요." };
  }
  const affinity = CKAffinityOf(reporterId);

  // 대전 10인 puuid 목록 (전원 포함 확인용)
  const teamPuuids = {};
  const allUsers = CKAllUserIds(battle);
  for (const uid of allUsers) {
    const p = CKPuuidOf(uid);
    if (!p) {
      battle.set("status", "mismatch");
      $app.save(battle);
      return { ok: false, found: false, message: "참가자 중 Riot ID가 등록되지 않은 사용자가 있습니다." };
    }
    teamPuuids[p] = uid;
  }

  const playingAtMs = new Date(battle.getString("playing_at") || battle.getString("created") || "").getTime();
  const fromMs = playingAtMs - CK_VERIFY_TOL_MS;
  const toMs = Date.now() + 5 * 60 * 1000;

  const res = await CKRecentCustomMatches(puuid, affinity);
  if (res.noKeys) {
    $app.save(battle);
    return { ok: false, found: false, message: "발로란트 API 키가 등록되지 않았거나 비활성 상태입니다. 관리자 설정에서 확인해 주세요." };
  }
  if (res.rateLimited) {
    $app.save(battle);
    return { ok: false, found: false, message: "발로란트 API 호출 한도에 도달했습니다. 잠시 후 자동으로 재시도됩니다." };
  }
  if (res.error) {
    $app.save(battle);
    return { ok: false, found: false, message: "매치 조회 실패: " + res.error };
  }

  const matches = (res.matches || []).filter((m) => {
    const meta = m && m.metadata;
    if (!meta) return false;
    const queueId = meta.queue && (meta.queue.id || meta.queue.name || "");
    const q = String(queueId || "").toLowerCase();
    if (q !== "custom") return false;
    if (meta.is_completed === false) return false;
    const startedMs = new Date(meta.started_at || "").getTime();
    if (!startedMs || startedMs < fromMs || startedMs > toMs) return false;
    return true;
  });

  let found = null;
  for (const m of matches) {
    const players = (m.players || []).filter((p) => p && p.puuid && p.team_id);
    const seen = {};
    for (const p of players) seen[p.puuid] = p;
    // 대전 10인 전원 포함 확인
    let allPresent = true;
    for (const p of Object.keys(teamPuuids)) {
      if (!seen[p]) {
        allPresent = false;
        break;
      }
    }
    if (!allPresent) continue;
    const reporter = seen[puuid];
    const reporterColor = reporter.team_id;
    const teams = m.teams || [];
    const winnerTeam = teams.find((t) => t.won === true);
    if (!winnerTeam || teams.length < 2) continue;
    // 신고자 색 → 우리 팀 사이드("a"/"b") 매핑, 상대 색은 나머지 팀
    const reporterSide = CKTeamOf(battle, reporterId);
    const otherColor = teams.find((t) => t.team_id !== reporterColor);
    const colorA = reporterSide === "a" ? reporterColor : otherColor.team_id;
    const colorB = reporterSide === "b" ? reporterColor : otherColor.team_id;
    const teamATeam = teams.find((t) => t.team_id === colorA);
    const teamBTeam = teams.find((t) => t.team_id === colorB);
    if (!teamATeam || !teamBTeam) continue;
    const winnerSide = winnerTeam.team_id === colorA ? "a" : "b";
    found = {
      matchId: m.metadata.match_id || "",
      map: (m.metadata.map && (m.metadata.map.name || m.metadata.map.id)) || "",
      scoreA: Number((teamATeam.rounds && teamATeam.rounds.won) || 0),
      scoreB: Number((teamBTeam.rounds && teamBTeam.rounds.won) || 0),
      winner: winnerSide,
    };
    break;
  }

  if (!found) {
    $app.save(battle);
    const remain = Math.max(0, maxAttempts - attempts);
    return {
      ok: false,
      found: false,
      message: remain > 0
        ? "아직 실제 매치를 찾지 못했습니다. " + remain + "회 더 자동 재시도합니다."
        : "검증 재시도 한도를 초과했습니다. 관리자 판정이 필요합니다.",
    };
  }

  battle.set("match_id", found.matchId);
  battle.set("map", found.map);
  battle.set("score_a", found.scoreA);
  battle.set("score_b", found.scoreB);
  battle.set("winner", found.winner);
  battle.set("status", "finished");
  $app.save(battle);

  const settled = CKDoSettle(battle);
  if (settled.ok) {
    return { ok: true, found: true, message: "매치 검증 완료: " + found.map + " " + found.scoreA + ":" + found.scoreB + " · Elo 정산 완료" };
  }
  return { ok: true, found: true, message: "매치 검증 완료: " + found.map + " " + found.scoreA + ":" + found.scoreB + " · 정산은 자동 처리됩니다." };
}

/**
 * Elo 정산: 승리 팀 5명 +Δ / 패배 팀 5명 −Δ (팀 평균 Elo 기반 기대 승률, 개인 Elo 반영).
 * finished / forfeit 상태에서만 동작, finished_at 있으면 무시.
 */
function CKDoSettle(battle) {
  const status = battle.getString("status");
  if (status !== "finished" && status !== "forfeit") return { ok: false, message: "정산 가능한 상태가 아닙니다." };
  if (battle.getString("finished_at")) return { ok: true, already: true };

  const s = CKSettings();
  const k = s ? s.elo_k : 32;
  const initialElo = s ? s.initial_elo : CK_DEFAULT_INITIAL_ELO;
  const avgA = CKTeamAvgElo(battle, "a");
  const avgB = CKTeamAvgElo(battle, "b");
  const winner = battle.getString("winner"); // "a" | "b"
  const scoreA = winner === "a" ? 1 : 0;
  const resA = BZElo(avgA, avgB, scoreA, k);
  const resB = BZElo(avgB, avgA, 1 - scoreA, k);

  const deltas = {};
  const applyTeam = (team, won, delta) => {
    for (const p of team) {
      const rec = CKEnsureRanking(p.user, initialElo);
      const cur = Number(rec.getInt("elo") || initialElo);
      const next = Math.max(0, cur + delta);
      rec.set("elo", next);
      rec.set("wins", rec.getInt("wins") + (won ? 1 : 0));
      rec.set("losses", rec.getInt("losses") + (won ? 0 : 1));
      rec.set("streak", BZStreakOf(rec.getString("streak"), won));
      try {
        $app.save(rec);
      } catch (e) {
        /* 무시 */
      }
      deltas[p.user] = next - cur;
    }
  };

  applyTeam(CKTeamA(battle), scoreA === 1, resA.delta);
  applyTeam(CKTeamB(battle), scoreA === 0, resB.delta);
  battle.set("elo_deltas", deltas);
  battle.set("finished_at", BZNow());
  try {
    $app.save(battle);
  } catch (e) {
    return { ok: false, message: "대전 저장 실패" };
  }
  BZLog("ck-settle", "CK 정산: " + battle.id + " (winner=" + winner + ", Δ" + resA.delta + "/" + resB.delta + ")");
  return { ok: true, winner, eloDeltaA: resA.delta, eloDeltaB: resB.delta };
}

/** 대기열 취소 시 대기(pending) 대전 취소 + 나머지 9명 큐 복구 */
function CKHandleQueueCancel(battleId, userId) {
  const battle = BZFindById("bz_ck_battles", battleId);
  if (!battle) return;
  if (battle.getString("status") !== "pending") return;
  try {
    battle.set("status", "cancelled");
    $app.save(battle);
    const others = CKAllUserIds(battle).filter((uid) => uid !== userId);
    for (const uid of others) {
      const q = BZFirst("bz_ck_queue", "battle_id = {:b} && user = {:u} && status = 'matched'", {
        b: battleId,
        u: uid,
      });
      if (q) {
        q.set("status", "waiting");
        q.set("battle_id", "");
        $app.save(q);
      }
    }
    BZLog("ck-match", "CK 대전 취소(대기열 이탈): " + battleId);
  } catch (e) {
    /* 무시 */
  }
}

/**
 * 크론: settling 상태 대전 검증 재시도 (2분 간격).
 * @returns {Promise<{ok: boolean, verified: number, mismatched: number}>}
 */
async function CKAutoVerifyAll() {
  if ($app.store().get("ck_verify_busy")) return { ok: false, busy: true };
  $app.store().set("ck_verify_busy", true);
  try {
    let settling = [];
    try {
      settling = $app.findRecordsByFilter("bz_ck_battles", "status = 'settling'", "created", CK_VERIFY_MAX_BATTLES, 0);
    } catch (e) {
      return { ok: true, verified: 0, mismatched: 0 };
    }
    let verified = 0;
    let mismatched = 0;
    const worker = async (battle) => {
      const s = CKSettings();
      const maxAttempts = s && s.verify_max_min > 0 ? Math.ceil(s.verify_max_min / 2) : 5;
      if (battle.getInt("verify_attempts") >= maxAttempts) {
        battle.set("status", "mismatch");
        $app.save(battle);
        mismatched++;
        BZLog("ck-verify", "검증 한도 초과 → mismatch: " + battle.id);
        return;
      }
      const r = await CKVerifyBattle(battle);
      if (r.found) verified++;
      else if (battle.getString("status") === "mismatch") mismatched++;
    };
    for (let i = 0; i < settling.length; i += CK_VERIFY_CONCURRENCY) {
      const chunk = settling.slice(i, i + CK_VERIFY_CONCURRENCY);
      await Promise.all(chunk.map((b) => worker(b)));
    }
    return { ok: true, verified, mismatched };
  } finally {
    $app.store().set("ck_verify_busy", false);
  }
}

// ---------- 모듈 내보내기 ----------

module.exports = {
  CK_API: CK_API,
  CK_TIER_ELO_DEFAULT: CK_TIER_ELO_DEFAULT,
  CK_DEFAULT_INITIAL_ELO: CK_DEFAULT_INITIAL_ELO,
  CK_RL_MAX_PER_MIN: CK_RL_MAX_PER_MIN,
  CKSettings: CKSettings,
  CKTierKey: CKTierKey,
  CKTierElo: CKTierElo,
  CKCacheGet: CKCacheGet,
  CKCacheSet: CKCacheSet,
  CKAcquireKey: CKAcquireKey,
  CKHasEnabledKeys: CKHasEnabledKeys,
  CKRateUsage: CKRateUsage,
  CKMarkKeyFailure: CKMarkKeyFailure,
  CKValGet: CKValGet,
  CKParseRiotId: CKParseRiotId,
  CKAccount: CKAccount,
  CKMMR: CKMMR,
  CKRecentCustomMatches: CKRecentCustomMatches,
  CKRankingOf: CKRankingOf,
  CKEnsureRanking: CKEnsureRanking,
  CKPuuidOf: CKPuuidOf,
  CKAffinityOf: CKAffinityOf,
  CKTeamA: CKTeamA,
  CKTeamB: CKTeamB,
  CKTeamOf: CKTeamOf,
  CKTeamUserIds: CKTeamUserIds,
  CKTeamEloSum: CKTeamEloSum,
  CKAllUserIds: CKAllUserIds,
  CKReports: CKReports,
  CKTeamAvgElo: CKTeamAvgElo,
  CKRunMatchmaking: CKRunMatchmaking,
  CKRunMatchmakingDrain: CKRunMatchmakingDrain,
  CKConfirmStart: CKConfirmStart,
  CKReportEnd: CKReportEnd,
  CKVerifyBattle: CKVerifyBattle,
  CKDoSettle: CKDoSettle,
  CKHandleQueueCancel: CKHandleQueueCancel,
  CKAutoVerifyAll: CKAutoVerifyAll,
};