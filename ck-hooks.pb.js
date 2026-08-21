// CK PocketBase 메인 훅
// 라우트 + 레코드 훅 + 크론 등록

// ---------- 레코드 훅 ----------

// 큐 진입 시 즉시 매칭 시도
onRecordCreate((e) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  e.next();
  try {
    const colName = e.record.collection().name;
    if (colName === "match_queue" && e.record.getString("status") === "waiting") {
      const pairs = L.CKRunMatchmaking();
      if (pairs > 0) console.log("[ck] 큐 진입 훅: 매칭 " + pairs + "건 성사");
    }
  } catch (err) {
    console.log("[ck] onRecordCreate 오류: " + String(err));
  }
});

// 큐 취소 시 matched 방 정리 + 나머지 복구
onRecordUpdate((e) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  e.next();
  try {
    const colName = e.record.collection().name;
    if (colName === "match_queue" && e.record.getString("status") === "cancelled") {
      const bid = e.record.getString("battle_id");
      if (bid) L.CKHandleQueueCancel(bid, e.record.getString("user"));
    }
  } catch (err) {
    console.log("[ck] onRecordUpdate 오류: " + String(err));
  }
});

// ---------- 큐 취소 헬퍼: ck-matchmaking.js 의 CKHandleQueueCancel 사용 ----------

// ---------- 크론 ----------

// 매칭 드레인 (1분마다)
cronAdd("ck-matchmaking-drain", "* * * * *", () => {
const L = require(`${__hooks}/ck-lib-all.js`);
  try {
    const pairs = L.CKRunMatchmakingDrain();
    if (pairs > 0) L.BZLog("ck", "자동 매칭 " + pairs + "건");
  } catch (err) {
    L.BZLog("ck", "매칭 드레인 오류 " + String(err));
  }
});

// 자동 검증 (2분마다)
cronAdd("ck-auto-verify", "*/2 * * * *", async () => {
const L = require(`${__hooks}/ck-lib-all.js`);
  try {
    const result = await L.CKAutoVerifyAll();
    if (result && typeof result.then === "function") {
      result.then((r) => {
        if (r && r.busy) L.BZLog("ck", "이전 검증이 아직 실행 중입니다.");
        else if (r && r.ok) L.BZLog("ck", "검증 완료: " + (r.verified ?? 0) + "건 확정 / " + (r.mismatched ?? 0) + "건 mismatch / " + (r.errors ?? 0) + "건 오류");
      }).catch((e) => {
        L.BZLog("ck", "검증 오류 " + String(e));
      });
    } else if (result && result.ok) {
      L.BZLog("ck", "검증 완료: " + (result.verified ?? 0) + "건 확정 / " + (result.mismatched ?? 0) + "건 mismatch / " + (result.errors ?? 0) + "건 오류");
    }
  } catch (err) {
    L.BZLog("ck", "자동 검증 크론 오류 " + String(err));
  }
});

// 페널티 만료 해제 (시간마다)
cronAdd("ck-penalty-decay", "0 * * * *", () => {
const L = require(`${__hooks}/ck-lib-all.js`);
  try {
    const count = L.CKDecayPenalties();
    if (count > 0) L.BZLog("ck", "페널티 만료 해제 " + count + "건");
  } catch (err) {
    L.BZLog("ck", "페널티 만료 크론 오류 " + String(err));
  }
});

// 매너 점수 자연 회복 (매일 자정)
cronAdd("ck-manner-decay", "0 0 * * *", () => {
const L = require(`${__hooks}/ck-lib-all.js`);
  try {
    const count = L.CKDecayMannerScores();
    if (count > 0) L.BZLog("ck", "매너 점수 회복 " + count + "명");
  } catch (err) {
    L.BZLog("ck", "매너 회복 크론 오류 " + String(err));
  }
});

// 키 미등록 진단 로그 (10분마다)
cronAdd("ck-keys-check", "*/10 * * * *", () => {
const L = require(`${__hooks}/ck-lib-all.js`);
  if (!L.CKHasEnabledKeys()) {
    try {
      L.BZLog("ck-keys", "발로란트 API 키가 등록되지 않았습니다 (관리자 설정 필요)");
    } catch (err) {
      /* 무시 */
    }
  }
});

// ---------- API 라우트 ----------

