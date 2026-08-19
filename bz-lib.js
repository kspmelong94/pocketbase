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
const BZ_SCAN_MAX_BATTLES = 500; // 크론 틱당 스캔 대전 수 절대 상한
const BZ_SCAN_CONCURRENCY = 6; // 동시 병렬 스캔 대전 수
const BZ_SCAN_TICK_MS = 90000; // 스캔 틱 최대 실행 시간 (초과 시 새 대전을 꺼내지 않음)
const BZ_SCAN_MAX_MATCHES = 4; // 플레이어당 틱당 신규 매치 처리 수

// 키 레이트 리미터 (슬라이딩 윈도우 60초/10회)
const BZ_RL_WINDOW_MS = 60000;
const BZ_RL_MAX_PER_MIN = 10;

// 키/대기열 관리 최대 개수
const BZ_KEYS_MAX = 200;
const BZ_MM_MAX_PAIRS_PER_TICK = 10; // 크론 틱당 최대 매칭 쌍 수

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
    const rec = new Record($app.findCollectionByNameOrId("bz_admin_logs"));
    rec.set("kind", kind);
    rec.set("message", message);
    $app.save(rec);
  } catch (e) {
    /* 무시 */
  }
}

// ---------- 라운드 헬퍼 (bz_battle_rounds 컬렉션, 레코드 단위) ----------
//
// 라운드는 bz_battle_rounds 에 레코드 1건씩 저장한다.
// 과거에는 bz_battles.rounds(JSON 배열)에 양쪽 라운드를 함께 넣어 저장할 때마다 배열 전체를
// 덮어썼기 때문에, 나/상대가 동시에 수동 기록을 추가하면 마지막 저장이 이전 기록을 지우는
// lost-update 가 발생했다. 레코드 단위(INSERT/UPDATE 1건)는 서로 독립적이어서 이 문제가 원천 차단된다.

const BZ_ROUND_FIELDS = [
  "player",
  "round_number",
  "status",
  "kills_manual",
  "kills_api",
  "kills_final",
  "map",
  "placement",
  "match_id",
  "game_started_at",
  "verified_at",
  "note",
];

/** 라운드 레코드를 평면 객체로 변환 */
function BZRoundExport(rec) {
  const plain = { id: rec.id, created: rec.getString("created") };
  for (const f of BZ_ROUND_FIELDS) plain[f] = rec.get(f);
  return plain;
}

