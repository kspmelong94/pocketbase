// BATTLEZONE ?щ궡湲?- PocketBase ?쒕쾭 ??(?쇱슦??+ ?덉퐫????
// 二쇱쓽: PocketBase v0.23+ ??紐⑤뱺 ?몃뱾?щ? 寃⑸━??而⑦뀓?ㅽ듃濡??ㅽ뻾?섎?濡?// ?몃뱾??諛뽰뿉???좎뼵??蹂???⑥닔?먮뒗 ?묎렐?????녿떎.
// ?곕씪??紐⑤뱺 ?ы띁??bz-lib.js 紐⑤뱢?먯꽌 ?몃뱾???대??먯꽌 require() 濡?濡쒕뱶?쒕떎.

// ---------- ??----------

onRecordCreate((e) => {
  const { BZRunMatchmaking } = require(`${__hooks}/bz-lib.js`);
  e.next();
  try {
    if (e.record.collection().name === "kill_queue" && e.record.getString("status") === "waiting") {
      BZRunMatchmaking();
    }
  } catch (err) {
    /* 臾댁떆 */
  }
});

onRecordUpdate((e) => {
  const { BZHandleQueueCancel } = require(`${__hooks}/bz-lib.js`);
  e.next();
  try {
    if (e.record.collection().name === "kill_queue" && e.record.getString("status") === "cancelled") {
      const bid = e.record.getString("battle_id");
      if (bid) BZHandleQueueCancel(bid, e.record.getString("user"));
    }
  } catch (err) {
    /* 臾댁떆 */
  }
});

// ---------- ?щ줎: ?쒖꽦 ????먮룞 ?ㅼ틪 (2遺꾨쭏?? ----------

cronAdd("bz-auto-scan", "*/2 * * * *", () => {
  const { BZAutoScanAll, BZLog } = require(`${__hooks}/bz-lib.js`);
  try {
    const result = BZAutoScanAll();
    if (result && typeof result.then === "function") {
      result.then((r) => {
        if (r && r.busy) BZLog("scan", "?댁쟾 ?ㅼ틪???꾩쭅 ?ㅽ뻾 以묒엯?덈떎.");
        else if (r && r.ok) BZLog("scan", "?먮룞 ?ㅼ틪 ?꾨즺: " + (r.scanned ?? 0) + "媛????);
      }).catch((e) => {
        BZLog("scan", "?먮룞 ?ㅼ틪 ?ㅻ쪟: " + String((e && e.message) || e));
      });
    }
  } catch (err) {
    BZLog("scan", "?먮룞 ?ㅼ틪 ?ㅻ쪟: " + String((err && err.message) || err));
  }
});

// ---------- ?붾뱶?ъ씤??----------

// ?됰꽕???뺤씤 / ???뚯뒪??routerAdd("POST", "/api/bz/pubg/lookup", async (c) => {
  const { BZAuth, BZBody, BZFindById, BZNow, BZResolvePlayerId, BZ_SHARD, BZ_API } = require(`${__hooks}/bz-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "?몄쬆???꾩슂?⑸땲??" });

  const body = BZBody(c);
  const testMode = body.test === true;
  let key = null;
  if (testMode) {
    if (me.getString("role") !== "operator") {
      return c.json(403, { message: "?댁쁺???꾩슜?낅땲??" });
    }
    key = BZFindById("pubg_keys", String(body.keyId || ""));
    if (!key) return c.json(404, { message: "?ㅻ? 李얠쓣 ???놁뒿?덈떎." });
  }

  if (testMode && key) {
    try {
      const res = await $http.send({
        url: BZ_API + "/shards/" + BZ_SHARD + "/players?filter%5BplayerNames%5D=BZONE_TEST",
        method: "GET",
        headers: { Authorization: "Bearer " + key.getString("key"), Accept: "application/vnd.api+json" },
        timeout: 15000,
      });
      if (res.statusCode === 401 || res.statusCode === 403) {
        return c.json(200, { ok: false, message: "?ㅺ? ?좏슚?섏? ?딆뒿?덈떎." });
      }
      if (res.statusCode === 200) {
        key.set("last_used_at", BZNow());
        key.set("fail_count", 0);
        $app.save(key);
        return c.json(200, { ok: true, message: "?ㅺ? ?뺤긽 ?숈옉?⑸땲??" });
      }
      if (res.statusCode === 429) {
        return c.json(200, { ok: false, message: "???쒕룄 珥덇낵(429)" });
      }
      return c.json(200, { ok: false, message: "PUBG API ?묐떟 " + res.statusCode });
    } catch (e) {
      return c.json(200, { ok: false, message: "PUBG API ?곌껐 ?ㅽ뙣" });
    }
  }

  const nickname = String(body.nickname || "").trim();
  if (!nickname) return c.json(400, { message: "?됰꽕?꾩씠 ?꾩슂?⑸땲??" });
  const pid = await BZResolvePlayerId(nickname);
  if (pid.rateLimited) return c.json(200, { ok: false, message: "PUBG API ?몄텧 ?쒕룄 珥덇낵" });
  if (pid.notFound) return c.json(200, { ok: false, message: "?됰꽕?꾩쓣 李얠쓣 ???놁뒿?덈떎." });
  if (pid.error) return c.json(200, { ok: false, message: pid.error });
  return c.json(200, { ok: true, nickname, playerId: pid.playerId });
});

// ???利됱떆 ?ㅼ틪 (寃뚯엫 湲곕줉 異붽?/寃利? ??李멸??먯슜 "吏湲??뺤씤" 踰꾪듉
routerAdd("POST", "/api/bz/battles/scan", async (c) => {
  const { BZAuth, BZBody, BZFindById, BZSideOf, BZScanBattle } = require(`${__hooks}/bz-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "?몄쬆???꾩슂?⑸땲??" });

  const body = BZBody(c);
  const battle = BZFindById("kill_battles", String(body.battleId || ""));
  if (!battle) return c.json(404, { message: "??꾩쓣 李얠쓣 ???놁뒿?덈떎." });
  if (!BZSideOf(battle, me.id)) return c.json(403, { message: "???李멸??먭? ?꾨떃?덈떎." });

  const result = await BZScanBattle(battle);
  if (result && result.rateLimited) {
    return c.json(200, { ok: false, message: "PUBG API ?몄텧 ?쒕룄???꾨떖?덉뒿?덈떎. ?좎떆 ???먮룞?쇰줈 ?ъ떆?꾨맗?덈떎." });
  }
  return c.json(200, { ok: true, message: "寃뚯엫 湲곕줉???뺤씤?덉뒿?덈떎." });
});