// Riot ID 등록/검증 (최초 등록 시 ELO 1000 부여)
routerAdd("POST", "/api/ck/lookup", async (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const body = L.BZBody(c);
  const riotId = String(body.riotId || body.riot_id || "").trim();
  if (!riotId) return c.json(400, { message: "Riot ID(이름#태그)를 입력해 주세요." });

  const acc = await L.CKAccount(riotId);
  if (acc.noKeys) {
    return c.json(200, { ok: false, message: "발로란트 API 키가 등록되지 않았습니다. 관리자 설정에서 등록해 주세요." });
  }
  if (acc.rateLimited) return c.json(200, { ok: false, message: "발로란트 API 호출 한도 초과" });
  if (!acc.ok) return c.json(200, { ok: false, message: acc.error || "계정을 찾을 수 없습니다." });

  const mmr = await L.CKMMR(acc.puuid, acc.affinity);
  if (mmr.noKeys) {
    return c.json(200, { ok: false, message: "발로란트 API 키가 등록되지 않았습니다." });
  }
  if (mmr.rateLimited) return c.json(200, { ok: false, message: "발로란트 API 호출 한도 초과" });
  if (mmr.error) return c.json(200, { ok: false, message: mmr.error });

  const settings = L.CKGetSettings();
  const tierKey = mmr.tierName;
  const tierElo = settings ? (L.CKTierElo(settings, tierKey) ?? null) : null;
  const initialElo = tierElo || Number(settings?.getInt("ck_initial_elo")) || 1000;

  const ranking = L.CKRankingOf(me.id);
  let elo = 0;
  let isFirst = false;

  try {
    me.set("riot_id", acc.name + "#" + acc.tag);
    $app.save(me);
  } catch (e) {
    /* 무시 */
  }

  if (ranking) {
    // 재등록: 정보 갱신하되 Elo 유지
    ranking.set("nickname", L.BZNicknameOf(me.id));
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
    // 최초 등록
    const rec = L.CKEnsureRanking(me.id, initialElo);
    rec.set("nickname", L.BZNicknameOf(me.id));
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
    elo = initialElo;
    isFirst = true;
  }

  L.BZLog("ck-lookup", "Riot ID 등록: " + me.id + " → " + acc.name + "#" + acc.tag +
    " (tier=" + (mmr.tierName || "언랭") + ", elo=" + elo + (isFirst ? ", 최초 적용" : ", 유지") + ")");

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

// 대기열 진입
routerAdd("POST", "/api/ck/queue/enter", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  // 페널티 체크
  const penaltyCheck = L.CKCheckPenalty(me.id);
  if (penaltyCheck.blocked) {
    return c.json(400, { message: penaltyCheck.message });
  }

  const ranking = L.CKRankingOf(me.id);
  if (!ranking || !ranking.getString("puuid")) {
    return c.json(400, { message: "먼저 Riot ID를 등록해 주세요." });
  }

  const settings = L.CKGetSettings();
  if (!settings) return c.json(400, { message: "게임 설정을 찾을 수 없습니다." });
  const season = L.CKGetCurrentSeason();

  // 중복 체크
  try {
    const existing = $app.findFirstRecordByFilter(
      "match_queue",
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
  const col = $app.findCollectionByNameOrId("match_queue");
  const rec = new Record(col);
  rec.set("user", me.id);
  rec.set("elo", elo);
  rec.set("status", "waiting");
  rec.set("season", season);
  rec.set("queued_at", L.CKNow());
  try {
    $app.save(rec);
  } catch (e) {
    return c.json(400, { message: "대기열 등록 실패: " + String(e) });
  }
  // onRecordCreate 훅이 즉시 매칭 시도
  return c.json(200, { ok: true, queueId: rec.id, message: "매칭 대기열에 등록했습니다." });
});

// 대기열 취소 (본인만)
routerAdd("POST", "/api/ck/queue/cancel", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const body = L.BZBody(c);
  const queue = L.BZFindById("match_queue", String(body.queueId || ""));
  if (!queue) return c.json(404, { message: "대기열을 찾을 수 없습니다." });
  if (queue.getString("user") !== me.id) return c.json(403, { message: "본인의 대기열만 취소할 수 있습니다." });

  queue.set("status", "cancelled");
  try {
    // onRecordUpdate 훅 → L.CKHandleQueueCancel
    $app.save(queue);
  } catch (e) {
    return c.json(400, { message: "대기열 취소 실패: " + String(e) });
  }
  return c.json(200, { ok: true, message: "대기열에서 나갔습니다." });
});

// 대기열 상태 조회
routerAdd("GET", "/api/ck/queue/status", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const settings = L.CKGetSettings();
  if (!settings) return c.json(400, { message: "게임 설정을 찾을 수 없습니다." });
  const season = L.CKGetCurrentSeason();

  try {
    const myQueue = $app.findFirstRecordByFilter(
      "match_queue",
      "user = {:u} && season = {:s} && status != 'cancelled'",
      { u: me.id, s: season }
    );

    const waitingRecords = $app.findRecordsByFilter(
      "match_queue",
      "status = 'waiting' && season = {:s}",
      "-id",
      500,
      0,
      { s: season }
    );
    const waitingCount = waitingRecords.length;

    return c.json(200, {
      ok: true,
      queue: myQueue ? {
        id: myQueue.id,
        status: myQueue.getString("status"),
        elo: myQueue.getInt("elo"),
        queued_at: myQueue.getString("queued_at"),
      } : null,
      waitingCount,
      estimatedWaitSec: Math.max(0, (waitingCount - 10) * 30), // 대략적 추정
    });
  } catch (e) {
    return c.json(400, { message: "조회 실패: " + String(e) });
  }
});

// 방 상세 조회
routerAdd("GET", "/api/ck/rooms/{id}", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const roomId = c.request.pathValue("id");
  const room = L.BZFindById("match_rooms", roomId);
  if (!room) return c.json(404, { message: "방을 찾을 수 없습니다." });

  // 참가자만 접근 가능
  const allUsers = L.CKAllUserIds(room);
  if (!allUsers.includes(me.id)) return c.json(403, { message: "접근 권한이 없습니다." });

  const isMaster = room.getString("room_master") === me.id;
  const myTeam = L.CKTeamOf(room, me.id);

  return c.json(200, {
    ok: true,
    room: {
      id: room.id,
      season: room.getString("season"),
      team_a: L.CKSafeParse(room.getString("team_a"), []),
      team_b: L.CKSafeParse(room.getString("team_b"), []),
      elo_sum_a: room.getInt("elo_sum_a"),
      elo_sum_b: room.getInt("elo_sum_b"),
      elo_diff: room.getInt("elo_diff"),
      room_master: room.getString("room_master"),
      status: room.getString("status"),
      room_code: room.getString("room_code"),
      map: room.getString("map"),
      match_id: room.getString("match_id"),
      score_a: room.getInt("score_a"),
      score_b: room.getInt("score_b"),
      winner: room.getString("winner"),
      playing_at: room.getString("playing_at"),
      finished_at: room.getString("finished_at"),
      verify_attempts: room.getInt("verify_attempts"),
      last_verified_at: room.getString("last_verified_at"),
      elo_deltas: L.CKSafeParse(room.getString("elo_deltas"), {}),
      created: room.getString("created"),
    },
    isMaster,
    myTeam,
    myUserId: me.id,
  });
});