/** 라운드 고유 ID 생성 (컬렉션 id와 구분되는 임시 식별자) */
function BZRoundId() {
  return "r_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

/** 배틀의 라운드 목록 (created 오름차순). 원본 참조가 아닌 복사본을 반환한다. */
function BZBattleRounds(battle) {
  try {
    return $app
      .findRecordsByFilter("bz_battle_rounds", "battle = {:b}", "-created", 0, 0, { b: battle.id })
      .map((r) => BZRoundExport(r))
      .sort((a, b) => String(a.created || "").localeCompare(String(b.created || "")));
  } catch (e) {
    return [];
  }
}

/** 라운드 INSERT (레코드 단위 — 동시 추가 안전). @returns {object|null} 추가된 라운드 */
function BZRoundAdd(battle, data) {
  const round = { id: BZRoundId(), created: BZNow(), ...data };
  try {
    const rec = new Record($app.findCollectionByNameOrId("bz_battle_rounds"));
    rec.set("battle", battle.id);
    for (const f of BZ_ROUND_FIELDS) {
      if (round[f] !== undefined && round[f] !== null) rec.set(f, round[f]);
    }
    rec.set("created", round.created);
    $app.save(rec);
    round.id = rec.id;
    return round;
  } catch (e) {
    return null;
  }
}

/** 라운드 UPDATE (레코드 단위). @returns {object|null} 수정된 라운드 */
function BZRoundUpdate(battle, roundId, patch) {
  try {
    const rec = $app.findRecordById("bz_battle_rounds", roundId);
    if (!rec || rec.getString("battle") !== battle.id) return null;
    for (const f of BZ_ROUND_FIELDS) {
      if (patch[f] !== undefined) rec.set(f, patch[f]);
    }
    $app.save(rec);
    return BZRoundExport(rec);
  } catch (e) {
    return null;
  }
}

/** 라운드 DELETE (레코드 단위). @returns {boolean} 삭제 여부 */
function BZRoundRemove(battle, roundId) {
  try {
    const rec = $app.findRecordById("bz_battle_rounds", roundId);
    if (!rec || rec.getString("battle") !== battle.id) return false;
    $app.delete(rec);
    return true;
  } catch (e) {
    return false;
  }
}

/** 플레이어 라운드 목록 (created 오름차순) */
function BZRoundsOfPlayer(battle, playerId) {
  return BZBattleRounds(battle)
    .filter((r) => r.player === playerId)
    .sort((a, b) => String(a.created || "").localeCompare(String(b.created || "")));
}

// ---------- 캐시 (bz_pubg_cache 컬렉션) ----------

function BZCacheGet(key) {
  try {
    const rec = $app.findFirstRecordByFilter("bz_pubg_cache", "key = {:k}", { k: key });
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
      rec = $app.findFirstRecordByFilter("bz_pubg_cache", "key = {:k}", { k: key });
    } catch (e) {
      rec = null;
    }
    if (!rec) {
      rec = new Record($app.findCollectionByNameOrId("bz_pubg_cache"));
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
    const keys = $app.findRecordsByFilter("bz_pubg_keys", "enabled = true", "label", 1, 0);
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
    keys = $app.findRecordsByFilter("bz_pubg_keys", "enabled = true", "label", BZ_KEYS_MAX, 0);
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
    keys = $app.findRecordsByFilter("bz_pubg_keys", "", "label", BZ_KEYS_MAX, 0);
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

/**
 * 2분 틱당 스캔 가능한 대전 수 (키 1개 = 10회/분, 대전당 2회 필요 → ×8 여유 마진).
 * 키를 추가하면 다음 틱부터 자동으로 스캔 범위가 늘어난다. 절대 상한은 BZ_SCAN_MAX_BATTLES.
 */
function BZScanCapacity() {
  try {
    const keys = $app.findRecordsByFilter("bz_pubg_keys", "enabled = true", "", BZ_KEYS_MAX, 0);
    return Math.min(BZ_SCAN_MAX_BATTLES, (keys || []).length * 8);
  } catch (e) {
    return 0;
  }
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
  let rec = BZFirst("bz_rankings", "user = {:u}", { u: userId });
  if (rec) return rec;
  rec = new Record($app.findCollectionByNameOrId("bz_rankings"));
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

  // 정산 요약을 배틀 레코드에 저장 (matches 컬렉션 대체)
  const finishedAt = battle.getString("finished_at") || BZNow();
  const killsA = battle.getInt("kills_a");
  const killsB = battle.getInt("kills_b");
  // 라운드 레코드에서 총 킬수 재계산
  const rounds = BZBattleRounds(battle);
  let totalKillsA = 0;
  let totalKillsB = 0;
  for (const r of rounds) {
    const k = Number(r.kills_final ?? r.kills_api ?? 0);
    if (r.player === pa) totalKillsA += k;
    else if (r.player === pb) totalKillsB += k;
  }
  battle.set("total_kills_a", totalKillsA);
  battle.set("total_kills_b", totalKillsB);
  battle.set("rounds_count", rounds.length);
  battle.set("duration_sec", Math.round((new Date(finishedAt).getTime() - new Date(battle.getString("playing_at") || finishedAt).getTime()) / 1000));

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
 * 수동 기록 추가 검증 (라운드 추가 라우트용).
 * 진행 중 대전 참가자만 기록 가능, 5분 간격 + 검증 대기 3건 상한.
 * @returns {string|null} 거부 사유 (null = 허용)
 */
function BZRoundAddValidate(battle, playerId) {
  if (!battle) return "대전을 찾을 수 없습니다.";
  if (battle.getString("player_a") !== playerId && battle.getString("player_b") !== playerId) {
    return "대전 참가자가 아닙니다.";
  }
  if (battle.getString("status") !== "playing") {
    return "진행 중인 대전에서만 기록할 수 있습니다.";
  }
  const limitMin = 5;
  const now = Date.now();
  let pendingCount = 0;
  let lastCreated = 0;
  for (const r of BZRoundsOfPlayer(battle, playerId)) {
    if (r.status !== "manual") continue;
    pendingCount++;
    const cMs = new Date(r.created || "").getTime();
    if (cMs > lastCreated) lastCreated = cMs;
  }
  if (pendingCount >= 3) {
    return "검증 대기 중인 기록이 3건 이상입니다. 검증 완료 후 다시 기록해 주세요.";
  }
  if (lastCreated && now - lastCreated < limitMin * 60 * 1000) {
    return "기록은 " + limitMin + "분 간격으로 추가할 수 있습니다. 잠시 후 다시 시도해 주세요.";
  }
  return null;
}

/**
 * 플레이어 1명의 최근 PUBG 매치를 스캔해 bz_battles.rounds 배열에 기록을 추가/검증한다.
 * - 종료 매치 → 미검증 수동 기록 페어링 (1단계: 킬수 일치 우선)
 * - 킬수 불일치 수동 기록 → 시간 윈도우 내 가장 최근 매치로 API 값 보정 후 확정 (2단계)
 * - 페어링 안 된 종료 매치 → 자동 verified 기록 추가 (fallback)
 * - 진행 중 매치(404) → pending_verify 기록 추가 (다음 틱에서 재확인)
 * - 미검증 수동 기록: 기존 자동 기록과 중복 시 무효 처리, 20분(진행 중 매치 보호 시 60분) 초과 시 불일치/무효 처리
 * - 이미 기록된 매치 → 건너뜀 (중복 방지)
 * - 배틀 시작 이전 매치 → 스캔 중단 (매치 목록은 최신순)
 * @returns {{rateLimited?: boolean, noKeys?: boolean, skipped?: string, added?: number, confirmed?: number, paired?: number, resolved?: number}}
 */
/**
 * 이미 자동 기록된(verified) 매치와 동일한 미검증 수동 기록 → 중복 무효 처리 (API 추가 호출 없음).
 * 같은 게임이 이미 자동 기록되면 킬수 중복 집계를 막기 위해 수동 기록을 무효화한다.
 * @param {object[]} rounds bz_battles.rounds (평면 객체 배열)
 */
function BZCrossCheckManual(rounds, manualPending, battleId, playerId, nickname) {
  let count = 0;
  for (let i = manualPending.length - 1; i >= 0; i--) {
    const rec = manualPending[i];
    const cMs = new Date(rec.created || "").getTime();
    if (!cMs) continue;
    for (const r2 of rounds) {
      if (r2 === rec) continue;
      if (r2.status !== "verified") continue;
      if (r2.player !== playerId) continue;
      const gMs = new Date(r2.game_started_at || "").getTime();
      if (!gMs) continue;
      if (gMs < cMs - 2 * 3600 * 1000 || gMs > cMs + 10 * 60 * 1000) continue;
      if (Number(r2.kills_final || r2.kills_api || 0) !== Number(rec.kills_manual || 0)) continue;
      // 같은 매치가 이미 자동 기록됨 → 중복이므로 무효 처리 (킬수 중복 집계 방지)
      rec.status = "void";
      rec.note = "기존 자동 기록과 동일하여 중복 처리";
      BZLog("verify", "수동 기록 중복 처리: " + nickname + " (match=" + r2.match_id + ") battle=" + battleId);
      count++;
      manualPending.splice(i, 1);
      break;
    }
  }
  return count;
}

/** 시간 윈도우 내 가장 최근 verified 기록 (불일치 판정 근거용) */
function BZNewestRecordInWindow(rounds, rec) {
  const cMs = new Date(rec.created || "").getTime();
  if (!cMs) return null;
  let best = null;
  let bestMs = 0;
  for (const r2 of rounds) {
    if (r2 === rec) continue;
    if (r2.status !== "verified") continue;
    const gMs = new Date(r2.game_started_at || "").getTime();
    if (!gMs) continue;
    if (gMs < cMs - 2 * 3600 * 1000 || gMs > cMs + 10 * 60 * 1000) continue;
    if (gMs > bestMs) {
      bestMs = gMs;
      best = r2;
    }
  }
  return best;
}

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

  // 라운드 목록 (bz_battle_rounds 레코드 단위 — 수정 후 저장은 commit()으로 일괄 처리)
  const rounds = BZBattleRounds(battle);
  let dirty = false;
  const origJson = new Map(); // 라운드별 원본 스냅샷 (변경 감지)
  const knownIds = new Set();
  for (const r of rounds) {
    knownIds.add(r.id);
    origJson.set(r.id, JSON.stringify(r));
  }
  const commit = () => {
    if (!dirty) return;
    dirty = false;
    try {
      for (const r of rounds) {
        if (!knownIds.has(r.id)) {
          // 스캔 중 새로 추가된 라운드 → 레코드 INSERT (기존 레코드와 독립적이라 안전)
          const rec = new Record($app.findCollectionByNameOrId("bz_battle_rounds"));
          rec.set("battle", battle.id);
          for (const f of BZ_ROUND_FIELDS) {
            if (r[f] !== undefined && r[f] !== null) rec.set(f, r[f]);
          }
          rec.set("created", r.created || BZNow());
          $app.save(rec);
          r.id = rec.id;
          knownIds.add(r.id);
          origJson.set(r.id, JSON.stringify(r));
          continue;
        }
        if (origJson.get(r.id) === JSON.stringify(r)) continue; // 변경 없음
        const rec = $app.findRecordById("bz_battle_rounds", r.id);
        if (!rec) continue; // 사용자가 방금 삭제한 기록
        for (const f of BZ_ROUND_FIELDS) {
          if (r[f] !== undefined && r[f] !== null) rec.set(f, r[f]);
        }
        $app.save(rec);
        origJson.set(r.id, JSON.stringify(r));
      }
    } catch (e) {
      BZLog("scan", "라운드 저장 실패 (battle=" + battle.id + ") " + String((e && e.message) || e));
    }
  };

  // 구식(수동) 기록 정리: match_id 없는 playing/pending_verify → void
  for (const r of rounds) {
    const s = r.status;
    if ((s === "playing" || s === "pending_verify") && !r.match_id) {
      r.status = "void";
      r.note = "자동 기록 전환으로 무효 처리";
      dirty = true;
    }
  }

  let nextNumber = 0;
  for (const r of rounds) {
    if (r.player !== playerId) continue;
    nextNumber = Math.max(nextNumber, Number(r.round_number) || 0);
  }

  const recorded = new Set();
  for (const r of rounds) {
    if (r.match_id) recorded.add(r.match_id);
  }

  // 미검증 수동 기록 (created 오름차순 — 오래된 기록부터 페어링)
  const manualPending = rounds
    .filter((r) => r.player === playerId && r.status === "manual")
    .sort((a, b) => String(a.created || "").localeCompare(String(b.created || "")));

  // 최신 매치부터 스캔 (종료 매치는 후보로 수집, 진행 중 매치는 즉시 기록)
  let added = 0;
  let scanned = 0;
  let matchesFound = list.ids.length;
  let detailErrors = 0;
  let noCreatedAt = 0;
  let oldMatches = 0;
  let paired = 0;
  const completed = [];
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
      rounds.push({
        id: BZRoundId(),
        created: BZNow(),
        player: playerId,
        round_number: nextNumber,
        status: "pending_verify",
        match_id: matchId,
        game_started_at: detail.createdAt || "",
        map: detail.mapName || "",
        verified_at: BZNow(),
        note: "자동 기록 (게임 진행 중)",
      });
      dirty = true;
      added++;
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
    completed.push({ matchId, detail, stats, createdMs });
  }

  // 수동 기록 페어링 — 1단계: 킬수 일치 우선, 2단계: 시간 윈도우 내 가장 최근 매치로 API 값 보정
  const usedMatch = new Set();
  let mi = 0;
  while (mi < manualPending.length) {
    const rec = manualPending[mi];
    const cMs = new Date(rec.created || "").getTime();
    if (!cMs) {
      mi++;
      continue;
    }
    const win = completed.filter(
      (c) =>
        c.stats.matched &&
        !usedMatch.has(c.matchId) &&
        c.createdMs >= cMs - 2 * 3600 * 1000 &&
        c.createdMs <= cMs + 10 * 60 * 1000
    );
    if (!win.length) {
      mi++;
      continue;
    }
    let pick = win.find((c) => Number(c.stats.kills) === Number(rec.kills_manual || 0)) || null;
    const corrected = !pick;
    if (corrected) {
      // 킬수 불일치 → 시간 윈도우 내 가장 최근 매치로 보정
      pick = win.reduce((a, b) => (b.createdMs > a.createdMs ? b : a));
    }
    const apiKills = pick.stats.kills;
    rec.status = "verified";
    rec.kills_api = apiKills;
    rec.kills_final = apiKills;
    rec.match_id = pick.matchId;
    rec.game_started_at = pick.detail.createdAt || "";
    rec.map = pick.detail.mapName || "";
    rec.placement = pick.stats.placement;
    rec.verified_at = BZNow();
    rec.note = corrected ? "수동 입력 보정 (API " + apiKills + "킬)" : "수동 기록 검증 완료";
    dirty = true;
    paired++;
    BZLog(
      "verify",
      "수동 기록 검증 완료" + (corrected ? " (보정)" : "") + ": " + nickname + " " + apiKills + "킬 (match=" + pick.matchId + ") battle=" + battle.id
    );
    usedMatch.add(pick.matchId);
    recorded.add(pick.matchId);
    manualPending.splice(mi, 1);
  }

  // 남은 종료 매치 → 자동 기록 (fallback)
  for (const c of completed) {
    if (usedMatch.has(c.matchId)) continue;
    const kills = c.stats.kills;
    const placement = c.stats.placement;
    nextNumber++;
    rounds.push({
      id: BZRoundId(),
      created: BZNow(),
      player: playerId,
      round_number: nextNumber,
      status: "verified",
      match_id: c.matchId,
      game_started_at: c.detail.createdAt,
      map: c.detail.mapName || "",
      placement,
      kills_api: kills,
      kills_final: kills,
      verified_at: BZNow(),
      note: "자동 기록",
    });
    dirty = true;
    added++;
    BZLog("verify", "자동 기록 추가: " + nickname + " " + kills + "킬 (match=" + c.matchId + ") battle=" + battle.id);
    recorded.add(c.matchId);
  }

  // 3) 이미 자동 기록된 매치와 교차 확인 (늦게 입력한 수동 기록 확정)
  if (BZCrossCheckManual(rounds, manualPending, battle.id, playerId, nickname) > 0) {
    dirty = true;
  }

  // 4) 미검증 수동 기록 해소 — 20분 기본, 진행 중 매치가 있으면 60분까지 유지 (가짜 기록 조기 차단)
  let resolved = 0;
  const sweepMs = 20 * 60 * 1000;
  const hardMs = 60 * 60 * 1000;
  const nowMs = Date.now();
  for (const rec of manualPending) {
    const cMs = new Date(rec.created || "").getTime();
    const age = nowMs - cMs;
    if (!cMs || age < sweepMs) continue;
    if (age < hardMs) {
      // 아직 게임이 진행 중일 수 있으면 대기 (진행 중 매치 기록이 근처에 존재)
      let nearby = false;
      for (const r2 of rounds) {
        if (r2.status !== "pending_verify") continue;
        const gMs = new Date(r2.game_started_at || "").getTime();
        if (!gMs) continue;
        if (gMs <= cMs && cMs - gMs <= 45 * 60 * 1000) {
          nearby = true;
          break;
        }
      }
      if (nearby) continue;
    }
    const evidence = BZNewestRecordInWindow(rounds, rec);
    if (evidence) {
      const evKills = evidence.kills_final || evidence.kills_api || 0;
      if (Number(evKills) === Number(rec.kills_manual || 0)) {
        // 이미 집계된 매치와 동일 → 중복 무효 처리
        rec.status = "void";
        rec.note = "기존 자동 기록과 동일하여 중복 처리";
        BZLog("verify", "수동 기록 중복 처리: " + nickname + " (수동 " + rec.kills_manual + "킬, 이미 집계됨) battle=" + battle.id);
      } else {
        rec.status = "mismatch";
        rec.kills_api = evKills;
        rec.kills_final = 0;
        rec.note = "수동 기록 불일치 (API " + evKills + "킬)";
        BZLog("verify", "수동 기록 불일치 처리: " + nickname + " (수동 " + rec.kills_manual + "킬 vs API " + evKills + "킬) battle=" + battle.id);
      }
    } else {
      rec.status = "void";
      rec.note = "검증 매치 없음 (20분 경과)";
      BZLog("verify", "수동 기록 검증 불가 처리: " + nickname + " (매치 없음) battle=" + battle.id);
    }
    dirty = true;
    resolved++;
  }

  // pending_verify 기록 재확인 (매치 종료 감지)
  let confirmed = 0;
  for (const r of rounds) {
    if (r.player !== playerId) continue;
    if (r.status !== "pending_verify") continue;
    const mid = r.match_id;
    if (!mid) continue;
    const detail = await BZMatchDetail(mid);
    if (detail.noKeys) {
      commit();
      return { noKeys: true };
    }
    if (detail.rateLimited) {
      commit();
      return { rateLimited: true };
    }
    if (detail.error || detail.ongoing) continue;

    const createdMs = detail.createdAt ? new Date(detail.createdAt).getTime() : 0;
    if (minMs && createdMs && createdMs < minMs) {
      // 배틀 시작 이전에 시작된 매치 → 무효
      r.status = "void";
      r.note = "배틀 시작 이전 매치";
      dirty = true;
      continue;
    }

    const stats = BZPlayerMatchStats(detail, pid.playerId, nickname);
    if (!stats.matched && detail.participantCount > 0) {
      BZLog("scan", "참가자 매칭 실패: " + nickname + " (match=" + mid + ", 참가자 " + detail.participantCount + "명) battle=" + battle.id);
    }
    r.status = "verified";
    r.kills_api = stats.kills;
    r.kills_final = stats.kills;
    r.game_started_at = detail.createdAt || r.game_started_at || "";
    r.map = detail.mapName || r.map || "";
    r.placement = stats.placement || Number(r.placement || 0);
    r.verified_at = BZNow();
    dirty = true;
    confirmed++;
    BZLog("verify", "매치 종료 감지 → 검증 확정: " + nickname + " " + stats.kills + "킬 (match=" + mid + ") battle=" + battle.id);
  }

  commit();

  return {
    rateLimited: false,
    added,
    confirmed,
    paired,
    resolved,
    matchesFound,
    detailErrors,
    noCreatedAt,
    oldMatches,
  };
}

/** verified 킬수 + 수동(검증 대기) 킬수 합산으로 배틀 킬수 재계산 (멱등) */
function BZRecomputeKills(battle) {
  let ka = 0;
  let kb = 0;
  let pa = 0;
  let pb = 0;
  const rounds = BZBattleRounds(battle);
  for (const r of rounds) {
    const p = r.player;
    if (r.status === "verified") {
      const k = Number(r.kills_final || r.kills_api || 0);
      if (p === battle.getString("player_a")) ka += k;
      else if (p === battle.getString("player_b")) kb += k;
    } else if (r.status === "manual") {
      const k = Number(r.kills_manual || 0);
      if (p === battle.getString("player_a")) pa += k;
      else if (p === battle.getString("player_b")) pb += k;
    }
  }
  battle.set("kills_a", ka);
  battle.set("kills_b", kb);
  battle.set("pending_kills_a", pa);
  battle.set("pending_kills_b", pb);
}

/**
 * 목표 킬수 달성 시 승리 확정 + 정산 (검증 후 확정 모델).
 * - 수동(검증 전) 킬 포함 도달 → winner_pending + settling, API 검증 후 확정
 * - 검증된 킬만으로 도달 → 즉시 확정
 * - settling 중: pending 해소(검증)되면 확정, 총합이 목표 미달로 무너지면 재개
 */
function BZCheckWin(battle) {
  if (battle.getString("winner")) return;
  const target = battle.getInt("target_kills") || 5;
  const pa = battle.getString("player_a");
  const pb = battle.getString("player_b");
  const wp = battle.getString("winner_pending");
  const status = battle.getString("status");

  // 검증 대기 중 확정/재개 판정
  if (status === "settling" && wp) {
    const wSide = wp === pa ? "a" : "b";
    const verified = battle.getInt(wSide === "a" ? "kills_a" : "kills_b");
    const pending = battle.getInt(wSide === "a" ? "pending_kills_a" : "pending_kills_b");
    const total = verified + pending;
    if (total >= target && pending === 0) {
      // 수동 기록 검증 완료 → 승리 확정
      battle.set("winner", wp);
      battle.set("winner_pending", "");
      battle.set("status", "finished");
      try {
        $app.save(battle);
      } catch (e) {
        return;
      }
      const settled = BZDoSettle(battle);
      BZLog("verify", "검증 후 승리 확정: " + wp + " (" + verified + "킬) battle=" + battle.id + (settled.ok ? "" : " 정산 보류"));
      return;
    }
    if (total < target) {
      // 검증 불일치/무효로 무너짐 → 재개
      battle.set("winner_pending", "");
      battle.set("status", "playing");
      try {
        $app.save(battle);
      } catch (e) {
        return;
      }
      BZLog("verify", "검증 불일치로 대전 재개: " + wp + " (총합 " + total + "킬) battle=" + battle.id);
      return;
    }
    return; // 아직 검증 대기 중
  }

  const ka = battle.getInt("kills_a") + battle.getInt("pending_kills_a");
  const kb = battle.getInt("kills_b") + battle.getInt("pending_kills_b");
  if (ka < target && kb < target) return;

  let winner = null;
  if (ka >= target && kb >= target) {
    // 동시 도달: 검증 킬로 도달한 쪽 우선, 동률이면 총합 우위, 같으면 A
    const va = battle.getInt("kills_a");
    const vb = battle.getInt("kills_b");
    if (va >= target && vb < target) winner = pa;
    else if (vb >= target && va < target) winner = pb;
    else winner = ka >= kb ? pa : pb;
  } else {
    winner = ka >= target ? pa : pb;
  }

  const wSide = winner === pa ? "a" : "b";
  const pendingW = battle.getInt(wSide === "a" ? "pending_kills_a" : "pending_kills_b");
  if (pendingW > 0) {
    // 수동(검증 전) 킬 포함 도달 → 검증 대기
    battle.set("winner_pending", winner);
    battle.set("status", "settling");
    try {
      $app.save(battle);
    } catch (e) {
      return;
    }
    BZLog("verify", "목표 도달 (검증 대기): " + winner + " (" + ka + " vs " + kb + ") battle=" + battle.id);
    return;
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

/**
 * 배틀을 최신 DB 상태로 재조회해 킬수/승리 상태를 재계산하고 저장한다.
 * 호출 시점의 배틀 객체는 스냅샷일 수 있으므로(동시 수동 기록/스캔) 라운드 배열 보존을 위해
 * 이 함수로 일괄 갱신한다. BZCheckWin 이 내부적으로 상태를 저장하면 최종 $app.save 는 멱등.
 * @param {object} [extra] 저장 시 함께 반영할 필드 (예: { last_scanned_at })
 * @returns {object|null} 최신 배틀 레코드
 */
function BZRefreshBattleOutcome(battleId, extra) {
  const fresh = BZFindById("bz_battles", battleId);
  if (!fresh) return null;
  if (extra) {
    for (const k of Object.keys(extra)) {
      if (extra[k] !== undefined) fresh.set(k, extra[k]);
    }
  }
  BZRecomputeKills(fresh);
  try {
    BZCheckWin(fresh);
  } catch (e) {
    /* 무시 */
  }
  try {
    $app.save(fresh);
  } catch (e) {
    /* 무시 */
  }
  return fresh;
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
  if (battle.getString("status") !== "playing" &&
      !(battle.getString("status") === "settling" && battle.getString("winner_pending"))) {
    return { rateLimited: false, players: [] };
  }

  // 공평 순환용: 마지막 스캔 시각 기록 (끝의 $app.save 와 함께 저장됨)
  battle.set("last_scanned_at", BZNow());

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
    } else if ((p.added || 0) > 0 || (p.confirmed || 0) > 0 || (p.paired || 0) > 0 || (p.resolved || 0) > 0 || (p.detailErrors || 0) > 0) {
      // 변경이 없는 스캔은 로그 생략 (로그 노이즈/볼륨 방지)
      BZLog("scan", "스캔 완료 " + p.side + ": 추가 " + (p.added || 0) + "건 / 확정 " + (p.confirmed || 0) + "건 / 수동 검증 " + (p.paired || 0) + "건 / 해소 " + (p.resolved || 0) + "건, 매치 " + (p.matchesFound || 0) + "개 중 이전 " + (p.oldMatches || 0) + "개, 상세 오류 " + (p.detailErrors || 0) + "건 (battle=" + battle.id + ")");
    }
  }

  // 최신 상태로 킬수/승리 재계산 — 스냅샷 배틀을 통째로 저장하지 않아 수동 기록이 보존된다
  BZRefreshBattleOutcome(battle.id, { last_scanned_at: battle.getString("last_scanned_at") });
  return { rateLimited: false, players };
}

/**
 * 주기 정리 (크론 틱에서 호출, 스토어 스로틀로 30분 간격 실행).
 * - bz_pubg_cache : 만료/30일 초과 행 삭제 + 키 중복 행 정리 (UNIQUE 인덱스 대비)
 * - bz_admin_logs : 최근 3000건 초과 시 오래된 행 삭제
 * - bz_queue : cancelled/matched 7일 초과 행 삭제
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
    // 1) bz_pubg_cache 정리
    const cacheRows = $app.findRecordsByFilter(
      "bz_pubg_cache",
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
    const allCache = $app.findRecordsByFilter("bz_pubg_cache", "", "created", 5000, 0);
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
    // 2) bz_admin_logs: 최근 3000건 유지
    const maxLogs = 3000;
    const total = $app.countRecords("bz_admin_logs");
    if (total > maxLogs) {
      const excess = Math.min(total - maxLogs, 1000);
      const old = $app.findRecordsByFilter("bz_admin_logs", "", "created", excess, 0);
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
    // 3) bz_queue: cancelled/matched 7일 초과 삭제
    const oldQueues = $app.findRecordsByFilter(
      "bz_queue",
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

/** 활성 대전 전체 자동 스캔 (크론용) — 키 수에 맞춘 동적 캡 + 병렬 처리 + 공평 순환 */
async function BZAutoScanAll() {
  if ($app.store().get("bz_scan_busy")) return { ok: false, busy: true };
  $app.store().set("bz_scan_busy", true);
  try {
    let battles = [];
    try {
      battles = $app.findRecordsByFilter(
        "bz_battles",
        "status = 'playing' || status = 'settling'",
        "created",
        2000,
        0
      );
    } catch (e) {
      return { ok: false };
    }
    // 공평 순환: 가장 오래 스캔 안 된 대전부터 (미스캔된 대전 = 빈 문자열 = 항상 우선)
    battles.sort((a, b) => {
      const la = a.getString("last_scanned_at") || "";
      const lb = b.getString("last_scanned_at") || "";
      return la.localeCompare(lb);
    });

    const limit = BZScanCapacity();
    if (limit <= 0) {
      BZLog("scan", "스캔 중단: 사용 가능한 PUBG API 키가 없습니다. 관리자 설정에서 키를 등록해 주세요.");
      return { ok: true, scanned: 0 };
    }

    const targets = battles.slice(0, limit);
    let scanned = 0;
    let stopped = false;
    const tickStart = Date.now();
    // 병렬 스캔: 키 레이트 리미터(BZAcquireKey)가 1분 10회 초과를 차단하므로
    // 여러 워커가 동시에 돌아도 PUBG API를 초과 호출하지 않는다.
    // 데드라인(BZ_SCAN_TICK_MS) 이후에는 새 대전을 꺼내지 않아
    // PUBG API 장애(15초 타임아웃 × 대전당 2회) 시에도 틱이 수십 분 걸리는 것을 방지한다.
    const worker = async () => {
      while (!stopped) {
        if (Date.now() - tickStart > BZ_SCAN_TICK_MS) return;
        const battle = targets.shift();
        if (!battle) return;
        const res = await BZScanBattle(battle);
        if (res.noKeys) {
          stopped = true;
          return;
        }
        if (res.rateLimited) {
          stopped = true;
          BZLog("scan", "스캔 중단: PUBG API 키 한도 도달 (" + targets.length + "개 대전 다음 틱으로 대기)");
          return;
        }
        scanned++;
      }
    };
    const workers = Array.from(
      { length: Math.min(BZ_SCAN_CONCURRENCY, targets.length) },
      () => worker()
    );
    await Promise.all(workers);
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
        "bz_queue",
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

    const battle = new Record($app.findCollectionByNameOrId("bz_battles"));
    battle.set("season", season);
    battle.set("target_kills", settings.getInt("target_kills") || 5);
    battle.set("player_a", best.a.getString("user"));
    battle.set("player_b", best.b.getString("user"));
    battle.set("kills_a", 0);
    battle.set("kills_b", 0);
    battle.set("pending_kills_a", 0);
    battle.set("pending_kills_b", 0);
    battle.set("rounds", []);
    battle.set("total_kills_a", 0);
    battle.set("total_kills_b", 0);
    battle.set("rounds_count", 0);
    battle.set("duration_sec", 0);
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

/**
 * 대기열을 묶음으로 매칭 (크론용). 새 등록이 없어도 대기자를 계속 매칭한다.
 * 호출당 최대 maxPairs 쌍까지 순차 성사시킨다.
 * @returns {number} 성사된 대전 수
 */
function BZRunMatchmakingDrain(maxPairs) {
  const cap = maxPairs ?? BZ_MM_MAX_PAIRS_PER_TICK;
  let pairs = 0;
  while (pairs < cap) {
    const made = BZRunMatchmaking();
    if (!made) break;
    pairs += made;
  }
  return pairs;
}

/** 대기열 취소 시 대기(pending) 대전 취소 + 상대 큐 복구 */
function BZHandleQueueCancel(battleId, userId) {
  const battle = BZFindById("bz_battles", battleId);
  if (!battle) return;
  if (battle.getString("status") !== "pending") return;
  try {
    battle.set("status", "cancelled");
    $app.save(battle);
    const opp = BZOpponentOf(battle, userId);
    if (opp) {
      const oppQueue = BZFirst("bz_queue", "battle_id = {:b} && user = {:u} && status = 'matched'", {
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
  BZRoundId: BZRoundId,
  BZBattleRounds: BZBattleRounds,
  BZRoundAdd: BZRoundAdd,
  BZRoundUpdate: BZRoundUpdate,
  BZRoundRemove: BZRoundRemove,
  BZRoundsOfPlayer: BZRoundsOfPlayer,
  BZRoundAddValidate: BZRoundAddValidate,
  BZRecomputeKills: BZRecomputeKills,
  BZCheckWin: BZCheckWin,
  BZRefreshBattleOutcome: BZRefreshBattleOutcome,
  BZScanBattle: BZScanBattle,
  BZAutoScanAll: BZAutoScanAll,
  BZMaintenance: BZMaintenance,
  BZRunMatchmaking: BZRunMatchmaking,
  BZRunMatchmakingDrain: BZRunMatchmakingDrain,
  BZHandleQueueCancel: BZHandleQueueCancel,
};