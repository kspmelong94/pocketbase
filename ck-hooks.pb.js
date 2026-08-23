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
cronAdd("ck-auto-verify", "*/2 * * * *", () => {
const L = require(`${__hooks}/ck-lib-all.js`);
  try {
    const result = L.CKAutoVerifyAll();
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
routerAdd("POST", "/api/ck/lookup", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
try {
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const body = L.BZBody(c);
  const riotId = String(body.riotId || body.riot_id || "").trim();
  if (!riotId) return c.json(400, { message: "Riot ID(이름#태그)를 입력해 주세요." });

  const acc = L.CKAccount(riotId);
  if (acc.noKeys) {
    return c.json(200, { ok: false, message: "발로란트 API 키가 등록되지 않았습니다. 관리자 설정에서 등록해 주세요." });
  }
  if (acc.rateLimited) return c.json(200, { ok: false, message: "발로란트 API 호출 한도 초과" });
  if (!acc.ok) return c.json(200, { ok: false, message: acc.error || "계정을 찾을 수 없습니다." });

  const mmr = L.CKMMR(acc.puuid, acc.affinity);
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

  let savedOk = true;
  let savedErr = "";
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
      savedOk = false;
      savedErr = String(e);
    }
    elo = Number(ranking.getInt("elo") || 0);
  } else {
    // 최초 등록
    let rec;
    try {
      rec = L.CKEnsureRanking(me.id, initialElo);
    } catch (e) {
      return c.json(200, { ok: false, message: "랭킹 레코드 초기화 실패 (rankings 컬렉션/필드 확인 필요): " + String(e) });
    }
    rec.set("nickname", L.BZNicknameOf(me.id));
    rec.set("riot_id", acc.name + "#" + acc.tag);
    rec.set("puuid", acc.puuid);
    rec.set("affinity", acc.affinity);
    rec.set("tier", mmr.tier || 0);
    rec.set("tier_name", tierKey);
    try {
      $app.save(rec);
    } catch (e) {
      savedOk = false;
      savedErr = String(e);
    }
    elo = initialElo;
    isFirst = true;
  }

  if (!savedOk) {
    L.BZLog("ck-lookup", "랭킹 저장 실패: " + savedErr, { userId: me.id });
    return c.json(200, { ok: false, message: "Riot ID는 확인됐지만 랭킹 저장에 실패했습니다: " + savedErr });
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
  } catch (err) {
    console.log("[ck] lookup 예외: " + String(err));
    return c.json(500, { ok: false, message: "lookup 내부 오류: " + String(err) });
  }
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
    // 결과 없음은 예외로 던져지므로 null 로 정규화
    let myQueue = null;
    try {
      myQueue = $app.findFirstRecordByFilter(
        "match_queue",
        "user = {:u} && season = {:s} && status != 'cancelled'",
        { u: me.id, s: season }
      );
    } catch (e) {
      myQueue = null;
    }

    let waitingCount = 0;
    try {
      const waitingRecords = $app.findRecordsByFilter(
        "match_queue",
        "status = 'waiting' && season = {:s}",
        "-id",
        500,
        0,
        { s: season }
      );
      waitingCount = waitingRecords.length;
    } catch (e) {
      waitingCount = 0;
    }

    return c.json(200, {
      ok: true,
      queue: myQueue ? {
        id: myQueue.id,
        status: myQueue.getString("status"),
        elo: myQueue.getInt("elo"),
        queued_at: myQueue.getString("queued_at"),
        room_id: myQueue.getString("battle_id") || "",
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

// 내 상세 통계 집계 (finished 방 + player_stats 스냅샷)
routerAdd("GET", "/api/ck/stats/me", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
try {
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const query = L.CKParseQuery(c.request.url);
  const season = query["season"] || L.CKGetCurrentSeason();

  let rooms = [];
  try {
    // 주의: json 배열 필드(team_a.user 등)의 dot-notation 필터는 v0.39 에서 동작하지 않음
    // → status+season 으로 조회 후 JS 사이드에서 멤버십 검사
    const allRooms = $app.findRecordsByFilter(
      "match_rooms",
      "season = {:s} && status = 'finished'",
      "-finished_at",
      100,
      0,
      { s: season }
    );
    rooms = allRooms.filter((r) => {
      const teamA = L.CKSafeParse(r.getString("team_a"), []);
      const teamB = L.CKSafeParse(r.getString("team_b"), []);
      return (
        (Array.isArray(teamA) && teamA.some((p) => p.user === me.id)) ||
        (Array.isArray(teamB) && teamB.some((p) => p.user === me.id))
      );
    });
  } catch (e) {
    rooms = [];
  }

  const totals = { matches: 0, wins: 0, losses: 0, draws: 0, kills: 0, deaths: 0, assists: 0, hs_hits: 0, hs_shots: 0, score: 0 };
  const maps = {};
  const agents = {};
  const form = [];

  for (const r of rooms) {
    const teamA = L.CKSafeParse(r.getString("team_a"), []);
    const teamB = L.CKSafeParse(r.getString("team_b"), []);
    const mySide = teamA.some((p) => p.user === me.id) ? "a" : teamB.some((p) => p.user === me.id) ? "b" : null;
    if (!mySide) continue;

    const winner = r.getString("winner");
    const result = winner === mySide ? "w" : winner ? "l" : "d";
    totals.matches++;
    if (result === "w") totals.wins++;
    else if (result === "l") totals.losses++;
    else totals.draws++;

    const mapName = r.getString("map") || "기타";
    if (!maps[mapName]) maps[mapName] = { w: 0, l: 0 };
    if (result === "w") maps[mapName].w++;
    else if (result === "l") maps[mapName].l++;

    let ps = null;
    const allStats = L.CKSafeParse(r.getString("player_stats"), {});
    if (allStats && typeof allStats === "object") ps = allStats[me.id] || null;

    const deltaMap = L.CKSafeParse(r.getString("elo_deltas"), {});
    const entry = {
      room_id: r.id,
      date: r.getString("finished_at") || "",
      map: mapName,
      result: result,
      score: r.getInt("score_a") + "-" + r.getInt("score_b"),
      elo_delta: Number(deltaMap[me.id] || 0),
    };

    if (ps && typeof ps === "object") {
      const shots = Number(ps.headshots || 0) + Number(ps.bodyshots || 0) + Number(ps.legshots || 0);
      entry.kills = Number(ps.kills || 0);
      entry.deaths = Number(ps.deaths || 0);
      entry.assists = Number(ps.assists || 0);
      entry.hs_pct = shots > 0 ? Math.round((Number(ps.headshots || 0) / shots) * 100) : null;
      entry.acs = Math.round(Number(ps.score || 0) / 13); // 라운드 수 미보유 → 13라운드 근사
      totals.kills += entry.kills;
      totals.deaths += entry.deaths;
      totals.assists += entry.assists;
      totals.hs_hits += Number(ps.headshots || 0);
      totals.hs_shots += shots;
      totals.score += Number(ps.score || 0);

      const ag = String(ps.agent || "기타");
      if (!agents[ag]) agents[ag] = { picks: 0, w: 0, l: 0, k: 0, d: 0 };
      agents[ag].picks++;
      if (result === "w") agents[ag].w++;
      else if (result === "l") agents[ag].l++;
      agents[ag].k += entry.kills;
      agents[ag].d += entry.deaths;
    } else {
      entry.kills = null;
      entry.deaths = null;
      entry.assists = null;
      entry.hs_pct = null;
      entry.acs = null;
    }
    form.push(entry);
  }

  const mapList = Object.keys(maps)
    .map((name) => ({ name: name, w: maps[name].w, l: maps[name].l }))
    .sort((a, b) => b.w + b.l - (a.w + a.l));
  const agentList = Object.keys(agents)
    .map((name) => ({ agent: name, picks: agents[name].picks, w: agents[name].w, l: agents[name].l, k: agents[name].k, d: agents[name].d }))
    .sort((a, b) => b.picks - a.picks);

  return c.json(200, {
    ok: true,
    totals: totals,
    maps: mapList,
    agents: agentList,
    form: form.slice(0, 30),
    has_player_stats: form.some((f) => f.kills != null),
  });
} catch (err) {
  console.log("[ck] stats/me 예외: " + String(err));
  return c.json(500, { ok: false, message: "stats 오류: " + String(err) });
}
});

// ---------- 파티 ----------
// 내 파티/초대 조회
routerAdd("GET", "/api/ck/party/my", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
try {
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });
  const mine = L.PFindUserParty(me.id);
  const invites = L.PFindPendingInvites(me.id).map((r) => L.PBuildPartyView(r));
  return c.json(200, { ok: true, party: mine ? L.PBuildPartyView(mine.record) : null, invites: invites });
} catch (err) {
  return c.json(500, { ok: false, message: "party/my 오류: " + String(err) });
}
});

// 초대 대상 검색 (rankings riot_id 접두사)
routerAdd("GET", "/api/ck/party/search", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
try {
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });
  const query = L.CKParseQuery(c.request.url);
  const qRaw = String(query["q"] || "").trim();
  if (qRaw.length < 2) return c.json(200, { ok: true, results: [] });

  let rows = [];
  try {
    rows = $app.findRecordsByFilter("rankings", "riot_id ~ {:qq} && puuid != ''", "-elo", 8, 0, { qq: qRaw });
  } catch (e) {
    rows = [];
  }

  const results = [];
  for (const r of rows) {
    const uid = r.getString("user");
    if (uid === me.id) continue;
    const targetParty = L.PFindUserParty(uid);
    results.push({
      user: uid,
      riot_id: r.getString("riot_id"),
      nickname: r.getString("nickname"),
      elo: Number(r.getInt("elo") || 0),
      in_party: !!targetParty,
    });
  }
  return c.json(200, { ok: true, results: results });
} catch (err) {
  return c.json(500, { ok: false, message: "party/search 오류: " + String(err) });
}
});