// 방 코드 등록/수정 (방장만)
routerAdd("POST", "/api/ck/rooms/{id}/code", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const roomId = c.request.pathValue("id");
  const room = L.BZFindById("match_rooms", roomId);
  if (!room) return c.json(404, { message: "방을 찾을 수 없습니다." });
  if (room.getString("room_master") !== me.id) return c.json(403, { message: "방장만 수정할 수 있습니다." });

  const body = L.BZBody(c);
  const roomCode = String(body.room_code || "").trim().toUpperCase();
  if (!roomCode) return c.json(400, { message: "방 코드를 입력해 주세요." });

  room.set("room_code", roomCode);
  $app.save(room);

  return c.json(200, { ok: true, message: "방 코드가 저장되었습니다." });
});

// 게임 시작 선언 (방장만)
routerAdd("POST", "/api/ck/rooms/{id}/start", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const roomId = c.request.pathValue("id");
  const room = L.BZFindById("match_rooms", roomId);
  if (!room) return c.json(404, { message: "방을 찾을 수 없습니다." });
  if (room.getString("room_master") !== me.id) return c.json(403, { message: "방장만 실행할 수 있습니다." });
  if (room.getString("status") !== "ready") {
    return c.json(400, { message: "대기 상태의 방만 시작할 수 있습니다." });
  }

  room.set("status", "playing");
  room.set("playing_at", L.CKNow());
  $app.save(room);

  return c.json(200, { ok: true, message: "게임 시작이 기록되었습니다. 자동 검증이 30분 후 시작됩니다." });
});

