// CK 매칭 엔진
// 10명 후보군에서 ELO 합계 차이가 최소가 되는 5:5 팀 분할

const { CKGetSettings, CKGetCurrentSeason, CKNow, CKLog, CKSafeParse, CKEloSum } = require(`${__hooks}/ck-utils.js`);

// 대기열에서 waiting 상태 레코드 조회
function CKGetWaitingQueue(season) {
  try {
    return $app.findRecordsByFilter(
      "match_queue",
      "status = 'waiting' && season = {:s}",
      "queued_at",
      100,
      0,
      { s: season }
    );
  } catch (e) {
    return [];
  }
}

// 완화 레벨 계산
function CKCalculateRelaxLevel(oldestQueuedAt, settings) {
  if (!oldestQueuedAt) return 0;
  const waitMs = Date.now() - new Date(oldestQueuedAt).getTime();
  const waitMin = waitMs / 60000;
  return Math.max(0, Math.floor(waitMin / (settings.getInt("ck_relax_after_min") || 3)));
}

// 조합 생성 헬퍼: n개 중 k개 선택 (인덱스 배열 반환)
function CKGetCombinations(arr, k) {
  const result = [];
  function combine(start, current) {
    if (current.length === k) {
      result.push([...current]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      current.push(arr[i]);
      combine(i + 1, current);
      current.pop();
    }
  }
  combine(0, []);
  return result;
}

// 10명에서 최적 5:5 분할 (ELO 합 차이 최소) — 파티 무결성 보장
// players: [{user, elo, ..., party_id?}, ...] length = 10
function CKFindOptimalTeams(players) {
  if (!players || players.length !== 10) return null;

  // 1. ELO 오름차순 정렬
  const sorted = [...players].sort((a, b) => Number(a.elo || 0) - Number(b.elo || 0));

  // 2. 조합 평가 시 파티(같은 party_id)는 같은 팀에 속해야 함
  const indices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const combos = CKGetCombinations(indices, 5);

  let bestDiff = Infinity;
  let bestTeamAIndices = null;

  for (const combo of combos) {
    if (combo[0] !== 0) continue;

    const inA = {};
    for (const i of combo) inA[i] = true;

    // 파티 무결성: 같은 파티가 A/B 에 분리되면 스킵
    const partySide = {};
    let valid = true;
    for (let i = 0; i < 10; i++) {
      const pid = sorted[i].party_id || "";
      if (!pid) continue;
      const side = inA[i] ? "A" : "B";
      if (partySide[pid] && partySide[pid] !== side) {
        valid = false;
        break;
      }
      partySide[pid] = side;
    }
    if (!valid) continue;

    const teamA = combo.map((i) => sorted[i]);
    const teamB = sorted.filter((_, i) => !combo.includes(i));

    const sumA = CKEloSum(teamA);
    const sumB = CKEloSum(teamB);
    const diff = Math.abs(sumA - sumB);

    if (diff < bestDiff) {
      bestDiff = diff;
      bestTeamAIndices = combo;
    }
  }

  if (!bestTeamAIndices) return null;

  const teamA = bestTeamAIndices.map((i) => sorted[i]);
  const teamB = sorted.filter((_, i) => !bestTeamAIndices.includes(i));

  return { teamA, teamB, eloDiff: bestDiff };
}

// 매칭 룸 생성
function CKCreateMatchRoom(teamA, teamB, season, settings) {
  const col = $app.findCollectionByNameOrId("match_rooms");
  const room = new Record(col);

  const eloSumA = CKEloSum(teamA);
  const eloSumB = CKEloSum(teamB);

  room.set("season", season);
  room.set("team_a", teamA);
  room.set("team_b", teamB);
  room.set("elo_sum_a", eloSumA);
  room.set("elo_sum_b", eloSumB);
  room.set("elo_diff", Math.abs(eloSumA - eloSumB));
  room.set("room_master", teamA[0]?.user || "");
  room.set("status", "ready");
  room.set("room_code", "");
  room.set("verify_attempts", 0);

  $app.save(room);
  return room;
}

// 큐 레코드들을 matched로 업데이트 + battle_id 연결
function CKUpdateQueueMatched(queueRecords, roomId) {
  for (const q of queueRecords) {
    q.set("status", "matched");
    q.set("battle_id", roomId);
    $app.save(q);
  }
}

// 메인 매칭 드레인 함수 (크론에서 30초마다 호출)
function CKRunMatchmakingDrain() {
  const settings = CKGetSettings();
  if (!settings || settings.getBool("ck_matching_enabled") === false) return 0;

  const season = CKGetCurrentSeason();
  const waiting = CKGetWaitingQueue(season);
  if (waiting.length < 10) return 0;

  // 가장 오래 기다린 유저 기준 완화 레벨
  const oldestQueuedAt = Math.min(...waiting.map((w) => new Date(w.getString("queued_at") || "").getTime()));
  const relaxLevel = CKCalculateRelaxLevel(oldestQueuedAt, settings);
  const baseRange = settings.getInt("ck_match_elo_range") || 200;
  const relaxStep = settings.getInt("ck_relax_step") || 100;
  const maxEloDiff = baseRange + relaxLevel * relaxStep;

  CKLog("matchmaking", "드레인 시작", { waiting: waiting.length, relaxLevel, maxEloDiff });

  let matched = 0;
  // ELO 순 정렬 후 파티 원자 단위 그리디 배치
  // - 파티(party_id 있음)는 한 유닛으로 묶음 (경계 분리 금지)
  // - 솔로는 개별 유닛 (이전 버그: 전체 솔로를 하나의 유닛으로 묶어 size>5 필터에서 누락)
  const sorted = [...waiting].sort((a, b) => Number(a.getInt("elo") || 0) - Number(b.getInt("elo") || 0));

  const units = [];
  const byParty = {};
  for (const q of sorted) {
    const pid = q.getString("party_id") || "";
    if (!pid) {
      units.push({
        pid: "",
        recs: [q],
        size: 1,
        minElo: Number(q.getInt("elo") || 0),
      });
    } else {
      if (!byParty[pid]) byParty[pid] = [];
      byParty[pid].push(q);
    }
  }
  for (const pid of Object.keys(byParty)) {
    const recs = byParty[pid];
    if (recs.length > 5) continue; // 비정상 파티 방어
    units.push({
      pid: pid,
      recs: recs,
      size: recs.length,
      minElo: Math.min.apply(
        null,
        recs.map((r) => Number(r.getInt("elo") || 0))
      ),
    });
  }
  units.sort((a, b) => a.minElo - b.minElo);

  const batches = [];
  let curBatch = [];
  let curCount = 0;
  for (const u of units) {
    if (curCount + u.size > 10) {
      if (curCount > 0) batches.push(curBatch);
      curBatch = [];
      curCount = 0;
    }
    for (const r of u.recs) curBatch.push(r);
    curCount += u.size;
  }
  if (curCount > 0) batches.push(curBatch);

  for (const batchRaw of batches) {
    if (batchRaw.length !== 10) continue; // 부분 배치는 대기열 유지

    const batch = [...batchRaw].sort((a, b) => Number(a.getInt("elo") || 0) - Number(b.getInt("elo") || 0));
    const batchEloDiff = Number(batch[9].getInt("elo") || 0) - Number(batch[0].getInt("elo") || 0);

    if (batchEloDiff > maxEloDiff) {
      CKLog("matchmaking", "스프레드 초과로 스킵", { batchEloDiff, maxEloDiff });
      continue;
    }

    // 후보군 구성
    const candidates = batch.map((q) => ({
      user: q.getString("user"),
      elo: Number(q.getInt("elo") || 0),
      riot_id: "", // 랭킹에서 채워야 함
      puuid: "",
      role: null,
      party_id: q.getString("party_id") || "",
    }));

    // 랭킹에서 riot_id, puuid 보강
    for (const c of candidates) {
      try {
        const ranking = $app.findFirstRecordByFilter("rankings", "user = {:u} && season = {:s}", { u: c.user, s: season });
        if (ranking) {
          c.riot_id = ranking.getString("riot_id") || "";
          c.puuid = ranking.getString("puuid") || "";
        }
      } catch (e) {
        /* 무시 */
      }
    }

    // 최적 팀 분할
    const result = CKFindOptimalTeams(candidates);
    if (!result) continue;

    // 방 생성
    const room = CKCreateMatchRoom(result.teamA, result.teamB, season, settings);
    
    // 큐 업데이트
    CKUpdateQueueMatched(batch, room.id);

    matched++;
    CKLog("matchmaking", "매칭 성사", { roomId: room.id, eloDiff: result.eloDiff, relaxLevel });
  }

  return matched;
}

// 즉시 매칭 시도 (큐 진입 시 훅에서 호출)
function CKRunMatchmaking() {
  return CKRunMatchmakingDrain();
}

// 큐 취소 시 방 정리 + 나머지 큐 복구 (onRecordUpdate 훅에서 호출)
function CKHandleQueueCancel(battleId, userId) {
  try {
    // 파티 상태 복원
    try {
      const PartyLib = require(`${__hooks}/party-lib.js`);
      PartyLib.reopenPartiesForBattle(battleId);
    } catch (e) {
      /* 무시 */
    }
    const { CKAllUserIds, CKLog } = require(`${__hooks}/ck-utils.js`);
    // 방 조회
    const battle = $app.findRecordById("match_rooms", battleId);
    if (!battle) return;

    // 방이 ready 상태면 취소 처리
    if (battle.getString("status") === "ready") {
      battle.set("status", "cancelled");
      $app.save(battle);

      // 해당 방의 모든 큐 레코드를 waiting으로 복구
      const allUsers = CKAllUserIds(battle);
      for (const uid of allUsers) {
        const q = $app.findFirstRecordByFilter("match_queue", "battle_id = {:b} && user = {:u} && status = 'matched'", {
          b: battleId,
          u: uid,
        });
        if (q) {
          q.set("status", "waiting");
          q.set("battle_id", "");
          $app.save(q);
        }
      }
      CKLog("matchmaking", "방 취소 + 큐 복구", { battleId, userId });
    }
  } catch (e) {
    const { CKLog } = require(`${__hooks}/ck-utils.js`);
    CKLog("matchmaking", "큐 취소 처리 실패", { battleId, userId, error: String(e) });
  }
}

module.exports = {
  CKGetWaitingQueue,
  CKCalculateRelaxLevel,
  CKGetCombinations,
  CKFindOptimalTeams,
  CKCreateMatchRoom,
  CKUpdateQueueMatched,
  CKRunMatchmakingDrain,
  CKRunMatchmaking,
  CKHandleQueueCancel,
};