// ?뺤궛 (?섎룞 ?ъ떆?꾩슜 ???쒕쾭媛 ?먮룞 ?뺤궛?섎?濡?蹂댁“)
routerAdd("POST", "/api/bz/battles/settle", (c) => {
  const { BZAuth, BZBody, BZFindById, BZSideOf, BZDoSettle } = require(`${__hooks}/bz-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "?몄쬆???꾩슂?⑸땲??" });

  const body = BZBody(c);
  const battle = BZFindById("kill_battles", String(body.battleId || ""));
  if (!battle) return c.json(404, { message: "??꾩쓣 李얠쓣 ???놁뒿?덈떎." });
  if (!BZSideOf(battle, me.id)) return c.json(403, { message: "???李멸??먭? ?꾨떃?덈떎." });

  const result = BZDoSettle(battle);
  if (!result.ok) return c.json(200, { ok: false, ...result });
  return c.json(200, { ok: true, ...result });
});

// 紐곗닔 ???좉퀬 (?곷? 寃뚯엫 ?쒖옉 誘몄떊怨?
routerAdd("POST", "/api/bz/battles/forfeit", (c) => {
  const { BZAuth, BZBody, BZFindById, BZSideOf, BZOpponentOf, BZSettings, BZDoSettle } = require(`${__hooks}/bz-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "?몄쬆???꾩슂?⑸땲??" });

  const body = BZBody(c);
  const battle = BZFindById("kill_battles", String(body.battleId || ""));
  if (!battle) return c.json(404, { message: "??꾩쓣 李얠쓣 ???놁뒿?덈떎." });
  const side = BZSideOf(battle, me.id);
  if (!side) return c.json(403, { message: "???李멸??먭? ?꾨떃?덈떎." });
  const target = String(body.targetPlayerId || "");
  const opp = BZOpponentOf(battle, me.id);
  if (target !== opp) return c.json(400, { message: "?곷?媛 ?щ컮瑜댁? ?딆뒿?덈떎." });

  const settings = BZSettings();
  const timeoutMin = Number(settings.getInt("game_start_timeout_min") || 5);
  const timeoutMs = timeoutMin * 60 * 1000;
  const status = battle.getString("status");

  // ?곷?媛 ?ㅼ젣 寃뚯엫 湲곕줉(verified/pending_verify)???④꼈?붿? ?뺤씤
  const hasOppRecords = () => {
    try {
      const recs = $app.findRecordsByFilter(
        "kill_rounds",
        "battle = {:b} && player = {:p}",
        "created",
        50,
        0,
        { b: battle.id, p: opp }
      );
      return recs.some((r) => {
        const s = r.getString("status");
        return s === "verified" || s === "pending_verify";
      });
    } catch (e) {
      return true; // ?뺤씤 遺덇? ??紐곗닔 遺덇? (?덉쟾)
    }
  };

  if (status === "playing") {
    const base = battle.getString("playing_at");
    if (!base) {
      return c.json(400, { message: "紐곗닔 ??議곌굔???꾨떃?덈떎." });
    }
    if (hasOppRecords()) {
      return c.json(400, { message: "?곷?媛 ?대? 寃뚯엫??吏꾪뻾 以묒엯?덈떎. 紐곗닔 ?뱀씠 遺덇??ν빀?덈떎." });
    }
    if (Date.now() - new Date(base).getTime() < timeoutMs) {
      return c.json(400, { message: "?꾩쭅 " + timeoutMin + "遺꾩씠 寃쎄낵?섏? ?딆븯?듬땲??" });
    }
  } else if (status === "pending") {
    const mineStarted = side === "a" ? battle.getBool("started_a") : battle.getBool("started_b");
    const theirStarted = side === "a" ? battle.getBool("started_b") : battle.getBool("started_a");
    const base = battle.getString("created");
    if (!mineStarted || theirStarted || !base) {
      return c.json(400, { message: "?곷?媛 ?쒖옉 ?뺤씤???섏? ?딆븯?듬땲?? " + timeoutMin + "遺?寃쎄낵 ??紐곗닔 ?뱀씠 媛?ν빀?덈떎." });
    }
    if (Date.now() - new Date(base).getTime() < timeoutMs) {
      return c.json(400, { message: "?꾩쭅 " + timeoutMin + "遺꾩씠 寃쎄낵?섏? ?딆븯?듬땲??" });
    }
  } else {
    return c.json(400, { message: "??꾩씠 吏꾪뻾 以묒씠 ?꾨떃?덈떎." });
  }

  battle.set("winner", me.id);
  battle.set("winner_pending", "");
  battle.set("status", "forfeit");
  $app.save(battle);
  const result = BZDoSettle(battle);
  return c.json(200, {
    ok: true,
    winner: me.id,
    battleStatus: "forfeit",
    message: "紐곗닔 ??泥섎━?섏뿀?듬땲??" + (result.ok ? "" : " (?뺤궛 蹂대쪟)"),
  });
});