// 노쇼 신고
routerAdd("POST", "/api/ck/rooms/{id}/no-show", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const roomId = c.request.pathValue("id");
  const room = L.BZFindById("match_rooms", roomId);
  if (!room) return c.json(404, { message: "방을 찾을 수 없습니다." });

  const allUsers = L.CKAllUserIds(room);
  if (!allUsers.includes(me.id)) return c.json(403, { message: "참가자만 신고할 수 있습니다." });

  const body = L.BZBody(c);
  const targetId = String(body.targetUserId || "");
  if (!targetId) return c.json(400, { message: "대상 유저를 지정해 주세요." });

  const result = L.CKHandleNoShowReport(room, me.id, targetId);
  return c.json(result.ok ? 200 : 400, result);
});

// 매너 신고
routerAdd("POST", "/api/ck/rooms/{id}/report", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const roomId = c.request.pathValue("id");
  const room = L.BZFindById("match_rooms", roomId);
  if (!room) return c.json(404, { message: "방을 찾을 수 없습니다." });

  const allUsers = L.CKAllUserIds(room);
  if (!allUsers.includes(me.id)) return c.json(403, { message: "참가자만 신고할 수 있습니다." });

  const body = L.BZBody(c);
  const targetId = String(body.targetUserId || "");
  const reason = String(body.reason || "");
  if (!targetId) return c.json(400, { message: "대상 유저를 지정해 주세요." });

  const result = L.CKHandleMannerReport(room, me.id, targetId, reason);
  return c.json(result.ok ? 200 : 400, result);
});

// 수동 검증 트리거
routerAdd("POST", "/api/ck/rooms/{id}/verify", async (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const roomId = c.request.pathValue("id");
  const result = await L.CKManualVerify(roomId);
  return c.json(result.ok ? 200 : 400, result);
});

// 랭킹 조회
routerAdd("GET", "/api/ck/rankings", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  try {
    const query = L.CKParseQuery(c.request.url);
    const season = (query["season"] || "") || L.CKGetCurrentSeason();
    const page = parseInt((query["page"] || "") || "1", 10);
    const perPage = Math.min(parseInt((query["perPage"] || "") || "50", 10), 100);
    const sort = (query["sort"] || "") || "-elo";
    const tier = (query["tier"] || "");

    let filter = "season = {:s}";
    const params = { s: season };
    if (tier) {
      filter += " && tier_name = {:t}";
      params.t = tier;
    }

    const result = $app.findRecordsByFilter("rankings", filter, sort, perPage, (page - 1) * perPage, params);
    const allRows = $app.findRecordsByFilter("rankings", filter, "-id", 0, 0, params);
    const total = allRows.length;

    const items = result.map((r, idx) => ({
      rank: (page - 1) * perPage + idx + 1,
      user: r.getString("user"),
      nickname: r.getString("nickname"),
      riot_id: r.getString("riot_id"),
      tier: r.getInt("tier"),
      tier_name: r.getString("tier_name"),
      elo: r.getInt("elo"),
      wins: r.getInt("wins"),
      losses: r.getInt("losses"),
      draws: r.getInt("draws"),
      streak: r.getString("streak"),
      winrate: (r.getInt("wins") + r.getInt("losses") + r.getInt("draws")) > 0
        ? r.getInt("wins") / (r.getInt("wins") + r.getInt("losses") + r.getInt("draws"))
        : 0,
      peak_elo: r.getInt("peak_elo"),
    }));

    return c.json(200, {
      ok: true,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
      totalItems: total,
      items,
    });
  } catch (e) {
    return c.json(400, { ok: false, message: String(e) });
  }
});

