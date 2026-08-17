// BATTLEZONE ?щ궡湲?- 怨듭슜 ?ы띁 紐⑤뱢
// PocketBase v0.23+ ??媛??몃뱾??route/hook)瑜?蹂꾨룄 寃⑸━ ?꾨줈洹몃옩?쇰줈 ?ㅽ뻾?섎?濡?
// ?몃뱾??諛뽰뿉 ?좎뼵???⑥닔???몃뱾?ъ뿉???묎렐?????녿떎.
// ?곕씪??紐⑤뱺 ?ы띁瑜???紐⑤뱢濡???린怨?媛??몃뱾?ъ뿉??require() 濡?濡쒕뱶?쒕떎.
// (李멸퀬: https://pocketbase.io/docs/js-overview/#handlers-scope)

// ---------- ?곸닔 ----------

const BZ_SHARD = "steam";
const BZ_API = "https://api.pubg.com";
const BZ_PID_TTL = 30 * 24 * 3600 * 1000; // ?뚮젅?댁뼱 ID: 30??const BZ_LIST_TTL = 60000; // 留ㅼ튂 紐⑸줉: 60珥?const BZ_MATCH_TTL = 7 * 24 * 3600 * 1000; // 留ㅼ튂 ?곸꽭: 7??// 諛고? ?쒖옉(?쒖옉 ?뺤씤) ?쒓컖怨??ㅼ젣 PUBG 留ㅼ튂 ?쒖옉 ?쒓컖? ?쒖꽌媛 ?ㅻ컮?????덉쑝誘濡?// (留ㅼ튂 李멸? ???쒖옉 ?뺤씤 / ?쒖옉 ?뺤씤 ??李멸?) ?먮룞 ?ㅼ틪 ??諛고? ?쒖옉 ?쒓컖 ?鍮??덉슜 ?ㅼ감濡??ъ슜?쒕떎.
const BZ_VERIFY_TOL_MS = 20 * 60 * 1000; // 짹20遺?const BZ_SCAN_MAX_BATTLES = 5; // ?щ줎 ?깅떦 ?ㅼ틪 ?????const BZ_SCAN_MAX_MATCHES = 4; // ?뚮젅?댁뼱???깅떦 ?좉퇋 留ㅼ튂 泥섎━ ??
// ???덉씠??由щ???(?щ씪?대뵫 ?덈룄??60珥?10??
const BZ_RL_WINDOW_MS = 60000;
const BZ_RL_MAX_PER_MIN = 10;

// ---------- 湲곕낯 ?좏떥 ----------

function BZBody(c) {
  try {
    const info = c.requestInfo();
    const b = info && info.body;
    if (b && typeof b === "object") return b;
  } catch (e) {
    /* 臾댁떆 */
  }
  try {
    const raw = String(c.request.body || "");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return parsed;
      } catch (e) {
        /* 臾댁떆 */
      }
    }
  } catch (e) {
    /* 臾댁떆 */
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
  // ?ㅼ젙???놁쑝硫?湲곕낯媛믪쑝濡??앹꽦
  const nr = new Record($app.findCollectionByNameOrId("game_settings"));
  nr.set("target_kills", 5);
  nr.set("season", "?쒖쫵 1");
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
    /* 臾댁떆 */
  }
}

// ---------- 罹먯떆 (pubg_cache 而щ젆?? ----------

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
    /* 罹먯떆 ?ㅽ뙣??移섎챸?곸씠吏 ?딆쓬 */
  }
}

// ---------- ???덉씠??由щ???----------

/**
 * ?ъ쑀媛 ?덈뒗 ???섎굹瑜??띾뱷?쒕떎. ?꾨? ?뚯쭊?대㈃ null.
 * ?띾뱷 ???몄텧 湲곕줉???덈룄?곗뿉 異붽??섍퀬 last_used_at ??媛깆떊?쒕떎.
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
    /* 臾댁떆 */
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

/** 愿由ъ옄 UI ?? ?ㅻ퀎 ?꾩옱 ?덈룄???ъ슜??議고쉶 */
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
 * PUBG API GET ?붿껌. ?덉씠??由щ??곕? 嫄곗튇??
 * @returns {{rateLimited?: boolean, error?: string, notFound?: boolean, json?: object}}
 */