// 파티 생성
routerAdd("POST", "/api/ck/party/create", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
try {
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  // Riot ID 등록자만 파티 사용 가능
  try {
    const rk = $app.findFirstRecordByFilter("rankings", "user = {:u}", { u: me.id });
    if (!rk) throw new Error("no-ranking");
  } catch (e) {
    return c.json(400, { ok: false, message: "먼저 Riot ID를 등록해 주세요." });
  }

  if (L.PFindUserParty(me.id)) {
    return c.json(400, { ok: false, message: "이미 참여 중인 파티가 있습니다." });
  }

  let code = L.PGenCode();
  for (let i = 0; i < 8; i++) {
    try {
      $app.findFirstRecordByFilter("parties", "code = {:c}", { c: code });
      code = L.PGenCode(); // 존재 → 재생성
    } catch (e) {
      break; // 없음 → 확정
    }
  }

  const col = $app.findCollectionByNameOrId("parties");
  const rec = new Record(col);
  rec.set("leader", me.id);
  rec.set("code", code);
  rec.set("status", "open");
  rec.set("season", L.CKGetCurrentSeason());
  rec.set("members", [{ user: me.id, state: "leader" }]);
  $app.save(rec);

  return c.json(200, { ok: true, party: L.PBuildPartyView(rec) });
} catch (err) {
  return c.json(500, { ok: false, message: "party/create 오류: " + String(err) });
}
});

