// BATTLEZONE 발로란트 CK - PocketBase 서버 훅 (라우트 + 레코드 훅 + 크론)
// 주의: PocketBase v0.23+ 는 모든 핸들러를 격리된 컨텍스트로 실행하므로
// 핸들러 밖에서 선언한 변수/함수에는 접근할 수 없다.
// 따라서 모든 헬퍼는 bz-ck-lib.js 모듈에서 핸들러 내부에서 require() 로 로드한다.

// ---------- 훅 ----------

onRecordCreate((e) => {
  e.next();
  try {
    if (e.record.collection().name === "bz_ck_queue" && e.record.getString("status") === "waiting") {
      const { CKRunMatchmaking } = require(`${__hooks}/bz-ck-lib.js`);
      CKRunMatchmaking();
    }
  } catch (err) {
    /* 무시 */
  }
});

onRecordUpdate((e) => {
  const { CKHandleQueueCancel } = require(`${__hooks}/bz-ck-lib.js`);
  e.next();
  try {
    if (e.record.collection().name === "bz_ck_queue" && e.record.getString("status") === "cancelled") {
      const bid = e.record.getString("battle_id");
      if (bid) CKHandleQueueCancel(bid, e.record.getString("user"));
    }
  } catch (err) {
    /* 무시 */
  }
});

// ---------- 크론: 매칭 드레인 + settling 검증 재시도 (2분마다) ----------

cronAdd("bz-ck-main", "*/2 * * * *", () => {
  const { CKRunMatchmakingDrain, CKAutoVerifyAll, CKHasEnabledKeys } = require(`${__hooks}/bz-ck-lib.js`);
  const { BZLog } = require(`${__hooks}/bz-lib.js`);
  try {
    const pairs = CKRunMatchmakingDrain();
    if (pairs > 0) BZLog("ck", "자동 매칭 " + pairs + "건");
  } catch (err) {
    /* 무시 */
  }
  try {
    const p = CKAutoVerifyAll();
    if (p && typeof p.then === "function") {
      p.then((r) => {
        if (r && r.busy) BZLog("ck", "이전 검증이 아직 실행 중입니다.");
        else if (r && r.ok) BZLog("ck", "검증 완료: " + (r.verified ?? 0) + "건 확정 / " + (r.mismatched ?? 0) + "건 mismatch");
      }).catch((e) => {
        BZLog("ck", "검증 오류 " + String((e && e.message) || e));
      });
    }
  } catch (err) {
    /* 무시 */
  }
  // 키 미등록 진단용 로그 (1틱당 1회)
  if (!CKHasEnabledKeys()) {
    try {
      BZLog("ck-keys", "발로란트 API 키가 등록되지 않았습니다 (관리자 설정 필요)");
    } catch (err) {
      /* 무시 */
    }
  }
});

// ---------- 엔드포인트 ----------