async function BZPubgGet(path) {
  const key = BZAcquireKey();
  if (!key) return { rateLimited: true };
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
      return { error: "PUBG API ?ㅻ쪟 " + res.statusCode };
    }
    return { json: res.json || {} };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

/** Steam ?됰꽕?????뚮젅?댁뼱 ID (罹먯떆: 30?? */
async function BZResolvePlayerId(nickname) {
  const name = String(nickname || "").trim();
  if (!name) return { error: "?됰꽕?꾩씠 ?놁뒿?덈떎." };
  const cacheKey = "pid:" + name.toLowerCase();
  const cached = BZCacheGet(cacheKey);
  if (cached) return { playerId: cached };

  const res = await BZPubgGet(
    "/shards/" + BZ_SHARD + "/players?filter%5BplayerNames%5D=" + encodeURIComponent(name)
  );
  if (res.rateLimited) return { rateLimited: true };
  if (res.notFound) return { notFound: true };
  if (res.error) return { error: res.error };
  const data = res.json && res.json.data;
  if (!data || !data.length) return { notFound: true };
  BZCacheSet(cacheKey, data[0].id, BZ_PID_TTL);
  return { playerId: data[0].id };
}

/** ?뚮젅?댁뼱 理쒓렐 留ㅼ튂 ID 紐⑸줉 (罹먯떆: 60珥? */
async function BZRecentMatches(playerId) {
  const cacheKey = "matches:" + playerId;
  const cached = BZCacheGet(cacheKey);
  if (cached && Array.isArray(cached)) return { ids: cached };

  const res = await BZPubgGet("/shards/" + BZ_SHARD + "/players/" + playerId + "/matches");
  if (res.rateLimited) return { rateLimited: true };
  if (res.notFound) return { ids: [] };
  if (res.error) return { error: res.error };
  const list = (res.json && res.json.data && res.json.data[0] && res.json.data[0].relationships &&
    res.json.data[0].relationships.matches &&
    res.json.data[0].relationships.matches.data) || [];
  const ids = list.map((m) => m.id).filter(Boolean);
  BZCacheSet(cacheKey, ids, BZ_LIST_TTL);
  return { ids };
}

/**
 * 留ㅼ튂 ?곸꽭 (罹먯떆: 7??.
 * @returns {{ongoing?: boolean, error?: string, createdAt?: string, killsByPlayer?: object}}
 */
async function BZMatchDetail(matchId) {
  const cacheKey = "match:" + matchId;
  const cached = BZCacheGet(cacheKey);
  if (cached) return cached;

  const res = await BZPubgGet("/shards/" + BZ_SHARD + "/matches/" + matchId);
  if (res.rateLimited) return { rateLimited: true };
  if (res.notFound) {
    // 吏꾪뻾 以묒씤 留ㅼ튂: ?꾩쭅 ?곗씠?곌? ?놁쓬 (罹먯떆?섏? ?딆쓬)
    return { ongoing: true };
  }
  if (res.error) return { error: res.error };

  const d = res.json && res.json.data;
  const included = (res.json && res.json.included) || [];
  const createdAt = d && d.attributes && d.attributes.createdAt;
  const killsByPlayer = {};
  for (const inc of included) {
    if (inc.type === "participant" && inc.attributes && inc.attributes.stats &&
      inc.relationships && inc.relationships.player && inc.relationships.player.data) {
      const pid = inc.relationships.player.data.id;
      killsByPlayer[pid] = Number(inc.attributes.stats.kills || 0);
    }
  }
  const detail = { createdAt, killsByPlayer };
  BZCacheSet(cacheKey, detail, BZ_MATCH_TTL);
  return detail;
}

// ---------- ????곹깭 泥섎━ ----------

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

/** ??궧 ?덉퐫??議고쉶(?놁쑝硫??앹꽦) */
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
    /* 臾댁떆 */
  }
  return rec;
}

function BZNicknameOf(userId) {
  const u = BZFindById("users", userId);
  if (!u) return userId;
  return u.getString("username") || u.getString("name") || u.getString("email") || userId;
}