// 초대 (리더만)
routerAdd("POST", "/api/ck/party/invite", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
try {
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const mine = L.PFindUserParty(me.id);
  if (!mine || mine.entry.state !== "leader") {
    return c.json(403, { ok: false, message: "파티 리더만 초대할 수 있습니다." });
  }

  const body = L.BZBody(c);
  const targetId = String(body.userId || "");
  if (!targetId || targetId === me.id) return c.json(400, { ok: false, message: "초대 대상이 올바르지 않습니다." });

  const members = mine.members;
  if (members.length >= L.PARTY_MAX) return c.json(400, { ok: false, message: "파티 정원(5명)이 가득 찼습니다." });
  if (members.some((m) => m.user === targetId)) {
    return c.json(400, { ok: false, message: "이미 파티에 속해 있거나 초대된 플레이어입니다." });
  }
  if (L.PFindUserParty(targetId)) {
    return c.json(400, { ok: false, message: "상대가 다른 파티에 소속되어 있습니다." });
  }

  members.push({ user: targetId, state: "invited" });
  mine.record.set("members", members);
  $app.save(mine.record);

  return c.json(200, { ok: true, party: L.PBuildPartyView(mine.record) });
} catch (err) {
  return c.json(500, { ok: false, message: "party/invite 오류: " + String(err) });
}
});