// ???痍⑥냼 (?湲??곹깭?먯꽌留?
routerAdd("POST", "/api/bz/battles/cancel", (c) => {
  const { BZAuth, BZBody, BZFindById, BZSideOf, BZOpponentOf, BZFirst } = require(`${__hooks}/bz-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "?몄쬆???꾩슂?⑸땲??" });

  const body = BZBody(c);
  const battle = BZFindById("kill_battles", String(body.battleId || ""));
  if (!battle) return c.json(404, { message: "??꾩쓣 李얠쓣 ???놁뒿?덈떎." });
  if (!BZSideOf(battle, me.id)) return c.json(403, { message: "???李멸??먭? ?꾨떃?덈떎." });
  if (battle.getString("status") !== "pending") {
    return c.json(400, { message: "?湲??곹깭????꾨쭔 痍⑥냼?????덉뒿?덈떎." });
  }

  battle.set("status", "cancelled");
  $app.save(battle);
  const opp = BZOpponentOf(battle, me.id);
  if (opp) {
    const oppQueue = BZFirst("kill_queue", "battle_id = {:b} && user = {:u} && status = 'matched'", {
      b: battle.id,
      u: opp,
    });
    if (oppQueue) {
      oppQueue.set("status", "waiting");
      oppQueue.set("battle_id", "");
      $app.save(oppQueue);
    }
  }
  return c.json(200, { ok: true, message: "??꾩쓣 痍⑥냼?덉뒿?덈떎." });
});

// 留ㅼ묶 ?섎룞 ?몃━嫄?(?댁쁺??
routerAdd("POST", "/api/bz/matchmaking/run", (c) => {
  const { BZAuth, BZRunMatchmaking } = require(`${__hooks}/bz-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "?몄쬆???꾩슂?⑸땲??" });
  const matched = BZRunMatchmaking();
  return c.json(200, { ok: true, matched });
});

// ?ㅻ퀎 ?쒕룄 ?ъ슜??(?댁쁺??
routerAdd("GET", "/api/bz/keys/usage", (c) => {
  const { BZAuth, BZRateUsage } = require(`${__hooks}/bz-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "?몄쬆???꾩슂?⑸땲??" });
  if (me.getString("role") !== "operator") return c.json(403, { message: "?댁쁺???꾩슜?낅땲??" });
  return c.json(200, { ok: true, keys: BZRateUsage() });
});

