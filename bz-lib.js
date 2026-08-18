// BATTLEZONE 킬내기 - 공용 헬퍼 모듈
// PocketBase v0.23+ 는 각 핸들러(route/hook)를 별도 격리 프로그램으로 실행하므로,
// 핸들러 밖에 선언된 함수는 핸들러에서 접근할 수 없다.
// 따라서 모든 헬퍼를 이 모듈로 옮기고 각 핸들러에서 require() 로 로드한다.
// (참고: https://pocketbase.io/docs/js-overview/#handlers-scope)

// ---------- 상수 ----------

const BZ_SHARD = "steam";
const BZ_API = "https://api.pubg.com";
const BZ_PID_TTL = 30 * 24 * 3600 * 1000; // 플레이어 ID: 30일
const BZ_LIST_TTL = 60000; // 매치 목록: 60초
const BZ_MATCH_TTL = 7 * 24 * 3600 * 1000; // 매치 상세: 7일
const BZ_ONGOING_TTL = 3 * 60 * 1000; // 진행 중 매치(404) 재조회 간격: 3분
// 배틀 시작(시작 확인) 시각과 실제 PUBG 매치 시작 시각은 순서가 뒤바뀔 수 있으므로
// (매치 참가 후 시작 확인 / 시작 확인 후 참가) 자동 스캔 시 배틀 시작 시각 대비 허용 오차로 사용한다.
const BZ_VERIFY_TOL_MS = 20 * 60 * 1000; // ±20분
const BZ_SCAN_MAX_BATTLES = 5; // 크론 틱당 스캔 대전 수
const BZ_SCAN_MAX_MATCHES = 4; // 플레이어당 틱당 신규 매치 처리 수

// 키 레이트 리미터 (슬라이딩 윈도우 60초/10회)
const BZ_RL_WINDOW_MS = 60000;
const BZ_RL_MAX_PER_MIN = 10;

// ---------- 기본 유틸 ----------

function BZBody(c) {
  try {
    const info = c.requestInfo();
    const b = info && info.body;
    if (b && typeof b === "object") return b;
  } catch (e) {
    /* 무시 */
  }
  try {
    const raw = String(c.request.body || "");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return parsed;
      } catch (e) {
        /* 무시 */
      }
    }
  } catch (e) {
    /* 무시 */
  }
  return {};
}

function BZAuth(c) {
  const rec = c.auth;
  return rec && rec.collection().name === "users" ? rec : null;
}

function BZNow() {
  return new Date().toISOString();
}

function BZFindById(collection, id) {
  try {
    return $app.findRecordById(collection, id);
  } catch (e) {
    return null;
  }
}

function BZFirst(collection, filter, params) {
  try {
    return $app.findFirstRecordByFilter(collection, filter, params || {});
  } catch (e) {
    return null;
  }
}

function BZSettings() {
  const rec = BZFirst("game_settings", "");
  if (rec) return rec;
  // 설정이 없으면 기본값으로 생성
  const nr = new Record($app.findCollectionByNameOrId("game_settings"));
  nr.set("target_kills", 5);
  nr.set("season", "시즌 1");
  nr.set("elo_k", 32);
  nr.set("initial_elo", 1200);
  nr.set("match_elo_range", 200);
  nr.set("matching_enabled", true);
  nr.set("game_start_timeout_min", 5);
  nr.set("rules", "");
  try {
    $app.save(nr);
    return nr;
  } catch (e) {
    return nr;
  }
}

function BZLog(kind, message) {
  try {
    const rec = new Record($app.findCollectionByNameOrId("admin_logs"));
    rec.set("kind", kind);
    rec.set("message", message);
    $app.save(rec);
  } catch (e) {
    /* 무시 */
  }
}

// ---------- 캐시 (pubg_cache 컬렉션) ----------