// 초대 수락
routerAdd("POST", "/api/ck/party/accept", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
try {
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const body = L.BZBody(c);
  const partyId = String(body.partyId || "");
  if (!partyId) return c.json(400, { ok: false, message: "partyId 가 필요합니다." });

  if (L.PFindUserParty(me.id)) {
    return c.json(400, { ok: false, message: "이미 참여 중인 파티가 있습니다. 먼저 탈퇴해 주세요." });
  }

  const party = $app.findRecordById("parties", partyId);
  const members = L.PParseMembers(party.getString("members"));
  const entry = members.find((m) => m.user === me.id && m.state === "invited");
  if (!entry) return c.json(404, { ok: false, message: "유효한 초대가 없습니다." });
  if (party.getString("status") !== "open") return c.json(400, { ok: false, message: "파티가 매칭 중이거나 종료되어 참여할 수 없습니다." });
  if (L.PJoinedMembers(members).length >= L.PARTY_MAX) return c.json(400, { ok: false, message: "파티 정원이 가득 찼습니다." });

  entry.state = "joined";
  party.set("members", members);
  $app.save(party);

  return c.json(200, { ok: true, party: L.PBuildPartyView(party) });
} catch (err) {
  return c.json(500, { ok: false, message: "party/accept 오류: " + String(err) });
}
});

// 초대 거절
routerAdd("POST", "/api/ck/party/decline", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
try {
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const body = L.BZBody(c);
  const partyId = String(body.partyId || "");
  if (!partyId) return c.json(400, { ok: false, message: "partyId 가 필요합니다." });

  const party = $app.findRecordById("parties", partyId);
  const members = L.PParseMembers(party.getString("members"));
  const idx = members.findIndex((m) => m.user === me.id && m.state === "invited");
  if (idx < 0) return c.json(404, { ok: false, message: "유효한 초대가 없습니다." });

  members.splice(idx, 1);
  party.set("members", members);
  $app.save(party);

  return c.json(200, { ok: true });
} catch (err) {
  return c.json(500, { ok: false, message: "party/decline 오류: " + String(err) });
}
});