// 내 랭킹/전적 상세
routerAdd("GET", "/api/ck/rankings/me", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const query = L.CKParseQuery(c.request.url);
  const season = (query["season"] || "") || L.CKGetCurrentSeason();

  try {
    const ranking = L.CKRankingOf(me.id, season);
    if (!ranking) return c.json(404, { message: "랭킹 정보가 없습니다." });

    // 최근 매치 조회 (match_rooms에서)
    const myRooms = $app.findRecordsByFilter(
      "match_rooms",
      "(team_a.user ~ {:u} || team_b.user ~ {:u}) && season = {:s} && status = 'finished'",
      "-finished_at",
      20,
      0,
      { u: me.id, s: season }
    );

    const recentMatches = myRooms.map((r) => {
      const teamA = L.CKSafeParse(r.getString("team_a"), []);
      const teamB = L.CKSafeParse(r.getString("team_b"), []);
      const myTeam = teamA.some((p) => p.user === me.id) ? "a" : "b";
      const deltas = L.CKSafeParse(r.getString("elo_deltas"), {});
      return {
        room_id: r.id,
        date: r.getString("finished_at") || r.getString("playing_at"),
        map: r.getString("map"),
        result: r.getString("winner") === myTeam ? "win" : "loss",
        score: r.getInt("score_a") + "-" + r.getInt("score_b"),
        my_team: myTeam,
        agent: teamA.find((p) => p.user === me.id)?.role || teamB.find((p) => p.user === me.id)?.role || "",
        elo_delta: deltas[me.id] || 0,
      };
    });

    return c.json(200, {
      ok: true,
      ranking: {
        user: ranking.getString("user"),
        season: ranking.getString("season"),
        riot_id: ranking.getString("riot_id"),
        puuid: ranking.getString("puuid"),
        affinity: ranking.getString("affinity"),
        tier: ranking.getInt("tier"),
        tier_name: ranking.getString("tier_name"),
        elo: ranking.getInt("elo"),
        wins: ranking.getInt("wins"),
        losses: ranking.getInt("losses"),
        draws: ranking.getInt("draws"),
        streak: ranking.getString("streak"),
        peak_elo: ranking.getInt("peak_elo"),
        recent_matches: recentMatches,
      },
    });
  } catch (e) {
    return c.json(400, { ok: false, message: String(e) });
  }
});

// 설정 조회
routerAdd("GET", "/api/ck/settings", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const settings = L.CKGetSettings();
  if (!settings) return c.json(404, { message: "설정을 찾을 수 없습니다." });

  return c.json(200, {
    ok: true,
    settings: {
      season: settings.getString("season"),
      elo_k: settings.getInt("ck_elo_k"),
      initial_elo: settings.getInt("ck_initial_elo"),
      match_elo_range: settings.getInt("ck_match_elo_range"),
      relax_step: settings.getInt("ck_relax_step"),
      relax_after_min: settings.getInt("ck_relax_after_min"),
      matching_enabled: settings.getBool("ck_matching_enabled"),
      no_show_grace_min: settings.getInt("no_show_grace_min"),
      no_show_penalty_min: settings.getInt("no_show_penalty_min"),
      no_show_penalty_max_hours: settings.getInt("no_show_penalty_max_hours"),
      verify_start_delay_min: settings.getInt("verify_start_delay_min"),
      verify_poll_interval_min: settings.getInt("verify_poll_interval_min"),
      verify_max_attempts: settings.getInt("verify_max_attempts"),
      manner_report_threshold: settings.getInt("manner_report_threshold"),
      manner_decay_per_day: settings.getInt("manner_decay_per_day"),
      manner_suspend_threshold: settings.getInt("manner_suspend_threshold"),
    },
  });
});

// ===== 관리자 API =====

// 패널티 부과/해제
routerAdd("POST", "/api/ck/admin/penalty", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });
  if (me.getString("role") !== "operator") return c.json(403, { message: "운영자 전용입니다." });

  const body = L.BZBody(c);
  const userId = String(body.userId || "");
  const type = String(body.type || "");
  const reason = String(body.reason || "");
  const penaltyUntil = body.penalty_until ? String(body.penalty_until) : null;
  const action = String(body.action || "apply");

  if (!userId || !type) return c.json(400, { message: "userId, type 필수" });

  if (action === "remove") {
    try {
      const penalties = $app.findRecordsByFilter("penalties", "user = {:u} && type = {:t}", "created", 10, 0, { u: userId, t: type });
      for (const p of penalties) $app.delete(p);
      return c.json(200, { ok: true, message: "페널티 해제됨" });
    } catch (e) {
      return c.json(400, { message: String(e) });
    }
  }

  try {
    const col = $app.findCollectionByNameOrId("penalties");
    const p = new Record(col);
    p.set("user", userId);
    p.set("type", type);
    p.set("reason", reason);
    p.set("penalty_until", penaltyUntil);
    p.set("created_by", me.id);
    p.set("auto", false);
    $app.save(p);
    return c.json(200, { ok: true, message: "페널티 부과됨" });
  } catch (e) {
    return c.json(400, { message: String(e) });
  }
});

