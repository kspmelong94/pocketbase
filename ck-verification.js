// CK 자동 검증 엔진
// 방장의 최근 커스텀 매치 폴링 → 10명 puuid 일치 확인 → 정산 트리거

const { CKGetSettings, CKGetCurrentSeason, CKNow, CKLog, CKSafeParse, CKAllUserIds, CKTeamOf } = require(`${__hooks}/ck-utils.js`);
const { CKRecentCustomMatchesByPuuid } = require(`${__hooks}/ck-api.js`);
const { CKDoSettlement } = require(`${__hooks}/ck-settlement.js`);

// playing 상태 방 조회 (30분 경과한 것)
function CKGetVerifiableRooms() {
  const settings = CKGetSettings();
  if (!settings) return [];
  const delayMs = (settings.getInt("verify_start_delay_min") || 30) * 60000;
  const cutoff = new Date(Date.now() - delayMs).toISOString();

  try {
    return $app.findRecordsByFilter(
      "match_rooms",
      "status = 'playing' && playing_at != '' && playing_at < {:cutoff}",
      "playing_at",
      50,
      0,
      { cutoff }
    );
  } catch (e) {
    return [];
  }
}

// 방을 mismatch 상태로 변경
function CKSetMismatch(room) {
  room.set("status", "mismatch");
  $app.save(room);
  CKLog("verification", "Mismatch 전환", { roomId: room.id });
}