// 탈퇴 (리더 탈퇴 시 최장 합류자에게 위임, 인원 0이면 해체)
routerAdd("POST", "/api/ck/party/leave", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
try {
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const mine = L.PFindUserParty(me.id);
  if (!mine) return c.json(404, { ok: false, message: "참여 중인 파티가 없습니다." });
  if (mine.record.getString("status") === "queued") {
    return c.json(400, { ok: false, message: "매칭 중에는 탈퇴할 수 없습니다. 먼저 매칭을 취소해 주세요." });
  }

  let members = mine.members.filter((m) => m.user !== me.id);
  const remainingActive = members.filter((m) => m.state === "leader" || m.state === "joined");

  if (remainingActive.length === 0) {
    mine.record.set("status", "disbanded");
    mine.record.set("members", members);
    $app.save(mine.record);
    return c.json(200, { ok: true, disbanded: true });
  }

  if (mine.entry.state === "leader") {
    remainingActive[0].state = "leader";
    for (const m of members) if (m.user === remainingActive[0].user) m.state = "leader";
    mine.record.set("leader", remainingActive[0].user);
  }
  mine.record.set("members", members);
  $app.save(mine.record);

  return c.json(200, { ok: true, party: L.PBuildPartyView(mine.record) });
} catch (err) {
  return c.json(500, { ok: false, message: "party/leave 오류: " + String(err) });
}
});

// 추방 (리더만)
routerAdd("POST", "/api/ck/party/kick", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
try {
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const mine = L.PFindUserParty(me.id);
  if (!mine || mine.entry.state !== "leader") {
    return c.json(403, { ok: false, message: "파티 리더만 추방할 수 있습니다." });
  }
  if (mine.record.getString("status") === "queued") {
    return c.json(400, { ok: false, message: "매칭 중에는 추방할 수 없습니다." });
  }

  const body = L.BZBody(c);
  const targetId = String(body.userId || "");
  const members = mine.members.filter((m) => m.user !== targetId);
  if (members.length === mine.members.length) {
    return c.json(404, { ok: false, message: "파티에 해당 멤버가 없습니다." });
  }
  if (targetId === mine.record.getString("leader")) {
    return c.json(400, { ok: false, message: "리더는 추방할 수 없습니다." });
  }

  mine.record.set("members", members);
  $app.save(mine.record);

  return c.json(200, { ok: true, party: L.PBuildPartyView(mine.record) });
} catch (err) {
  return c.json(500, { ok: false, message: "party/kick 오류: " + String(err) });
}
});

// 해체 (리더만)
routerAdd("POST", "/api/ck/party/disband", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
try {
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const mine = L.PFindUserParty(me.id);
  if (!mine || mine.entry.state !== "leader") {
    return c.json(403, { ok: false, message: "파티 리더만 해체할 수 있습니다." });
  }

  mine.record.set("status", "disbanded");
  $app.save(mine.record);

  return c.json(200, { ok: true, disbanded: true });
} catch (err) {
  return c.json(500, { ok: false, message: "party/disband 오류: " + String(err) });
}
});

// 파티 매칭 시작 (리더만) — 전원 일괄 큐 등록
routerAdd("POST", "/api/ck/party/queue-enter", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
try {
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const mine = L.PFindUserParty(me.id);
  if (!mine || mine.entry.state !== "leader") {
    return c.json(403, { ok: false, message: "파티 리더만 매칭을 시작할 수 있습니다." });
  }
  if (mine.record.getString("status") === "queued") {
    return c.json(400, { ok: false, message: "이미 매칭 대기 중입니다." });
  }

  const active = L.PJoinedMembers(mine.members);
  if (active.length < 2) return c.json(400, { ok: false, message: "파티 인원이 부족합니다. (최소 2명)" });

  const season = L.CKGetCurrentSeason();

  // 사전 검증: 페널티·Riot 등록
  for (const m of active) {
    const penalty = L.CKCheckPenalty(m.user);
    if (penalty.blocked) {
      return c.json(400, { ok: false, message: "파티원의 페널티로 매칭할 수 없습니다: " + penalty.message });
    }
    try {
      const rk = $app.findFirstRecordByFilter("rankings", "user = {:u} && season = {:s}", { u: m.user, s: season });
      if (!rk || !rk.getString("puuid")) {
        const who = m.nickname || m.user;
        return c.json(400, { ok: false, message: who + " 님이 Riot ID를 등록하지 않았습니다." });
      }
    } catch (e) {
      return c.json(400, { ok: false, message: "랭킹 조회 실패로 매칭을 시작할 수 없습니다." });
    }
  }

  // 기존 개인 큐 정리 후 파티 큐 등록
  const col = $app.findCollectionByNameOrId("match_queue");
  for (const m of active) {
    L.PCancelUserQueue(season, m.user);

    let elo = 1000;
    try {
      const rk = $app.findFirstRecordByFilter("rankings", "user = {:u} && season = {:s}", { u: m.user, s: season });
      elo = Number(rk.getInt("elo") || 1000);
    } catch (e) {}

    const rec = new Record(col);
    rec.set("user", m.user);
    rec.set("elo", elo);
    rec.set("status", "waiting");
    rec.set("season", season);
    rec.set("queued_at", L.CKNow());
    rec.set("party_id", mine.record.id);
    $app.save(rec);
  }

  mine.record.set("status", "queued");
  $app.save(mine.record);

  // 즉시 매칭 시도
  L.CKRunMatchmaking();

  return c.json(200, { ok: true, party: L.PBuildPartyView(mine.record), queued: active.length });
} catch (err) {
  return c.json(500, { ok: false, message: "party/queue-enter 오류: " + String(err) });
}
});