// Mismatch 방 강제 판정
routerAdd("POST", "/api/ck/admin/room/adjudicate", async (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });
  if (me.getString("role") !== "operator") return c.json(403, { message: "운영자 전용입니다." });

  const body = L.BZBody(c);
  const roomId = String(body.roomId || "");
  const winner = String(body.winner || ""); // "a" or "b"
  const scoreA = parseInt(body.score_a || "13", 10);
  const scoreB = parseInt(body.score_b || "0", 10);

  if (!roomId || !winner) return c.json(400, { message: "roomId, winner 필수" });

  try {
    const room = L.BZFindById("match_rooms", roomId);
    if (!room) return c.json(404, { message: "방을 찾을 수 없습니다." });

    // 가짜 매치 객체로 정산 실행
    const fakeMatch = {
      metadata: { matchid: "admin-" + Date.now(), map: room.getString("map") || "Unknown" },
      teams: [
        { won: winner === "a", rounds_won: scoreA },
        { won: winner === "b", rounds_won: scoreB },
      ],
    };

    const result = await L.CKDoSettlement(room, fakeMatch);
    return c.json(200, { ok: true, message: "강제 판정 및 정산 완료", settlement: result });
  } catch (e) {
    return c.json(400, { message: String(e) });
  }
});

// 진행 중 방 강제 종료
routerAdd("POST", "/api/ck/admin/room/{id}/force-end", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });
  if (me.getString("role") !== "operator") return c.json(403, { message: "운영자 전용입니다." });

  const roomId = c.request.pathValue("id");
  const body = L.BZBody(c);
  const reason = String(body.reason || "관리자 강제 종료");
  const cancelQueue = body.cancel_queue === true;

  try {
    const room = L.BZFindById("match_rooms", roomId);
    if (!room) return c.json(404, { message: "방을 찾을 수 없습니다." });

    room.set("status", "cancelled");
    $app.save(room);

    if (cancelQueue) {
      const allUsers = L.CKAllUserIds(room);
      for (const uid of allUsers) {
        const q = $app.findFirstRecordByFilter("match_queue", "battle_id = {:b} && user = {:u} && status = 'matched'", {
          b: roomId,
          u: uid,
        });
        if (q) {
          q.set("status", "waiting");
          q.set("battle_id", "");
          $app.save(q);
        }
      }
    }

    return c.json(200, { ok: true, message: "방 강제 종료됨" });
  } catch (e) {
    return c.json(400, { message: String(e) });
  }
});

// 키 사용량 조회
routerAdd("GET", "/api/ck/admin/keys/usage", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });
  if (me.getString("role") !== "operator") return c.json(403, { message: "운영자 전용입니다." });

  return c.json(200, { ok: true, keys: L.CKRateUsage() });
});

// 키 테스트
routerAdd("POST", "/api/ck/admin/keys/test", async (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });
  if (me.getString("role") !== "operator") return c.json(403, { message: "운영자 전용입니다." });

  const body = L.BZBody(c);
  const keyId = String(body.keyId || "");
  if (!keyId) return c.json(400, { message: "keyId 필수" });

  const keyRec = L.BZFindById("valorant_keys", keyId);
  if (!keyRec) return c.json(404, { message: "키를 찾을 수 없습니다." });

  try {
    const res = await $http.send({
      url: "https://api.henrikdev.xyz/valorant/v1/status/ap?api_key=" + encodeURIComponent(keyRec.getString("key")),
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "BattleZone-App/1.0" },
      timeout: 15000,
    });
    if (res.statusCode === 401 || res.statusCode === 403) {
      return c.json(200, { ok: false, message: "키가 유효하지 않습니다. (" + res.statusCode + ")" });
    }
    if (res.statusCode === 429) {
      return c.json(200, { ok: false, message: "키 한도 초과(429)" });
    }
    if (res.statusCode === 200) {
      keyRec.set("last_used_at", L.CKNow());
      keyRec.set("fail_count", 0);
      $app.save(keyRec);
      return c.json(200, { ok: true, message: "키가 정상 동작합니다." });
    }
    return c.json(200, { ok: false, message: "HenrikDev API 응답 " + res.statusCode });
  } catch (e) {
    return c.json(200, { ok: false, message: "HenrikDev API 연결 실패" });
  }
});