// Riot ID 등록/검증 (티어 기반 초기 Elo 자동 적용 — 최초 등록 시에만)
routerAdd("POST", "/api/bz/ck/lookup", async (c) => {
  const { BZAuth, BZBody, BZNow, BZLog, BZNicknameOf } = require(`${__hooks}/bz-lib.js`);
  const {
    CKAccount,
    CKMMR,
    CKSettings,
    CKTierKey,
    CKTierElo,
    CKRankingOf,
    CK_DEFAULT_INITIAL_ELO,
  } = require(`${__hooks}/bz-ck-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const body = BZBody(c);
  const riotId = String(body.riotId || body.riot_id || "").trim();
  if (!riotId) return c.json(400, { message: "Riot ID(이름#태그)를 입력해 주세요." });

  const acc = await CKAccount(riotId);
  if (acc.noKeys) {
    return c.json(200, { ok: false, message: "발로란트 API 키가 등록되지 않았습니다. 관리자 설정에서 등록해 주세요." });
  }
  if (acc.rateLimited) return c.json(200, { ok: false, message: "발로란트 API 호출 한도 초과" });
  if (acc.notFound || !acc.ok) return c.json(200, { ok: false, message: acc.error || "계정을 찾을 수 없습니다." });

  const mmr = await CKMMR(acc.puuid, acc.affinity);
  if (mmr.noKeys) {
    return c.json(200, { ok: false, message: "발로란트 API 키가 등록되지 않았습니다. 관리자 설정에서 등록해 주세요." });
  }
  if (mmr.rateLimited) return c.json(200, { ok: false, message: "발로란트 API 호출 한도 초과" });
  if (mmr.error) return c.json(200, { ok: false, message: mmr.error });

  const settings = CKSettings();
  const tierKey = CKTierKey(mmr.tierName);
  const tierElo = CKTierElo(settings, tierKey);
  const ranking = CKRankingOf(me.id);
  let elo = Number(ranking?.getInt("elo") ?? 0) || 0;
  const isFirst = !ranking;

  try {
    me.set("riot_id", acc.name + "#" + acc.tag);
    $app.save(me);
  } catch (e) {
    /* 무시 */
  }

  if (ranking) {
    // 재등록: Riot ID/puuid/티어 정보 갱신하되 Elo 는 유지 (초기화 조작 방지)
    ranking.set("nickname", BZNicknameOf(me.id));
    ranking.set("riot_id", acc.name + "#" + acc.tag);
    ranking.set("puuid", acc.puuid);
    ranking.set("affinity", acc.affinity);
    ranking.set("tier", mmr.tier || 0);
    ranking.set("tier_name", tierKey);
    try {
      $app.save(ranking);
    } catch (e) {
      /* 무시 */
    }
    elo = Number(ranking.getInt("elo") || 0);
  } else {
    const { CKEnsureRanking } = require(`${__hooks}/bz-ck-lib.js`);
    const rec = CKEnsureRanking(me.id, tierElo);
    rec.set("riot_id", acc.name + "#" + acc.tag);
    rec.set("puuid", acc.puuid);
    rec.set("affinity", acc.affinity);
    rec.set("tier", mmr.tier || 0);
    rec.set("tier_name", tierKey);
    try {
      $app.save(rec);
    } catch (e) {
      /* 무시 */
    }
    elo = tierElo;
  }

  BZLog("ck-lookup", "Riot ID 등록: " + me.id + " → " + acc.name + "#" + acc.tag +
    " (tier=" + (mmr.tierName || "언랭") + ", elo=" + (isFirst ? tierElo : elo) + (isFirst ? ", 최초 적용" : ", 유지") + ")");
  return c.json(200, {
    ok: true,
    riotId: acc.name + "#" + acc.tag,
    puuid: acc.puuid,
    affinity: acc.affinity,
    tier: mmr.tier || 0,
    tierName: tierKey,
    elo,
    initialEloApplied: isFirst,
  });
});

// 대기열 입장 (Riot ID 등록 필수)
routerAdd("POST", "/api/bz/ck/queue/enter", (c) => {
  const { BZAuth, BZBody, BZNow } = require(`${__hooks}/bz-lib.js`);
  const { CKSettings, CKRankingOf } = require(`${__hooks}/bz-ck-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const ranking = CKRankingOf(me.id);
  if (!ranking || !ranking.getString("puuid")) {
    return c.json(400, { message: "먼저 Riot ID를 등록해 주세요." });
  }
  const settings = CKSettings();
  if (!settings) return c.json(400, { message: "게임 설정을 찾을 수 없습니다." });
  const season = settings.season;

  try {
    const existing = $app.findFirstRecordByFilter(
      "bz_ck_queue",
      "user = {:u} && season = {:s} && status != 'cancelled'",
      { u: me.id, s: season }
    );
    if (existing) {
      return c.json(400, { message: existing.getString("status") === "matched" ? "이미 매칭된 대전이 있습니다." : "이미 매칭 대기 중입니다." });
    }
  } catch (e) {
    /* 무시 */
  }

  const elo = Number(ranking.getInt("elo") || 0);
  const rec = new Record($app.findCollectionByNameOrId("bz_ck_queue"));
  rec.set("user", me.id);
  rec.set("elo", elo);
  rec.set("status", "waiting");
  rec.set("season", season);
  rec.set("queued_at", BZNow());
  try {
    $app.save(rec);
  } catch (e) {
    return c.json(400, { message: "대기열 등록 실패: " + String((e && e.message) || e) });
  }
  // onRecordCreate 훅이 즉시 매칭을 시도한다.
  return c.json(200, { ok: true, queueId: rec.id, message: "매칭 대기열에 등록했습니다." });
});

// 대기열 취소 (참가자 본인만) — 상태 변경은 이 라우트로만 가능
routerAdd("POST", "/api/bz/ck/queue/cancel", (c) => {
  const { BZAuth, BZBody, BZFindById } = require(`${__hooks}/bz-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const body = BZBody(c);
  const queue = BZFindById("bz_ck_queue", String(body.queueId || ""));
  if (!queue) return c.json(404, { message: "대기열을 찾을 수 없습니다." });
  if (queue.getString("user") !== me.id) return c.json(403, { message: "본인의 대기열만 취소할 수 있습니다." });

  queue.set("status", "cancelled");
  try {
    // onRecordUpdate 훅 → CKHandleQueueCancel (대기 대전 취소 + 나머지 큐 복구)
    $app.save(queue);
  } catch (e) {
    return c.json(400, { message: "대기열 취소 실패: " + String((e && e.message) || e) });
  }
  return c.json(200, { ok: true, message: "대기열에서 나갔습니다." });
});

// 시작 확인 (팀 단위)
routerAdd("POST", "/api/bz/ck/battles/confirm-start", (c) => {
  const { BZAuth, BZBody, BZFindById } = require(`${__hooks}/bz-lib.js`);
  const { CKConfirmStart } = require(`${__hooks}/bz-ck-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const body = BZBody(c);
  const battle = BZFindById("bz_ck_battles", String(body.battleId || ""));
  if (!battle) return c.json(404, { message: "대전을 찾을 수 없습니다." });

  const result = CKConfirmStart(battle, me.id);
  return c.json(result.ok ? 200 : 400, result);
});

// 경기 종료 신고 (한 팀만 해도 검증 시작 — 스코어는 제출하지 않음)
routerAdd("POST", "/api/bz/ck/battles/report", async (c) => {
  const { BZAuth, BZBody, BZFindById } = require(`${__hooks}/bz-lib.js`);
  const { CKReportEnd, CKVerifyBattle } = require(`${__hooks}/bz-ck-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const body = BZBody(c);
  const battle = BZFindById("bz_ck_battles", String(body.battleId || ""));
  if (!battle) return c.json(404, { message: "대전을 찾을 수 없습니다." });

  const report = CKReportEnd(battle, me.id);
  if (!report.ok) return c.json(400, report);

  const verify = await CKVerifyBattle(battle);
  return c.json(200, {
    ok: true,
    settling: true,
    verified: Boolean(verify.found),
    message: report.message + (verify.found ? " " + verify.message : ""),
  });
});

// 몰수 승 신고 (상대 팀이 타임아웃 내 시작 확인을 하지 않은 경우)
routerAdd("POST", "/api/bz/ck/battles/forfeit", (c) => {
  const { BZAuth, BZBody, BZFindById, BZNow } = require(`${__hooks}/bz-lib.js`);
  const { CKSettings, CKTeamOf, CKDoSettle } = require(`${__hooks}/bz-ck-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const body = BZBody(c);
  const battle = BZFindById("bz_ck_battles", String(body.battleId || ""));
  if (!battle) return c.json(404, { message: "대전을 찾을 수 없습니다." });
  const side = CKTeamOf(battle, me.id);
  if (!side) return c.json(403, { message: "대전 참가자가 아닙니다." });
  if (battle.getString("status") !== "pending") {
    return c.json(400, { message: "대기 상태의 대전만 몰수 승 신고가 가능합니다." });
  }
  const myReady = side === "a" ? battle.getBool("team_a_ready") : battle.getBool("team_b_ready");
  const theirReady = side === "a" ? battle.getBool("team_b_ready") : battle.getBool("team_a_ready");
  if (!myReady) return c.json(400, { message: "먼저 팀 시작 확인을 해주세요." });
  if (theirReady) return c.json(400, { message: "상대 팀이 이미 시작 확인했습니다." });

  const settings = CKSettings();
  const timeoutMin = settings ? settings.timeout_min : 5;
  const createdMs = new Date(battle.getString("created") || "").getTime();
  if (!createdMs || Date.now() - createdMs < timeoutMin * 60 * 1000) {
    return c.json(400, { message: "아직 " + timeoutMin + "분이 경과하지 않았습니다. 상대 팀의 시작 확인을 기다려 주세요." });
  }

  battle.set("winner", side);
  battle.set("score_a", side === "a" ? 1 : 0);
  battle.set("score_b", side === "b" ? 1 : 0);
  battle.set("status", "forfeit");
  $app.save(battle);
  const result = CKDoSettle(battle);
  return c.json(200, {
    ok: true,
    winner: side,
    battleStatus: "forfeit",
    message: "몰수 승 처리되었습니다." + (result.ok ? "" : " (정산 보류)"),
  });
});

// 대전 취소 (대기 상태에서만, 참가자)
routerAdd("POST", "/api/bz/ck/battles/cancel", (c) => {
  const { BZAuth, BZBody, BZFindById } = require(`${__hooks}/bz-lib.js`);
  const { CKTeamOf, CKAllUserIds } = require(`${__hooks}/bz-ck-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const body = BZBody(c);
  const battle = BZFindById("bz_ck_battles", String(body.battleId || ""));
  if (!battle) return c.json(404, { message: "대전을 찾을 수 없습니다." });
  if (!CKTeamOf(battle, me.id)) return c.json(403, { message: "대전 참가자가 아닙니다." });
  if (battle.getString("status") !== "pending") {
    return c.json(400, { message: "대기 상태의 대전만 취소할 수 있습니다." });
  }

  battle.set("status", "cancelled");
  $app.save(battle);
  for (const uid of CKAllUserIds(battle)) {
    const q = $app.findFirstRecordByFilter("bz_ck_queue", "battle_id = {:b} && user = {:u} && status = 'matched'", {
      b: battle.id,
      u: uid,
    });
    if (q) {
      q.set("status", "waiting");
      q.set("battle_id", "");
      $app.save(q);
    }
  }
  return c.json(200, { ok: true, message: "대전을 취소했습니다." });
});

// 정산 수동 재시도 (참가자/운영자 — 서버가 자동 정산하므로 보조)
routerAdd("POST", "/api/bz/ck/battles/settle", (c) => {
  const { BZAuth, BZBody, BZFindById } = require(`${__hooks}/bz-lib.js`);
  const { CKTeamOf, CKDoSettle } = require(`${__hooks}/bz-ck-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const body = BZBody(c);
  const battle = BZFindById("bz_ck_battles", String(body.battleId || ""));
  if (!battle) return c.json(404, { message: "대전을 찾을 수 없습니다." });
  if (me.getString("role") !== "operator" && !CKTeamOf(battle, me.id)) {
    return c.json(403, { message: "대전 참가자가 아닙니다." });
  }

  const result = CKDoSettle(battle);
  if (!result.ok) return c.json(200, { ok: false, ...result });
  return c.json(200, { ok: true, ...result });
});

// 발로란트 API 키 동작 테스트 (운영자)
routerAdd("POST", "/api/bz/ck/keys/test", async (c) => {
  const { BZAuth, BZBody, BZFindById, BZNow } = require(`${__hooks}/bz-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });
  if (me.getString("role") !== "operator") return c.json(403, { message: "운영자 전용입니다." });

  const body = BZBody(c);
  const key = BZFindById("bz_valorant_keys", String(body.keyId || ""));
  if (!key) return c.json(404, { message: "키를 찾을 수 없습니다." });

  try {
    // /valorant/v1/status/{affinity} 는 키 유효성 판정에 충분하다 (v4 부터 전체 엔드포인트 키 필수)
    const res = await $http.send({
      url: "https://api.henrikdev.xyz/valorant/v1/status/ap?api_key=" + encodeURIComponent(key.getString("key")),
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "BattleZone-App/1.0 (battlezoneapp.kro.kr)",
      },
      timeout: 15000,
    });
    if (res.statusCode === 401 || res.statusCode === 403) {
      return c.json(200, { ok: false, message: "키가 유효하지 않습니다. (" + res.statusCode + ")" });
    }
    if (res.statusCode === 429) {
      return c.json(200, { ok: false, message: "키 한도 초과(429)" });
    }
    if (res.statusCode === 200) {
      key.set("last_used_at", BZNow());
      key.set("fail_count", 0);
      $app.save(key);
      return c.json(200, { ok: true, message: "키가 정상 동작합니다." });
    }
    return c.json(200, { ok: false, message: "HenrikDev API 응답 " + res.statusCode });
  } catch (e) {
    return c.json(200, { ok: false, message: "HenrikDev API 연결 실패" });
  }
});

// 키별 한도 사용량 (운영자)
routerAdd("GET", "/api/bz/ck/keys/usage", (c) => {
  const { BZAuth } = require(`${__hooks}/bz-lib.js`);
  const { CKRateUsage } = require(`${__hooks}/bz-ck-lib.js`);
  const me = BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });
  if (me.getString("role") !== "operator") return c.json(403, { message: "운영자 전용입니다." });
  return c.json(200, { ok: true, keys: CKRateUsage() });
});