// 파티 매칭 취소 (합류 멤버 누구나)
routerAdd("POST", "/api/ck/party/queue-cancel", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
try {
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const mine = L.PFindUserParty(me.id);
  if (!mine) return c.json(404, { ok: false, message: "참여 중인 파티가 없습니다." });
  if (mine.record.getString("status") !== "queued") {
    return c.json(400, { ok: false, message: "매칭 대기 중인 파티가 아닙니다." });
  }

  const season = L.CKGetCurrentSeason();
  for (const m of L.PJoinedMembers(mine.members)) {
    L.PCancelUserQueue(season, m.user);
  }

  mine.record.set("status", "open");
  $app.save(mine.record);

  return c.json(200, { ok: true, party: L.PBuildPartyView(mine.record) });
} catch (err) {
  return c.json(500, { ok: false, message: "party/queue-cancel 오류: " + String(err) });
}
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
routerAdd("POST", "/api/ck/rooms/{id}/verify", (c) => {
const L = require(`${__hooks}/ck-lib-all.js`);
  const me = L.BZAuth(c);
  if (!me) return c.json(401, { message: "인증이 필요합니다." });

  const roomId = c.request.pathValue("id");
  const result = L.CKManualVerify(roomId);
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

    // 결과 없음은 예외로 던져지므로 빈 배열로 정규화
    let result = [];
    try {
      result = $app.findRecordsByFilter("rankings", filter, sort, perPage, (page - 1) * perPage, params);
    } catch (e) {
      result = [];
    }
    let total = 0;
    try {
      const allRows = $app.findRecordsByFilter("rankings", filter, "-id", 0, 0, params);
      total = allRows.length;
    } catch (e) {
      total = 0;
    }

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

    // 최근 매치 조회 — json 배열 필드 dot-notation 필터 미지원 → JS 사이드 멤버십 검사
    let myRooms = [];
    try {
      const allFinished = $app.findRecordsByFilter(
        "match_rooms",
        "season = {:s} && status = 'finished'",
        "-finished_at",
        50,
        0,
        { s: season }
      );
      myRooms = allFinished.filter((r) => {
        const a = L.CKSafeParse(r.getString("team_a"), []);
        const b = L.CKSafeParse(r.getString("team_b"), []);
        return (
          (Array.isArray(a) && a.some((p) => p.user === me.id)) ||
          (Array.isArray(b) && b.some((p) => p.user === me.id))
        );
      });
    } catch (e) {
      myRooms = [];
    }

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
routerAdd("POST", "/api/ck/admin/room/adjudicate", (c) => {
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

    const result = L.CKDoSettlement(room, fakeMatch);
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
routerAdd("POST", "/api/ck/admin/keys/test", (c) => {
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
    const res = $http.send({
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