function BZCacheGet(key) {
  try {
    const rec = $app.findFirstRecordByFilter("pubg_cache", "key = {:k}", { k: key });
    if (!rec) return null;
    const exp = rec.getString("expires_at");
    if (exp && new Date(exp).getTime() < Date.now()) {
      return null;
    }
    const raw = rec.getString("payload");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function BZCacheSet(key, payload, ttlMs) {
  try {
    let rec = null;
    try {
      rec = $app.findFirstRecordByFilter("pubg_cache", "key = {:k}", { k: key });
    } catch (e) {
      rec = null;
    }
    if (!rec) {
      rec = new Record($app.findCollectionByNameOrId("pubg_cache"));
      rec.set("key", key);
    }
    rec.set("payload", JSON.stringify(payload));
    rec.set("expires_at", new Date(Date.now() + ttlMs).toISOString());
    $app.save(rec);
  } catch (e) {
    /* 캐시 실패는 치명적이지 않음 */
  }
}

// ---------- 키 레이트 리미터 ----------

/** 등록된 사용 가능 키 존재 여부 (키 미등록과 한도 소진을 구분하기 위함) */
function BZHasEnabledKeys() {
  try {
    const keys = $app.findRecordsByFilter("pubg_keys", "enabled = true", "label", 1, 0);
    return Boolean(keys && keys.length);
  } catch (e) {
    return false;
  }
}

/**
 * 여유가 있는 키 하나를 획득한다. 전부 소진이면 null.
 * 획득 시 호출 기록을 윈도우에 추가하고 last_used_at 을 갱신한다.
 */
function BZAcquireKey() {
  let keys = [];
  try {
    keys = $app.findRecordsByFilter("pubg_keys", "enabled = true", "label", 50, 0);
  } catch (e) {
    return null;
  }
  if (!keys || !keys.length) return null;

  const now = Date.now();
  let best = null;
  for (const k of keys) {
    const arr = BZWindowOf(k.id, now);
    if (arr.length < BZ_RL_MAX_PER_MIN && (!best || arr.length < best.used)) {
      best = { key: k, used: arr.length };
    }
  }
  if (!best) return null;

  const win = BZWindowOf(best.key.id, now);
  win.push(now);
  try {
    best.key.set("last_used_at", new Date(now).toISOString());
    $app.save(best.key);
  } catch (e) {
    /* 무시 */
  }
  return best.key;
}

function BZWindowOf(keyId, now) {
  const storeKey = "bz_rl_" + keyId;
  let arr = $app.store().get(storeKey);
  if (!Array.isArray(arr)) {
    arr = [];
    $app.store().set(storeKey, arr);
  }
  const fresh = arr.filter((t) => now - t < BZ_RL_WINDOW_MS);
  $app.store().set(storeKey, fresh);
  return fresh;
}

/** 키 실패 기록 (인증 오류 등). 3회 연속 실패 시 자동 비활성화. */
function BZMarkKeyFailure(key, reason) {
  try {
    const fc = key.getInt("fail_count") + 1;
    key.set("fail_count", fc);
    if (fc >= 3) {
      key.set("enabled", false);
      BZLog("keys", "키 자동 비활성화 (연속 실패 " + fc + "회): " + key.getString("label") + " (" + reason + ")");
    } else {
      BZLog("keys", "키 실패 " + fc + "회: " + key.getString("label") + " (" + reason + ")");
    }
    $app.save(key);
  } catch (e) {
    /* 무시 */
  }
}

/** 관리자 UI 용: 키별 현재 윈도우 사용량 조회 */
function BZRateUsage() {
  let keys = [];
  try {
    keys = $app.findRecordsByFilter("pubg_keys", "", "label", 50, 0);
  } catch (e) {
    return [];
  }
  const now = Date.now();
  return keys.map((k) => ({
    id: k.id,
    label: k.getString("label"),
    enabled: k.getBool("enabled"),
    used: BZWindowOf(k.id, now).length,
    limit: BZ_RL_MAX_PER_MIN,
  }));
}

// ---------- PUBG API ----------

/**
 * PUBG API GET 요청. 레이트 리미터를 거친다.
 * @returns {{rateLimited?: boolean, noKeys?: boolean, error?: string, notFound?: boolean, json?: object}}
 */
async function BZPubgGet(path) {
  const key = BZAcquireKey();
  if (!key) {
    return BZHasEnabledKeys() ? { rateLimited: true } : { noKeys: true };
  }
  try {
    const res = await $http.send({
      url: BZ_API + path,
      method: "GET",
      headers: {
        Authorization: "Bearer " + key.getString("key"),
        Accept: "application/vnd.api+json",
      },
      timeout: 15000,
    });
    if (res.statusCode === 404) return { notFound: true };
    if (res.statusCode !== 200) {
      if (res.statusCode === 429) return { rateLimited: true };
      if (res.statusCode === 401 || res.statusCode === 403) {
        BZMarkKeyFailure(key, "PUBG API 인증 오류 " + res.statusCode);
        return { error: "PUBG API 인증 오류 " + res.statusCode + " (키가 유효하지 않을 수 있습니다)" };
      }
      return { error: "PUBG API 오류 " + res.statusCode };
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

/** Steam 닉네임 → 플레이어 ID (캐시: 30일) */
async function BZResolvePlayerId(nickname) {
  const name = String(nickname || "").trim();
  if (!name) return { error: "닉네임이 없습니다." };
  const cacheKey = "pid:" + name.toLowerCase();
  const cached = BZCacheGet(cacheKey);
  if (cached) return { playerId: cached };

  const res = await BZPubgGet(
    "/shards/" + BZ_SHARD + "/players?filter%5BplayerNames%5D=" + encodeURIComponent(name)
  );
  if (res.noKeys) return { noKeys: true };
  if (res.rateLimited) return { rateLimited: true };
  if (res.notFound) return { notFound: true };
  if (res.error) return { error: res.error };
  const data = res.json && res.json.data;
  if (!data || !data.length) return { notFound: true };
  BZCacheSet(cacheKey, data[0].id, BZ_PID_TTL);
  return { playerId: data[0].id };
}

/**
 * 플레이어 최근 매치 ID 목록 (캐시: 60초).
 * PUBG API는 /players/{id} 응답의 relationships.matches.data 에 최근 매치 ID를 포함한다.
 * (/players/{id}/matches 엔드포인트는 존재하지 않음)
 */
async function BZRecentMatches(playerId) {
  const cacheKey = "matches:" + playerId;
  const cached = BZCacheGet(cacheKey);
  if (cached && Array.isArray(cached)) return { ids: cached };

  const res = await BZPubgGet("/shards/" + BZ_SHARD + "/players/" + playerId);
  if (res.noKeys) return { noKeys: true };
  if (res.rateLimited) return { rateLimited: true };
  if (res.notFound) {
    BZLog("scan", "플레이어 조회 404 (player=" + playerId + ")");
    return { ids: [] };
  }
  if (res.error) return { error: res.error };
  const data = res.json && res.json.data;
  const player = Array.isArray(data) ? data[0] : data;
  const list = (player && player.relationships && player.relationships.matches &&
    player.relationships.matches.data) || [];
  const ids = list.map((m) => m.id).filter(Boolean);
  if (!ids.length) {
    BZLog("scan", "매치 0개 (player=" + playerId + ") 응답: " + JSON.stringify(res.json || {}).substring(0, 300));
  }
  BZCacheSet(cacheKey, ids, BZ_LIST_TTL);
  return { ids };
}

/**
 * 매치 상세 (캐시: 7일).
 * 공식 스키마 기준: participant는 attributes.stats.playerId(계정 ID) / attributes.stats.name(IGN)으로 매칭.
 * relationships.player.data.id는 실제 응답에 따라 있을 수도 있어 보조로 사용.
 * @returns {{ongoing?: boolean, error?: string, createdAt?: string, mapName?: string, killsByPlayer?: object, placementByPlayer?: object, killsByNickname?: object, placementByNickname?: object, participantCount?: number}}
 */
async function BZMatchDetail(matchId) {
  // v2: 구버전 캐시(맵/등수 없음) 무효화를 위해 키 버전 변경
  const cacheKey = "match:v2:" + matchId;
  const cached = BZCacheGet(cacheKey);
  if (cached) return cached;

  const res = await BZPubgGet("/shards/" + BZ_SHARD + "/matches/" + matchId);
  if (res.noKeys) return { noKeys: true };
  if (res.rateLimited) return { rateLimited: true };
  if (res.notFound) {
    // 진행 중인 매치: 아직 데이터가 없음. 짧은 TTL로 캐시해 틱마다 재호출 방지
    BZCacheSet(cacheKey, { ongoing: true }, BZ_ONGOING_TTL);
    return { ongoing: true };
  }
  if (res.error) return { error: res.error };

  const d = res.json && res.json.data;
  const included = (res.json && res.json.included) || [];
  const createdAt = d && d.attributes && d.attributes.createdAt;
  const mapName = d && d.attributes && d.attributes.mapName;
  const killsByPlayer = {};
  const placementByPlayer = {};
  const killsByNickname = {};
  const placementByNickname = {};
  let participantCount = 0;
  for (const inc of included) {
    if (inc.type !== "participant" || !inc.attributes || !inc.attributes.stats) continue;
    participantCount++;
    const stats = inc.attributes.stats;
    const pid = (inc.relationships && inc.relationships.player && inc.relationships.player.data &&
      inc.relationships.player.data.id) || stats.playerId;
    const kills = Number(stats.kills || 0);
    const placement = Number(stats.winPlace || 0);
    if (pid) {
      killsByPlayer[pid] = kills;
      placementByPlayer[pid] = placement;
    }
    if (stats.name) {
      killsByNickname[String(stats.name).toLowerCase()] = kills;
      placementByNickname[String(stats.name).toLowerCase()] = placement;
    }
  }
  const detail = { createdAt, mapName, killsByPlayer, placementByPlayer, killsByNickname, placementByNickname, participantCount };
  BZCacheSet(cacheKey, detail, BZ_MATCH_TTL);
  return detail;
}

/**
 * 매치 상세에서 해당 플레이어의 킬수/등수 추출. 계정 ID → 닉네임 순으로 매칭.
 * @returns {{kills: number, placement: number, matched: boolean}}
 */
function BZPlayerMatchStats(detail, playerId, nickname) {
  const key = String(playerId || "");
  const nk = String(nickname || "").toLowerCase();
  const kp = detail.killsByPlayer || {};
  const pp = detail.placementByPlayer || {};
  const kn = detail.killsByNickname || {};
  const pn = detail.placementByNickname || {};
  if (key in kp || key in pp) {
    return { kills: Number(kp[key] || 0), placement: Number(pp[key] || 0), matched: true };
  }
  if (nk in kn || nk in pn) {
    return { kills: Number(kn[nk] || 0), placement: Number(pn[nk] || 0), matched: true };
  }
  return { kills: 0, placement: 0, matched: false };
}

// ---------- 대전 상태 처리 ----------

function BZSideOf(battle, playerId) {
  if (battle.getString("player_a") === playerId) return "a";
  if (battle.getString("player_b") === playerId) return "b";
  return null;
}

function BZOpponentOf(battle, playerId) {
  const side = BZSideOf(battle, playerId);
  if (!side) return null;
  return side === "a" ? battle.getString("player_b") : battle.getString("player_a");
}

/** 랭킹 레코드 조회(없으면 생성) */
function BZEnsureRanking(userId, nickname, initialElo) {
  let rec = BZFirst("rankings", "user = {:u}", { u: userId });
  if (rec) return rec;
  rec = new Record($app.findCollectionByNameOrId("rankings"));
  rec.set("user", userId);
  rec.set("nickname", nickname);
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

function BZNicknameOf(userId) {
  const u = BZFindById("users", userId);
  if (!u) return userId;
  return u.getString("username") || u.getString("name") || u.getString("email") || userId;
}

/** Elo 계산 (표준 Elo, K 계수) */
function BZElo(ra, rb, score, k) {
  const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  const next = Math.round(ra + k * (score - ea));
  return { newElo: next, delta: next - ra };
}

function BZStreakOf(prev, won) {
  const parsed = Number(prev || "");
  const base = Number.isFinite(parsed) ? Math.abs(parsed) : 0;
  return "" + (base + 1) + (won ? "W" : "L");
}

/**
 * 대전 정산: 승패에 따라 Elo 계산 → 랭킹/전적(matches) 갱신.
 * finished / forfeit 상태에서만 동작하며, 이미 정산(finished_at)된 경우 무시한다.
 */
function BZDoSettle(battle) {
  const status = battle.getString("status");
  if (status !== "finished" && status !== "forfeit") return { ok: false, message: "정산 가능한 상태가 아닙니다." };
  if (battle.getString("finished_at")) return { ok: true, already: true };

  const settings = BZSettings();
  const k = Number(settings.getInt("elo_k") || 32);
  const initialElo = Number(settings.getInt("initial_elo") || 1200);

  const pa = battle.getString("player_a");
  const pb = battle.getString("player_b");
  const winner = battle.getString("winner");
  const ra = BZEnsureRanking(pa, BZNicknameOf(pa), initialElo);
  const rb = BZEnsureRanking(pb, BZNicknameOf(pb), initialElo);
  const eloA = Number(ra.getInt("elo") || initialElo);
  const eloB = Number(rb.getInt("elo") || initialElo);

  let scoreA = 0.5;
  if (winner === pa) scoreA = 1;
  else if (winner === pb) scoreA = 0;

  const resA = BZElo(eloA, eloB, scoreA, k);
  const resB = BZElo(eloB, eloA, 1 - scoreA, k);

  const wonA = scoreA === 1;
  const wonB = scoreA === 0;
  const draw = scoreA === 0.5;

  ra.set("elo", resA.newElo);
  ra.set("wins", ra.getInt("wins") + (wonA ? 1 : 0));
  ra.set("losses", ra.getInt("losses") + (wonB ? 1 : 0));
  ra.set("draws", ra.getInt("draws") + (draw ? 1 : 0));
  if (!draw) ra.set("streak", BZStreakOf(ra.getString("streak"), wonA));

  rb.set("elo", resB.newElo);
  rb.set("wins", rb.getInt("wins") + (wonB ? 1 : 0));
  rb.set("losses", rb.getInt("losses") + (wonA ? 1 : 0));
  rb.set("draws", rb.getInt("draws") + (draw ? 1 : 0));
  if (!draw) rb.set("streak", BZStreakOf(rb.getString("streak"), wonB));

  try {
    $app.save(ra);
    $app.save(rb);
  } catch (e) {
    return { ok: false, message: "랭킹 저장 실패" };
  }

  // 전적(matches) 기록
  const finishedAt = battle.getString("finished_at") || BZNow();
  const killsA = battle.getInt("kills_a");
  const killsB = battle.getInt("kills_b");
  try {
    const mk = (playerId, result, kills, oppKills) => {
      const m = new Record($app.findCollectionByNameOrId("matches"));
      m.set("player", BZNicknameOf(playerId));
      m.set("date", finishedAt);
      m.set("map", "킬내기");
      m.set("mode", "1v1");
      m.set("result", result);
      m.set("score_us", kills);
      m.set("score_them", oppKills);
      m.set("kills", kills);
      m.set("rating", 0);
      $app.save(m);
    };
    if (draw) {
      mk(pa, "D", killsA, killsB);
      mk(pb, "D", killsB, killsA);
    } else {
      mk(winner, "W", winner === pa ? killsA : killsB, winner === pa ? killsB : killsA);
      mk(winner === pa ? pb : pa, "L", winner === pa ? killsB : killsA, winner === pa ? killsA : killsB);
    }
  } catch (e) {
    /* 전적 기록 실패는 치명적이지 않음 */
  }

  battle.set("elo_delta_a", resA.delta);
  battle.set("elo_delta_b", resB.delta);
  battle.set("finished_at", finishedAt);
  // forfeit 상태는 유지 (UI/전적 구분용)
  try {
    $app.save(battle);
  } catch (e) {
    return { ok: false, message: "대전 저장 실패" };
  }
  BZLog("settle", "대전 정산: " + pa + " vs " + pb + " (winner=" + winner + ", Δ" + resA.delta + "/" + resB.delta + ")");
  return { ok: true, winner, eloDeltaA: resA.delta, eloDeltaB: resB.delta };
}

// ---------- 자동 게임 기록 스캔 ----------

/**
 * 플레이어 1명의 최근 PUBG 매치를 스캔해 kill_rounds 에 기록을 추가한다.
 * - 진행 중 매치(404)  → pending_verify 기록 추가 (다음 틱에서 재확인)
 * - 종료된 매치       → verified 기록 추가 (kills_api = 실제 킬수)
 * - 이미 기록된 매치   → 건너뜀 (중복 방지)
 * - 배틀 시작 이전 매치 → 스캔 중단 (매치 목록은 최신순)
 * @returns {{rateLimited?: boolean, noKeys?: boolean, skipped?: string, added?: number, confirmed?: number}}
 */
async function BZScanPlayer(battle, playerId) {
  const user = BZFindById("users", playerId);
  if (!user) return { rateLimited: false, skipped: "사용자를 찾을 수 없음" };
  const nickname = user.getString("pubg_nickname");
  if (!nickname) return { rateLimited: false, skipped: "Steam 닉네임 미등록" };

  const pid = await BZResolvePlayerId(nickname);
  if (pid.noKeys) return { noKeys: true };
  if (pid.rateLimited) return { rateLimited: true };
  if (pid.notFound) return { rateLimited: false, skipped: "닉네임 '" + nickname + "'(을)를 PUBG에서 찾을 수 없음" };
  if (pid.error) return { rateLimited: false, skipped: "닉네임 조회 실패: " + pid.error };

  // 배틀 시작 시각 기준 (시작 확인 완료 시점)
  const base = battle.getString("playing_at") || battle.getString("created");
  const baseMs = base ? new Date(base).getTime() : 0;
  const minMs = baseMs ? baseMs - BZ_VERIFY_TOL_MS : 0;

  const list = await BZRecentMatches(pid.playerId);
  if (list.noKeys) return { noKeys: true };
  if (list.rateLimited) return { rateLimited: true };
  if (list.error) return { rateLimited: false, skipped: "매치 목록 조회 실패: " + list.error };

  let existing = [];
  try {
    existing = $app.findRecordsByFilter(
      "kill_rounds",
      "battle = {:b} && player = {:p}",
      "round_number",
      200,
      0,
      { b: battle.id, p: playerId }
    );
  } catch (e) {
    existing = [];
  }

  // 구식(수동) 기록 정리: match_id 없는 playing/pending_verify → void
  for (const r of existing) {
    const s = r.getString("status");
    if ((s === "playing" || s === "pending_verify") && !r.getString("match_id")) {
      r.set("status", "void");
      r.set("note", "자동 기록 전환으로 무효 처리");
      try {
        $app.save(r);
      } catch (e) {
        /* 무시 */
      }
    }
  }

  let nextNumber = 0;
  for (const r of existing) {
    nextNumber = Math.max(nextNumber, r.getInt("round_number") || 0);
  }

  const recorded = new Set();
  for (const r of existing) {
    const mid = r.getString("match_id");
    if (mid) recorded.add(mid);
  }

  // 최신 매치부터 스캔
  let added = 0;
  let scanned = 0;
  let matchesFound = list.ids.length;
  let detailErrors = 0;
  let noCreatedAt = 0;
  let oldMatches = 0;
  for (const matchId of list.ids) {
    if (scanned >= BZ_SCAN_MAX_MATCHES) break;
    if (recorded.has(matchId)) continue;
    scanned++;

    const detail = await BZMatchDetail(matchId);
    if (detail.noKeys) return { noKeys: true };
    if (detail.rateLimited) return { rateLimited: true };
    if (detail.error) {
      detailErrors++;
      continue;
    }
    if (detail.ongoing) {
      // 진행 중 매치 → 기록 추가 후 다음 틱에서 재확인
      nextNumber++;
      const nr = new Record($app.findCollectionByNameOrId("kill_rounds"));
      nr.set("battle", battle.id);
      nr.set("player", playerId);
      nr.set("round_number", nextNumber);
      nr.set("status", "pending_verify");
      nr.set("match_id", matchId);
      nr.set("game_started_at", detail.createdAt || "");
      nr.set("map", detail.mapName || "");
      nr.set("verified_at", BZNow());
      nr.set("note", "자동 기록 (게임 진행 중)");
      try {
        $app.save(nr);
        added++;
      } catch (e) {
        BZLog("scan", "진행 중 매치 기록 실패: " + nickname + " (match=" + matchId + ") " + String((e && e.message) || e));
      }
      recorded.add(matchId);
      continue;
    }

    // 종료된 매치: 배틀 시작 이전(오차 허용) 매치면 이후 목록도 전부 이전 → 중단
    const createdMs = detail.createdAt ? new Date(detail.createdAt).getTime() : 0;
    if (minMs && createdMs && createdMs < minMs) {
      if (oldMatches === 0) {
        BZLog("scan", "대전 시작 이전 매치 무시: " + nickname + " (match=" + matchId + ", started=" + detail.createdAt + ") battle=" + battle.id);
      }
      oldMatches++;
      break;
    }
    if (!createdMs) {
      noCreatedAt++;
      continue;
    }

    const stats = BZPlayerMatchStats(detail, pid.playerId, nickname);
    if (!stats.matched && detail.participantCount > 0) {
      BZLog("scan", "참가자 매칭 실패: " + nickname + " (match=" + matchId + ", 참가자 " + detail.participantCount + "명) battle=" + battle.id);
    }
    const kills = stats.kills;
    const placement = stats.placement;
    nextNumber++;
    const nr = new Record($app.findCollectionByNameOrId("kill_rounds"));
    nr.set("battle", battle.id);
    nr.set("player", playerId);
    nr.set("round_number", nextNumber);
    nr.set("status", "verified");
    nr.set("match_id", matchId);
    nr.set("game_started_at", detail.createdAt);
    nr.set("map", detail.mapName || "");
    nr.set("placement", placement);
    nr.set("kills_api", kills);
    nr.set("kills_final", kills);
    nr.set("verified_at", BZNow());
    nr.set("note", "자동 기록");
    try {
      $app.save(nr);
      added++;
      BZLog("verify", "자동 기록 추가: " + nickname + " " + kills + "킬 (match=" + matchId + ") battle=" + battle.id);
    } catch (e) {
      BZLog("scan", "자동 기록 저장 실패: " + nickname + " (match=" + matchId + ") " + String((e && e.message) || e));
    }
    recorded.add(matchId);
  }

  // pending_verify 기록 재확인 (매치 종료 감지)
  let confirmed = 0;
  for (const r of existing) {
    if (r.getString("status") !== "pending_verify") continue;
    const mid = r.getString("match_id");
    if (!mid) continue;
    const detail = await BZMatchDetail(mid);
    if (detail.noKeys) return { noKeys: true };
    if (detail.rateLimited) return { rateLimited: true };
    if (detail.error || detail.ongoing) continue;

    const createdMs = detail.createdAt ? new Date(detail.createdAt).getTime() : 0;
    if (minMs && createdMs && createdMs < minMs) {
      // 배틀 시작 이전에 시작된 매치 → 무효
      r.set("status", "void");
      r.set("note", "배틀 시작 이전 매치");
      try {
        $app.save(r);
      } catch (e) {
        /* 무시 */
      }
      continue;
    }

    const stats = BZPlayerMatchStats(detail, pid.playerId, nickname);
    if (!stats.matched && detail.participantCount > 0) {
      BZLog("scan", "참가자 매칭 실패: " + nickname + " (match=" + matchId + ", 참가자 " + detail.participantCount + "명) battle=" + battle.id);
    }
    r.set("status", "verified");
    r.set("kills_api", stats.kills);
    r.set("kills_final", stats.kills);
    r.set("game_started_at", detail.createdAt || r.getString("game_started_at") || "");
    r.set("map", detail.mapName || r.getString("map") || "");
    r.set("placement", stats.placement || r.getInt("placement") || 0);
    r.set("verified_at", BZNow());
    try {
      $app.save(r);
      confirmed++;
      BZLog("verify", "매치 종료 감지 → 검증 확정: " + nickname + " " + kills + "킬 (match=" + mid + ") battle=" + battle.id);
    } catch (e) {
      BZLog("scan", "검증 확정 저장 실패: " + nickname + " (match=" + mid + ") " + String((e && e.message) || e));
    }
  }

  return {
    rateLimited: false,
    added,
    confirmed,
    matchesFound,
    detailErrors,
    noCreatedAt,
    oldMatches,
  };
}

/** verified 기록 킬수 합산으로 배틀 킬수 재계산 (멱등) */
function BZRecomputeKills(battle) {
  let ka = 0;
  let kb = 0;
  let rounds = [];
  try {
    rounds = $app.findRecordsByFilter("kill_rounds", "battle = {:b}", "round_number", 500, 0, { b: battle.id });
  } catch (e) {
    rounds = [];
  }
  for (const r of rounds) {
    if (r.getString("status") !== "verified") continue;
    const p = r.getString("player");
    const k = r.getInt("kills_final") || r.getInt("kills_api") || 0;
    if (p === battle.getString("player_a")) ka += k;
    else if (p === battle.getString("player_b")) kb += k;
  }
  battle.set("kills_a", ka);
  battle.set("kills_b", kb);
  battle.set("pending_kills_a", 0);
  battle.set("pending_kills_b", 0);
}

/** 목표 킬수 달성 시 승리 확정 + 정산 */
function BZCheckWin(battle) {
  if (battle.getString("winner")) return;
  const target = battle.getInt("target_kills") || 5;
  const ka = battle.getInt("kills_a");
  const kb = battle.getInt("kills_b");
  if (ka < target && kb < target) return;

  let winner = null;
  if (ka >= target && kb >= target) {
    // 동시 도달(이론상): 킬수가 많은 쪽, 같으면 A
    winner = ka >= kb ? battle.getString("player_a") : battle.getString("player_b");
  } else {
    winner = ka >= target ? battle.getString("player_a") : battle.getString("player_b");
  }
  battle.set("winner", winner);
  battle.set("winner_pending", "");
  battle.set("status", "finished");
  try {
    $app.save(battle);
  } catch (e) {
    return;
  }
  const settled = BZDoSettle(battle);
  BZLog("verify", "목표 달성 승리: " + winner + " (" + ka + " vs " + kb + ") battle=" + battle.id +
    (settled.ok ? "" : " 정산 보류"));
}

/** 대전 1건 스캔 (양쪽) */
async function BZScanBattle(battle) {
  // 레거시 settling 대전: 승자가 확정된 상태면 즉시 종료
  if (battle.getString("status") === "settling" && battle.getString("winner")) {
    battle.set("status", "finished");
    try {
      $app.save(battle);
    } catch (e) {
      /* 무시 */
    }
    BZDoSettle(battle);
    return { rateLimited: false, players: [] };
  }
  if (battle.getString("status") !== "playing") return { rateLimited: false, players: [] };

  const ra = await BZScanPlayer(battle, battle.getString("player_a"));
  if (ra.noKeys) return { noKeys: true };
  if (ra.rateLimited) return { rateLimited: true };
  const rb = await BZScanPlayer(battle, battle.getString("player_b"));
  if (rb.noKeys) return { noKeys: true };
  if (rb.rateLimited) return { rateLimited: true };

  const players = [
    { side: "A", playerId: battle.getString("player_a"), ...ra },
    { side: "B", playerId: battle.getString("player_b"), ...rb },
  ];
  for (const p of players) {
    if (p.skipped) {
      BZLog("scan", "스캔 건너뜀 " + p.side + ": " + p.skipped + " (battle=" + battle.id + ")");
    } else {
      BZLog("scan", "스캔 완료 " + p.side + ": 추가 " + (p.added || 0) + "건 / 확정 " + (p.confirmed || 0) + "건, 매치 " + (p.matchesFound || 0) + "개 중 이전 " + (p.oldMatches || 0) + "개, 상세 오류 " + (p.detailErrors || 0) + "건 (battle=" + battle.id + ")");
    }
  }

  BZRecomputeKills(battle);
  try {
    $app.save(battle);
  } catch (e) {
    /* 무시 */
  }
  BZCheckWin(battle);
  return { rateLimited: false, players };
}

/**
 * 주기 정리 (크론 틱에서 호출, 스토어 스로틀로 30분 간격 실행).
 * - pubg_cache : 만료/30일 초과 행 삭제 + 키 중복 행 정리 (UNIQUE 인덱스 대비)
 * - admin_logs : 최근 3000건 초과 시 오래된 행 삭제
 * - kill_queue : cancelled/matched 7일 초과 행 삭제
 */
function BZMaintenance() {
  try {
    const now = Date.now();
    const last = Number($app.store().get("bz_maint_last") || 0);
    if (now - last < 30 * 60 * 1000) return;
    $app.store().set("bz_maint_last", now);
  } catch (e) {
    return;
  }

  try {
    // 1) pubg_cache 정리
    const cacheRows = $app.findRecordsByFilter(
      "pubg_cache",
      "expires_at < {:t} || created < {:c}",
      "created",
      2000,
      0,
      { t: BZNow(), c: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() }
    );
    for (const r of cacheRows) {
      try {
        $app.delete(r);
      } catch (e) {
        /* 무시 */
      }
    }
    // 키 중복 행 정리 (첫 행 유지)
    const seen = {};
    const allCache = $app.findRecordsByFilter("pubg_cache", "", "created", 5000, 0);
    for (const r of allCache) {
      const k = r.getString("key");
      if (!k) continue;
      if (seen[k]) {
        try {
          $app.delete(r);
        } catch (e) {
          /* 무시 */
        }
      } else {
        seen[k] = true;
      }
    }
  } catch (e) {
    /* 무시 */
  }

  try {
    // 2) admin_logs: 최근 3000건 유지
    const maxLogs = 3000;
    const total = $app.countRecords("admin_logs");
    if (total > maxLogs) {
      const excess = Math.min(total - maxLogs, 1000);
      const old = $app.findRecordsByFilter("admin_logs", "", "created", excess, 0);
      for (const r of old) {
        try {
          $app.delete(r);
        } catch (e) {
          /* 무시 */
        }
      }
    }
  } catch (e) {
    /* 무시 */
  }

  try {
    // 3) kill_queue: cancelled/matched 7일 초과 삭제
    const oldQueues = $app.findRecordsByFilter(
      "kill_queue",
      "(status = 'cancelled' || status = 'matched') && created < {:c}",
      "created",
      2000,
      0,
      { c: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString() }
    );
    for (const r of oldQueues) {
      try {
        $app.delete(r);
      } catch (e) {
        /* 무시 */
      }
    }
  } catch (e) {
    /* 무시 */
  }
}

/** 활성 대전 전체 자동 스캔 (크론용) */
async function BZAutoScanAll() {
  if ($app.store().get("bz_scan_busy")) return { ok: false, busy: true };
  $app.store().set("bz_scan_busy", true);
  try {
    let battles = [];
    try {
      battles = $app.findRecordsByFilter(
        "kill_battles",
        "status = 'playing' || status = 'settling'",
        "created",
        BZ_SCAN_MAX_BATTLES,
        0
      );
    } catch (e) {
      return { ok: false };
    }
    let scanned = 0;
    for (const battle of battles) {
      const res = await BZScanBattle(battle);
      if (res.noKeys) {
        BZLog("scan", "자동 스캔 중단: 등록된 PUBG API 키가 없습니다. 관리자 설정에서 등록해 주세요.");
        break;
      }
      if (res.rateLimited) break;
      scanned++;
    }
    return { ok: true, scanned };
  } finally {
    $app.store().set("bz_scan_busy", false);
  }
}

// ---------- 매치메이킹 ----------

/**
 * 대기열에서 Elo 차이 최소 쌍을 찾아 대전을 생성한다. (동기 실행 — 원자적)
 * @returns {number} 성사된 대전 수
 */
function BZRunMatchmaking() {
  if ($app.store().get("bz_mm_busy")) return 0;
  $app.store().set("bz_mm_busy", true);
  try {
    const settings = BZSettings();
    if (!settings || settings.getBool("matching_enabled") === false) return 0;
    const season = settings.getString("season") || "시즌 1";
    const range = Number(settings.getInt("match_elo_range") || 200);

    let waiting = [];
    try {
      waiting = $app.findRecordsByFilter(
        "kill_queue",
        "status = 'waiting' && season = {:s}",
        "created",
        50,
        0,
        { s: season }
      );
    } catch (e) {
      return 0;
    }
    if (waiting.length < 2) return 0;

    let best = null;
    for (let i = 0; i < waiting.length; i++) {
      for (let j = i + 1; j < waiting.length; j++) {
        const diff = Math.abs(
          Number(waiting[i].getInt("elo") || 0) - Number(waiting[j].getInt("elo") || 0)
        );
        if (diff <= range && (!best || diff < best.diff)) {
          best = { diff, a: waiting[i], b: waiting[j] };
        }
      }
    }
    if (!best) return 0;

    const battle = new Record($app.findCollectionByNameOrId("kill_battles"));
    battle.set("season", season);
    battle.set("target_kills", settings.getInt("target_kills") || 5);
    battle.set("player_a", best.a.getString("user"));
    battle.set("player_b", best.b.getString("user"));
    battle.set("kills_a", 0);
    battle.set("kills_b", 0);
    battle.set("pending_kills_a", 0);
    battle.set("pending_kills_b", 0);
    // 매칭 즉시 시작 (시작 확인 절차 없음) — playing_at 기준으로 몰수 승 타임아웃이 흐른다
    battle.set("status", "playing");
    battle.set("playing_at", BZNow());
    battle.set("started_a", true);
    battle.set("started_b", true);
    battle.set("game_started_a", false);
    battle.set("game_started_b", false);
    battle.set("current_round_a", 0);
    battle.set("current_round_b", 0);
    $app.save(battle);

    best.a.set("status", "matched");
    best.a.set("battle_id", battle.id);
    $app.save(best.a);
    best.b.set("status", "matched");
    best.b.set("battle_id", battle.id);
    $app.save(best.b);

    BZLog("match", "매칭 성공: " + best.a.getString("user") + " vs " + best.b.getString("user") +
      " (Elo " + best.a.getInt("elo") + " / " + best.b.getInt("elo") + ")");
    return 1;
  } catch (e) {
    BZLog("match", "매칭 실패: " + String((e && e.message) || e));
    return 0;
  } finally {
    $app.store().set("bz_mm_busy", false);
  }
}

/** 대기열 취소 시 대기(pending) 대전 취소 + 상대 큐 복구 */
function BZHandleQueueCancel(battleId, userId) {
  const battle = BZFindById("kill_battles", battleId);
  if (!battle) return;
  if (battle.getString("status") !== "pending") return;
  try {
    battle.set("status", "cancelled");
    $app.save(battle);
    const opp = BZOpponentOf(battle, userId);
    if (opp) {
      const oppQueue = BZFirst("kill_queue", "battle_id = {:b} && user = {:u} && status = 'matched'", {
        b: battleId,
        u: opp,
      });
      if (oppQueue) {
        oppQueue.set("status", "waiting");
        oppQueue.set("battle_id", "");
        $app.save(oppQueue);
      }
    }
    BZLog("match", "대전 취소(대기열 이탈): " + battleId);
  } catch (e) {
    /* 무시 */
  }
}

// ---------- 모듈 내보내기 ----------

module.exports = {
  BZ_SHARD: BZ_SHARD,
  BZ_API: BZ_API,
  BZ_PID_TTL: BZ_PID_TTL,
  BZ_LIST_TTL: BZ_LIST_TTL,
  BZ_MATCH_TTL: BZ_MATCH_TTL,
  BZ_VERIFY_TOL_MS: BZ_VERIFY_TOL_MS,
  BZ_RL_WINDOW_MS: BZ_RL_WINDOW_MS,
  BZ_RL_MAX_PER_MIN: BZ_RL_MAX_PER_MIN,
  BZBody: BZBody,
  BZAuth: BZAuth,
  BZNow: BZNow,
  BZFindById: BZFindById,
  BZFirst: BZFirst,
  BZSettings: BZSettings,
  BZLog: BZLog,
  BZCacheGet: BZCacheGet,
  BZCacheSet: BZCacheSet,
  BZAcquireKey: BZAcquireKey,
  BZHasEnabledKeys: BZHasEnabledKeys,
  BZWindowOf: BZWindowOf,
  BZRateUsage: BZRateUsage,
  BZMarkKeyFailure: BZMarkKeyFailure,
  BZPubgGet: BZPubgGet,
  BZResolvePlayerId: BZResolvePlayerId,
  BZRecentMatches: BZRecentMatches,
  BZMatchDetail: BZMatchDetail,
  BZSideOf: BZSideOf,
  BZOpponentOf: BZOpponentOf,
  BZEnsureRanking: BZEnsureRanking,
  BZNicknameOf: BZNicknameOf,
  BZElo: BZElo,
  BZStreakOf: BZStreakOf,
  BZDoSettle: BZDoSettle,
  BZScanPlayer: BZScanPlayer,
  BZRecomputeKills: BZRecomputeKills,
  BZCheckWin: BZCheckWin,
  BZScanBattle: BZScanBattle,
  BZAutoScanAll: BZAutoScanAll,
  BZMaintenance: BZMaintenance,
  BZRunMatchmaking: BZRunMatchmaking,
  BZHandleQueueCancel: BZHandleQueueCancel,
};