/** Elo 怨꾩궛 (?쒖? Elo, K 怨꾩닔) */
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
 * ????뺤궛: ?뱁뙣???곕씪 Elo 怨꾩궛 ????궧/?꾩쟻(matches) 媛깆떊.
 * finished / forfeit ?곹깭?먯꽌留??숈옉?섎ŉ, ?대? ?뺤궛(finished_at)??寃쎌슦 臾댁떆?쒕떎.
 */
function BZDoSettle(battle) {
  const status = battle.getString("status");
  if (status !== "finished" && status !== "forfeit") return { ok: false, message: "?뺤궛 媛?ν븳 ?곹깭媛 ?꾨떃?덈떎." };
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
    return { ok: false, message: "??궧 ????ㅽ뙣" };
  }

  // ?꾩쟻(matches) 湲곕줉
  const finishedAt = battle.getString("finished_at") || BZNow();
  const killsA = battle.getInt("kills_a");
  const killsB = battle.getInt("kills_b");
  try {
    const mk = (playerId, result, kills, oppKills) => {
      const m = new Record($app.findCollectionByNameOrId("matches"));
      m.set("player", BZNicknameOf(playerId));
      m.set("date", finishedAt);
      m.set("map", "?щ궡湲?);
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
    /* ?꾩쟻 湲곕줉 ?ㅽ뙣??移섎챸?곸씠吏 ?딆쓬 */
  }

  battle.set("elo_delta_a", resA.delta);
  battle.set("elo_delta_b", resB.delta);
  battle.set("finished_at", finishedAt);
  // forfeit ?곹깭???좎? (UI/?꾩쟻 援щ텇??
  try {
    $app.save(battle);
  } catch (e) {
    return { ok: false, message: "???????ㅽ뙣" };
  }
  BZLog("settle", "????뺤궛: " + pa + " vs " + pb + " (winner=" + winner + ", ?" + resA.delta + "/" + resB.delta + ")");
  return { ok: true, winner, eloDeltaA: resA.delta, eloDeltaB: resB.delta };
}

// ---------- ?먮룞 寃뚯엫 湲곕줉 ?ㅼ틪 ----------

/**
 * ?뚮젅?댁뼱 1紐낆쓽 理쒓렐 PUBG 留ㅼ튂瑜??ㅼ틪??kill_rounds ??湲곕줉??異붽??쒕떎.
 * - 吏꾪뻾 以?留ㅼ튂(404)  ??pending_verify 湲곕줉 異붽? (?ㅼ쓬 ?깆뿉???ы솗??
 * - 醫낅즺??留ㅼ튂       ??verified 湲곕줉 異붽? (kills_api = ?ㅼ젣 ?ъ닔)
 * - ?대? 湲곕줉??留ㅼ튂   ??嫄대꼫? (以묐났 諛⑹?)
 * - 諛고? ?쒖옉 ?댁쟾 留ㅼ튂 ???ㅼ틪 以묐떒 (留ㅼ튂 紐⑸줉? 理쒖떊??
 * @returns {{rateLimited?: boolean}}
 */
async function BZScanPlayer(battle, playerId) {
  const user = BZFindById("users", playerId);
  if (!user) return { rateLimited: false };
  const nickname = user.getString("pubg_nickname");
  if (!nickname) return { rateLimited: false };

  const pid = await BZResolvePlayerId(nickname);
  if (pid.rateLimited) return { rateLimited: true };
  if (pid.notFound || pid.error) return { rateLimited: false };

  const list = await BZRecentMatches(pid.playerId);
  if (list.rateLimited) return { rateLimited: true };
  if (list.error) return { rateLimited: false };

  // 諛고? ?쒖옉 ?쒓컖 湲곗? (?쒖옉 ?뺤씤 ?꾨즺 ?쒖젏)
  const base = battle.getString("playing_at") || battle.getString("created");
  const baseMs = base ? new Date(base).getTime() : 0;
  const minMs = baseMs ? baseMs - BZ_VERIFY_TOL_MS : 0;

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

  // 援ъ떇(?섎룞) 湲곕줉 ?뺣━: match_id ?녿뒗 playing/pending_verify ??void
  for (const r of existing) {
    const s = r.getString("status");
    if ((s === "playing" || s === "pending_verify") && !r.getString("match_id")) {
      r.set("status", "void");
      r.set("note", "?먮룞 湲곕줉 ?꾪솚?쇰줈 臾댄슚 泥섎━");
      try {
        $app.save(r);
      } catch (e) {
        /* 臾댁떆 */
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

  // 理쒖떊 留ㅼ튂遺???ㅼ틪
  let scanned = 0;
  for (const matchId of list.ids) {
    if (scanned >= BZ_SCAN_MAX_MATCHES) break;
    if (recorded.has(matchId)) continue;
    scanned++;

    const detail = await BZMatchDetail(matchId);
    if (detail.rateLimited) return { rateLimited: true };
    if (detail.error) continue;
    if (detail.ongoing) {
      // 吏꾪뻾 以?留ㅼ튂 ??湲곕줉 異붽? ???ㅼ쓬 ?깆뿉???ы솗??      nextNumber++;
      const nr = new Record($app.findCollectionByNameOrId("kill_rounds"));
      nr.set("battle", battle.id);
      nr.set("player", playerId);
      nr.set("round_number", nextNumber);
      nr.set("status", "pending_verify");
      nr.set("match_id", matchId);
      nr.set("game_started_at", detail.createdAt || "");
      nr.set("verified_at", BZNow());
      nr.set("note", "?먮룞 湲곕줉 (寃뚯엫 吏꾪뻾 以?");
      try {
        $app.save(nr);
      } catch (e) {
        /* 臾댁떆 */
      }
      recorded.add(matchId);
      continue;
    }

    // 醫낅즺??留ㅼ튂: 諛고? ?쒖옉 ?댁쟾(?ㅼ감 ?덉슜) 留ㅼ튂硫??댄썑 紐⑸줉???꾨? ?댁쟾 ??以묐떒
    const createdMs = detail.createdAt ? new Date(detail.createdAt).getTime() : 0;
    if (minMs && createdMs && createdMs < minMs) break;
    if (!createdMs) continue;

    const kills = detail.killsByPlayer ? Number(detail.killsByPlayer[pid.playerId] || 0) : 0;
    nextNumber++;
    const nr = new Record($app.findCollectionByNameOrId("kill_rounds"));
    nr.set("battle", battle.id);
    nr.set("player", playerId);
    nr.set("round_number", nextNumber);
    nr.set("status", "verified");
    nr.set("match_id", matchId);
    nr.set("game_started_at", detail.createdAt);
    nr.set("kills_api", kills);
    nr.set("kills_final", kills);
    nr.set("verified_at", BZNow());
    nr.set("note", "?먮룞 湲곕줉");
    try {
      $app.save(nr);
      BZLog("verify", "?먮룞 湲곕줉 異붽?: " + nickname + " " + kills + "??(match=" + matchId + ") battle=" + battle.id);
    } catch (e) {
      /* 臾댁떆 */
    }
    recorded.add(matchId);
  }

  // pending_verify 湲곕줉 ?ы솗??(留ㅼ튂 醫낅즺 媛먯?)
  for (const r of existing) {
    if (r.getString("status") !== "pending_verify") continue;
    const mid = r.getString("match_id");
    if (!mid) continue;
    const detail = await BZMatchDetail(mid);
    if (detail.rateLimited) return { rateLimited: true };
    if (detail.error || detail.ongoing) continue;

    const createdMs = detail.createdAt ? new Date(detail.createdAt).getTime() : 0;
    if (minMs && createdMs && createdMs < minMs) {
      // 諛고? ?쒖옉 ?댁쟾???쒖옉??留ㅼ튂 ??臾댄슚
      r.set("status", "void");
      r.set("note", "諛고? ?쒖옉 ?댁쟾 留ㅼ튂");
      try {
        $app.save(r);
      } catch (e) {
        /* 臾댁떆 */
      }
      continue;
    }

    const kills = detail.killsByPlayer ? Number(detail.killsByPlayer[pid.playerId] || 0) : 0;
    r.set("status", "verified");
    r.set("kills_api", kills);
    r.set("kills_final", kills);
    r.set("game_started_at", detail.createdAt || r.getString("game_started_at") || "");
    r.set("verified_at", BZNow());
    try {
      $app.save(r);
      BZLog("verify", "留ㅼ튂 醫낅즺 媛먯? ??寃利??뺤젙: " + nickname + " " + kills + "??(match=" + mid + ") battle=" + battle.id);
    } catch (e) {
      /* 臾댁떆 */
    }
  }

  return { rateLimited: false };
}

/** verified 湲곕줉 ?ъ닔 ?⑹궛?쇰줈 諛고? ?ъ닔 ?ш퀎??(硫깅벑) */
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

/** 紐⑺몴 ?ъ닔 ?꾨떖 ???밸━ ?뺤젙 + ?뺤궛 */
function BZCheckWin(battle) {
  if (battle.getString("winner")) return;
  const target = battle.getInt("target_kills") || 5;
  const ka = battle.getInt("kills_a");
  const kb = battle.getInt("kills_b");
  if (ka < target && kb < target) return;

  let winner = null;
  if (ka >= target && kb >= target) {
    // ?숈떆 ?꾨떖(?대줎??: ?ъ닔媛 留롮? 履? 媛숈쑝硫?A
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
  BZLog("verify", "紐⑺몴 ?ъ꽦 ?밸━: " + winner + " (" + ka + " vs " + kb + ") battle=" + battle.id +
    (settled.ok ? "" : " ?뺤궛 蹂대쪟"));
}

/** ???1嫄??ㅼ틪 (?묒そ) */
async function BZScanBattle(battle) {
  // ?덇굅??settling ??? ?뱀옄媛 ?뺤젙???곹깭硫?利됱떆 醫낅즺
  if (battle.getString("status") === "settling" && battle.getString("winner")) {
    battle.set("status", "finished");
    try {
      $app.save(battle);
    } catch (e) {
      /* 臾댁떆 */
    }
    BZDoSettle(battle);
    return { rateLimited: false };
  }
  if (battle.getString("status") !== "playing") return { rateLimited: false };

  const ra = await BZScanPlayer(battle, battle.getString("player_a"));
  if (ra.rateLimited) return { rateLimited: true };
  const rb = await BZScanPlayer(battle, battle.getString("player_b"));
  if (rb.rateLimited) return { rateLimited: true };

  BZRecomputeKills(battle);
  try {
    $app.save(battle);
  } catch (e) {
    /* 臾댁떆 */
  }
  BZCheckWin(battle);
  return { rateLimited: false };
}

/** ?쒖꽦 ????꾩껜 ?먮룞 ?ㅼ틪 (?щ줎?? */
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
      if (res.rateLimited) break;
      scanned++;
    }
    return { ok: true, scanned };
  } finally {
    $app.store().set("bz_scan_busy", false);
  }
}

// ---------- 留ㅼ튂硫붿씠??----------

/**
 * ?湲곗뿴?먯꽌 Elo 李⑥씠 理쒖냼 ?띿쓣 李얠븘 ??꾩쓣 ?앹꽦?쒕떎. (?숆린 ?ㅽ뻾 ???먯옄??
 * @returns {number} ?깆궗??????? */
function BZRunMatchmaking() {
  if ($app.store().get("bz_mm_busy")) return 0;
  $app.store().set("bz_mm_busy", true);
  try {
    const settings = BZSettings();
    if (!settings || settings.getBool("matching_enabled") === false) return 0;
    const season = settings.getString("season") || "?쒖쫵 1";
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
    battle.set("status", "pending");
    battle.set("started_a", false);
    battle.set("started_b", false);
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

    BZLog("match", "留ㅼ묶 ?깆궗: " + best.a.getString("user") + " vs " + best.b.getString("user") +
      " (Elo " + best.a.getInt("elo") + " / " + best.b.getInt("elo") + ")");
    return 1;
  } catch (e) {
    BZLog("match", "留ㅼ묶 ?ㅽ뙣: " + String((e && e.message) || e));
    return 0;
  } finally {
    $app.store().set("bz_mm_busy", false);
  }
}

/** ?湲곗뿴 痍⑥냼 ???湲?pending) ???痍⑥냼 + ?곷? ??蹂듦? */
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
    BZLog("match", "???痍⑥냼(?湲곗뿴 ?댄깉): " + battleId);
  } catch (e) {
    /* 臾댁떆 */
  }
}

// ---------- 紐⑤뱢 ?대낫?닿린 ----------

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
  BZWindowOf: BZWindowOf,
  BZRateUsage: BZRateUsage,
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
  BZRunMatchmaking: BZRunMatchmaking,
  BZHandleQueueCancel: BZHandleQueueCancel,
};