// 방 검증 수행
function CKVerifyRoom(room) {
  const settings = CKGetSettings();
  if (!settings) return { error: "Settings not found" };

  const maxAttempts = settings.getInt("verify_max_attempts") || 30;
  const attempts = room.getInt("verify_attempts") || 0;

  // 최대 시도 초과
  if (attempts >= maxAttempts) {
    CKSetMismatch(room);
    return { mismatched: true };
  }

  // 방장 정보
  const masterId = room.getString("room_master");
  if (!masterId) {
    CKLog("verification", "방장 없음", { roomId: room.id });
    return { error: "No room master" };
  }

  // 방장 랭킹에서 riot_id, puuid, affinity 조회
  const masterRanking = $app.findFirstRecordByFilter("rankings", "user = {:u} && season = {:s}", {
    u: masterId,
    s: room.getString("season") || CKGetCurrentSeason(),
  });

  if (!masterRanking || !masterRanking.getString("puuid")) {
    CKLog("verification", "방장 랭킹/puuid 없음", { roomId: room.id, masterId });
    return { error: "Master ranking not found" };
  }

  const riotId = masterRanking.getString("riot_id");
  const puuid = masterRanking.getString("puuid");
  const affinity = masterRanking.getString("affinity") || "ap";

  // 최근 커스텀 매치 폴링 (방장 puuid 기준, AP 고정)
  const result = CKRecentCustomMatchesByPuuid(puuid, affinity);
  if (!result.ok) {
    CKLog("verification", "매치 조회 실패", { roomId: room.id, error: result.error });
    return { error: result.error, noKeys: result.noKeys, rateLimited: result.rateLimited };
  }

  const matches = result.matches || [];
  const playingAt = room.getString("playing_at");
  if (!playingAt) return { pending: true };

  const allPuuids = CKAllUserIds(room); // 팀 A + B 10명 puuid
  if (allPuuids.length !== 10) {
    CKLog("verification", "참가자 10명 아님", { roomId: room.id, count: allPuuids.length });
    return { error: "Not 10 players" };
  }

  // playing_at 이후 생성된 커스텀 매치 중 10명 모두 포함된 것 찾기 (v4 스키마)
  const targetMatch = matches.find((m) => {
    if (!m.metadata) return false;
    const startedAt = m.metadata.started_at || m.metadata.game_start_in_iso || m.metadata.game_start_patched || m.metadata.game_start;
    if (!startedAt) return false;
    // 시작 선언 1분 전까지의 매치 허용(시차 보정), 이후 6시간까지
    const started = new Date(startedAt).getTime();
    if (started < new Date(playingAt).getTime() - 60000) return false;
    if (new Date(playingAt).getTime() && started > new Date(playingAt).getTime() + 6 * 3600 * 1000) return false;
    const queueId = String((m.metadata.queue && (m.metadata.queue.id || m.metadata.queue.name || "")) || "").toLowerCase();
    if (queueId !== "custom") return false;
    if (m.metadata.is_completed === false) return false;

    const matchPlayers = m.players || [];
    const matchPuuids = matchPlayers.map((p) => p.puuid) || [];
    return allPuuids.every((p) => matchPuuids.includes(p));
  });

  if (targetMatch) {
    // 검증 성공 → 방장 팀 기준으로 a/b 사이드 매핑 후 정산
    const matchId = (targetMatch.metadata && targetMatch.metadata.match_id) || "";
    CKLog("verification", "매치 발견, 정산 시작", { roomId: room.id, matchId: matchId });

    const masterPlayer = (targetMatch.players || []).find((p) => p.puuid === puuid);
    const masterTeamId = masterPlayer ? masterPlayer.team_id : null;
    const myTeam = CKTeamOf(room, masterId) || "a";

    function sideOf(teamId) {
      return teamId === masterTeamId ? myTeam : myTeam === "a" ? "b" : "a";
    }

    // v4 teams: [{team_id:"Red"|"Blue", won, rounds:{won}}] → side("a"/"b") 부여해 전달
    const mappedTeams = (targetMatch.teams || []).map((t) => ({
      team_id: t.team_id,
      won: t.won === true,
      rounds_won: Number((t.rounds && t.rounds.won) || 0),
      side: sideOf(t.team_id),
    }));

    // 10인 개인 스탯 스냅샷: puuid → userId 매핑 (rankings 의 puuid 사용)
    const userIdByPuuid = {};
    for (const uid of allPuuids) {
      try {
        const rk = $app.findFirstRecordByFilter("rankings", "user = {:u} && season = {:s}", {
          u: uid,
          s: room.getString("season") || CKGetCurrentSeason(),
        });
        if (rk && rk.getString("puuid")) userIdByPuuid[rk.getString("puuid")] = uid;
      } catch (e) {
        /* 무시 */
      }
    }

    const playerStats = {};
    for (const p of targetMatch.players || []) {
      const uid = userIdByPuuid[p.puuid];
      if (!uid) continue;
      const st = p.stats || {};
      const dmg = st.damage || p.damage || {};
      const agentRaw = (p.agent && (p.agent.name || p.agent.id)) || p.character || "";
      playerStats[uid] = {
        name: String(p.name || ""),
        tag: String(p.tag || ""),
        agent: String(agentRaw),
        side: sideOf(p.team_id),
        kills: Number(st.kills || 0),
        deaths: Number(st.deaths || 0),
        assists: Number(st.assists || 0),
        score: Number(st.score || 0),
        headshots: Number(st.headshots || 0),
        bodyshots: Number(st.bodyshots || 0),
        legshots: Number(st.legshots || 0),
        dmg_made: Number(dmg.made || 0),
        dmg_received: Number(dmg.received || 0),
      };
    }
    const statsCount = Object.keys(playerStats).length;
    if (statsCount > 0) CKLog("verification", "개인 스탯 수집", { roomId: room.id, players: statsCount });

    const settled = CKDoSettlement(room, {
      teams: mappedTeams,
      metadata: targetMatch.metadata,
    }, statsCount > 0 ? playerStats : null);
    return { verified: settled.ok !== false, matchId: matchId, settlement: settled };
  }

  // 재시도 카운트 증가
  room.set("verify_attempts", attempts + 1);
  room.set("last_verified_at", CKNow());
  $app.save(room);

  CKLog("verification", "매치 미발견, 재시도 예약", { roomId: room.id, attempts: attempts + 1, maxAttempts });
  return { pending: true, attempts: attempts + 1 };
}

// 전체 자동 검증 크론 (2분마다)
function CKAutoVerifyAll() {
  const rooms = CKGetVerifiableRooms();
  if (rooms.length === 0) return { ok: true, verified: 0, mismatched: 0, skipped: 0 };

  CKLog("verification", "자동 검증 시작", { count: rooms.length });

  let verified = 0;
  let mismatched = 0;
  let errors = 0;

  for (const room of rooms) {
    try {
      const result = CKVerifyRoom(room);
      if (result.verified) verified++;
      else if (result.mismatched) mismatched++;
      else if (result.error) errors++;
    } catch (e) {
      errors++;
      CKLog("verification", "검증 중 예외", { roomId: room.id, error: String(e) });
    }
  }

  return { ok: true, verified, mismatched, errors };
}

// 수동 검증 트리거 (API에서 호출)
function CKManualVerify(roomId) {
  try {
    const room = $app.findRecordById("match_rooms", roomId);
    if (!room) return { ok: false, error: "Room not found" };
    if (room.getString("status") !== "playing") {
      return { ok: false, error: "Not in playing state" };
    }
    const result = CKVerifyRoom(room);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

module.exports = {
  CKGetVerifiableRooms,
  CKVerifyRoom,
  CKSetMismatch,
  CKAutoVerifyAll,
  CKManualVerify,
};