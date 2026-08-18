// BATTLEZONE 킬내기 - PocketBase 서버 훅 (라우트 + 레코드 훅)
// 주의: PocketBase v0.23+ 는 모든 핸들러를 격리된 컨텍스트로 실행하므로
// 핸들러 밖에서 선언한 변수/함수에는 접근할 수 없다.
// 따라서 모든 헬퍼는 bz-lib.js 모듈에서 핸들러 내부에서 require() 로 로드한다.

// ---------- 훅 ----------

onRecordCreate((e) => {
  const { BZRunMatchmaking } = require(`${__hooks}/bz-lib.js`);
  e.next();
  try {
    if (e.record.collection().name === "kill_queue" && e.record.getString("status") === "waiting") {
      BZRunMatchmaking();
    }
  } catch (err) {
    /* 무시 */
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
    /* 무시 */
  }
});

// ---------- 크론: 활성 대전 자동 스캔 (2분마다) + 주기 정리 ----------

cronAdd("bz-auto-scan", "*/2 * * * *", () => {
  const { BZAutoScanAll, BZMaintenance, BZLog } = require(`${__hooks}/bz-lib.js`);
  try {
    BZMaintenance();
  } catch (err) {
    /* 무시 */
  }
  try {
    const result = BZAutoScanAll();
    if (result && typeof result.then === "function") {
      result.then((r) => {
        if (r && r.busy) BZLog("scan", "이전 스캔이 아직 실행 중입니다.");
        else if (r && r.ok) BZLog("scan", "자동 스캔 완료: " + (r.scanned ?? 0) + "개 대전");
      }).catch((e) => {
        BZLog("scan", "자동 스캔 오류: " + String((e && e.message) || e));
      });
    }
  } catch (err) {
    BZLog("scan", "자동 스캔 오류: " + String((err && err.message) || err));
  }
});

// ---------- 엔드포인트 ----------

// 닉네임 확인 / 키 테스트
routerAdd("POST", "/api/bz/pubg/lookup", async (c) => {
  const { BZAuth, BZBody, BZFindById, BZNow, BZResolvePlayerId, BZ_SHARD, BZ_API } = require(`${__hooks}/bz-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const body = BZBody(c);
  const testMode = body.test === true;
  let key = null;
  if (testMode) {
    if (me.getString("role") !== "operator") {
      return c.json(403, { message: "운영자 전용입니다." });
    }
    key = BZFindById("pubg_keys", String(body.keyId || ""));
    if (!key) return c.json(404, { message: "키를 찾을 수 없습니다." });
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
        return c.json(200, { ok: false, message: "키가 유효하지 않습니다." });
      }
      if (res.statusCode === 200) {
        key.set("last_used_at", BZNow());
        key.set("fail_count", 0);
        $app.save(key);
        return c.json(200, { ok: true, message: "키가 정상 동작합니다." });
      }
      if (res.statusCode === 429) {
        return c.json(200, { ok: false, message: "키 한도 초과(429)" });
      }
      return c.json(200, { ok: false, message: "PUBG API 응답 " + res.statusCode });
    } catch (e) {
      return c.json(200, { ok: false, message: "PUBG API 연결 실패" });
    }
  }

  const nickname = String(body.nickname || "").trim();
  if (!nickname) return c.json(400, { message: "닉네임이 필요합니다." });
  const pid = await BZResolvePlayerId(nickname);
  if (pid.noKeys) return c.json(200, { ok: false, message: "PUBG API 키가 등록되지 않았습니다. 관리자 설정에서 등록해 주세요." });
  if (pid.rateLimited) return c.json(200, { ok: false, message: "PUBG API 호출 한도 초과" });
  if (pid.notFound) return c.json(200, { ok: false, message: "닉네임을 찾을 수 없습니다." });
  if (pid.error) return c.json(200, { ok: false, message: pid.error });
  return c.json(200, { ok: true, nickname, playerId: pid.playerId });
});

// 대전 즉시 스캔 (게임 기록 추가/검증) — 참가자용 "지금 확인" 버튼
routerAdd("POST", "/api/bz/battles/scan", async (c) => {
  const { BZAuth, BZBody, BZFindById, BZSideOf, BZScanBattle } = require(`${__hooks}/bz-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const body = BZBody(c);
  const battle = BZFindById("kill_battles", String(body.battleId || ""));
  if (!battle) return c.json(404, { message: "대전을 찾을 수 없습니다." });
  if (!BZSideOf(battle, me.id)) return c.json(403, { message: "대전 참가자가 아닙니다." });

  const result = await BZScanBattle(battle);
  if (result && result.noKeys) {
    return c.json(200, { ok: false, message: "PUBG API 키가 등록되지 않았거나 비활성 상태입니다. 관리자 설정에서 확인해 주세요." });
  }
  if (result && result.rateLimited) {
    return c.json(200, { ok: false, message: "PUBG API 호출 한도에 도달했습니다. 잠시 후 자동으로 재시도됩니다." });
  }
  if (result && Array.isArray(result.players) && result.players.length) {
    const parts = result.players.map((p) => {
      if (p.skipped) return p.side + ": " + p.skipped;
      const n = (p.added || 0) + (p.confirmed || 0);
      if (n > 0) return p.side + ": " + n + "건 기록";
      let why = "새 기록 없음";
      const mf = p.matchesFound || 0;
      if (mf === 0) why += " (최근 매치 없음)";
      else if (p.oldMatches > 0) why += " (매치 " + mf + "개 중 " + p.oldMatches + "개 대전 시작 이전)";
      else if (p.detailErrors > 0) why += " (상세 조회 실패 " + p.detailErrors + "건)";
      else if (p.noCreatedAt > 0) why += " (시각 정보 없음 " + p.noCreatedAt + "건)";
      return p.side + ": " + why;
    });
    const addedTotal = result.players.reduce((s, p) => s + (p.added || 0) + (p.confirmed || 0), 0);
    const anySkip = result.players.some((p) => p.skipped);
    const message = "게임 기록 확인 (" + parts.join(" · ") + ")";
    if (addedTotal === 0 && anySkip) {
      return c.json(200, { ok: false, message });
    }
    return c.json(200, { ok: true, message });
  }
  return c.json(200, { ok: true, message: "게임 기록을 확인했습니다." });
});

// 정산 (수동 재시도용 — 서버가 자동 정산하므로 보조)
routerAdd("POST", "/api/bz/battles/settle", (c) => {
  const { BZAuth, BZBody, BZFindById, BZSideOf, BZDoSettle } = require(`${__hooks}/bz-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const body = BZBody(c);
  const battle = BZFindById("kill_battles", String(body.battleId || ""));
  if (!battle) return c.json(404, { message: "대전을 찾을 수 없습니다." });
  if (!BZSideOf(battle, me.id)) return c.json(403, { message: "대전 참가자가 아닙니다." });

  const result = BZDoSettle(battle);
  if (!result.ok) return c.json(200, { ok: false, ...result });
  return c.json(200, { ok: true, ...result });
});

// 몰수 승 신고 (상대 게임 시작 미신고)
routerAdd("POST", "/api/bz/battles/forfeit", (c) => {
  const { BZAuth, BZBody, BZFindById, BZSideOf, BZOpponentOf, BZSettings, BZDoSettle } = require(`${__hooks}/bz-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const body = BZBody(c);
  const battle = BZFindById("kill_battles", String(body.battleId || ""));
  if (!battle) return c.json(404, { message: "대전을 찾을 수 없습니다." });
  const side = BZSideOf(battle, me.id);
  if (!side) return c.json(403, { message: "대전 참가자가 아닙니다." });
  const target = String(body.targetPlayerId || "");
  const opp = BZOpponentOf(battle, me.id);
  if (target !== opp) return c.json(400, { message: "상대가 올바르지 않습니다." });

  const settings = BZSettings();
  const timeoutMin = Number(settings.getInt("game_start_timeout_min") || 5);
  const timeoutMs = timeoutMin * 60 * 1000;
  const status = battle.getString("status");

  // 상대가 실제 게임 기록(verified/pending_verify)을 남겼는지 확인
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
      return true; // 확인 불가 시 몰수 불가 (안전)
    }
  };

  if (status === "playing") {
    const base = battle.getString("playing_at");
    if (!base) {
      return c.json(400, { message: "몰수 승 조건이 아닙니다." });
    }
    if (hasOppRecords()) {
      return c.json(400, { message: "상대가 이미 게임을 진행 중입니다. 몰수 승이 불가능합니다." });
    }
    if (Date.now() - new Date(base).getTime() < timeoutMs) {
      return c.json(400, { message: "아직 " + timeoutMin + "분이 경과하지 않았습니다." });
    }
  } else if (status === "pending") {
    const mineStarted = side === "a" ? battle.getBool("started_a") : battle.getBool("started_b");
    const theirStarted = side === "a" ? battle.getBool("started_b") : battle.getBool("started_a");
    const base = battle.getString("created");
    if (!mineStarted || theirStarted || !base) {
      return c.json(400, { message: "상대가 시작 확인을 하지 않았습니다. " + timeoutMin + "분 경과 후 몰수 승이 가능합니다." });
    }
    if (Date.now() - new Date(base).getTime() < timeoutMs) {
      return c.json(400, { message: "아직 " + timeoutMin + "분이 경과하지 않았습니다." });
    }
  } else {
    return c.json(400, { message: "대전이 진행 중이 아닙니다." });
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
    message: "몰수 승 처리되었습니다." + (result.ok ? "" : " (정산 보류)"),
  });
});

// 대전 취소 (대기 상태에서만)
routerAdd("POST", "/api/bz/battles/cancel", (c) => {
  const { BZAuth, BZBody, BZFindById, BZSideOf, BZOpponentOf, BZFirst } = require(`${__hooks}/bz-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const body = BZBody(c);
  const battle = BZFindById("kill_battles", String(body.battleId || ""));
  if (!battle) return c.json(404, { message: "대전을 찾을 수 없습니다." });
  if (!BZSideOf(battle, me.id)) return c.json(403, { message: "대전 참가자가 아닙니다." });
  if (battle.getString("status") !== "pending") {
    return c.json(400, { message: "대기 상태의 대전만 취소할 수 있습니다." });
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
  return c.json(200, { ok: true, message: "대전을 취소했습니다." });
});

// 매칭 수동 트리거 (운영자)
routerAdd("POST", "/api/bz/matchmaking/run", (c) => {
  const { BZAuth, BZRunMatchmaking } = require(`${__hooks}/bz-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });
  const matched = BZRunMatchmaking();
  return c.json(200, { ok: true, matched });
});

// 키별 한도 사용량 (운영자)
routerAdd("GET", "/api/bz/keys/usage", (c) => {
  const { BZAuth, BZRateUsage } = require(`${__hooks}/bz-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });
  if (me.getString("role") !== "operator") return c.json(403, { message: "운영자 전용입니다." });
  return c.json(200, { ok: true, keys: BZRateUsage() });
});