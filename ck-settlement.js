// CK 정산 엔진
// 매치 결과 기반 ELO ±25 적용, 랭킹 업데이트

const { CKGetSettings, CKGetCurrentSeason, CKNow, CKLog, CKSafeParse, CKEloSum, CKRankingOf, CKEnsureRanking, CKSoftResetElo } = require(`${__hooks}/ck-utils.js`);

// 정산 실행 (playerStats: 검증 시 수집된 10인 개인 스탯 — 관리자 강제판정 시 null)
function CKDoSettlement(room, match, playerStats) {
  const settings = CKGetSettings();
  if (!settings) return { ok: false, error: "Settings not found" };

  const eloK = settings.getInt("ck_elo_k") || 25;
  const season = room.getString("season") || CKGetCurrentSeason();

  // 승리 팀 판정 (verification 에서 side("a"/"b") 부여된 teams 전달)
  // teams: [{team_id, won, rounds_won, side}]
  const teamsArr = Array.isArray(match.teams) ? match.teams : [];
  let winner = "a";
  if (teamsArr.length === 2) {
    const wonTeam = teamsArr.find((t) => t.won === true);
    if (wonTeam && wonTeam.side) {
      winner = wonTeam.side;
    } else {
      const roundsA = Number(teamsArr.find((t) => t.side === "a")?.rounds_won || 0);
      const roundsB = Number(teamsArr.find((t) => t.side === "b")?.rounds_won || 0);
      winner = roundsA >= roundsB ? "a" : "b";
    }
  }

  const loser = winner === "a" ? "b" : "a";
  const teamA = CKSafeParse(room.getString("team_a"), []);
  const teamB = CKSafeParse(room.getString("team_b"), []);
  const winnerTeam = winner === "a" ? teamA : teamB;
  const loserTeam = winner === "a" ? teamB : teamA;

  // 스코어 기록 (승자 13, 패자 라운드 수)
  const winnerRounds = Number(teamsArr.find((t) => t.side === winner)?.rounds_won || 13);
  const loserRounds = Number(teamsArr.find((t) => t.side !== winner)?.rounds_won || 0);
  const scoreA = winner === "a" ? winnerRounds : loserRounds;
  const scoreB = winner === "b" ? winnerRounds : loserRounds;

  // ELO 델타 계산 및 랭킹 업데이트
  const deltas = {};
  const allPlayers = [...winnerTeam, ...loserTeam];

  for (const player of allPlayers) {
    const userId = player.user;
    const isWinner = winnerTeam.some((p) => p.user === userId);
    const delta = isWinner ? eloK : -eloK;
    deltas[userId] = delta;

    // 랭킹 업데이트 (트랜잭션성 보장을 위해 순차 처리)
    try {
      let ranking = CKRankingOf(userId, season);
      if (!ranking) {
        // 랭킹 없으면 생성 (초기 ELO 1000)
        ranking = CKEnsureRanking(userId, 1000, season);
      }

      const oldElo = Number(ranking.getInt("elo") || 1000);
      const newElo = oldElo + delta;

      ranking.set("elo", newElo);
      if (isWinner) {
        ranking.set("wins", Number(ranking.getInt("wins") || 0) + 1);
        const streak = ranking.getString("streak") || "";
        ranking.set("streak", streak + "W");
      } else {
        ranking.set("losses", Number(ranking.getInt("losses") || 0) + 1);
        const streak = ranking.getString("streak") || "";
        ranking.set("streak", streak + "L");
      }
      ranking.set("peak_elo", Math.max(Number(ranking.getInt("peak_elo") || oldElo), newElo));

      $app.save(ranking);
      CKLog("settlement", "랭킹 업데이트", { userId, oldElo, newElo, delta, isWinner });
    } catch (e) {
      CKLog("settlement", "랭킹 업데이트 실패", { userId, error: String(e) });
      return { ok: false, error: "Ranking update failed: " + String(e) };
    }
  }

  // 방 레코드 업데이트 (v4 metadata: match_id, map:{name})
  const mapRaw = match.metadata && match.metadata.map;
  const mapName = typeof mapRaw === "string" ? mapRaw : mapRaw && (mapRaw.name || mapRaw.id) || "";
  room.set("status", "finished");
  room.set("winner", winner);
  room.set("score_a", scoreA);
  room.set("score_b", scoreB);
  room.set("match_id", (match.metadata && match.metadata.match_id) || "");
  room.set("map", mapName);
  room.set("finished_at", (match.metadata && (match.metadata.game_start_in_iso || match.metadata.started_at)) || CKNow());
  room.set("elo_deltas", deltas);
  if (playerStats && typeof playerStats === "object" && Object.keys(playerStats).length > 0) {
    room.set("player_stats", playerStats);
  }

  $app.save(room);

  CKLog("settlement", "정산 완료", { roomId: room.id, winner, scoreA, scoreB, deltas });

  return { ok: true, winner, scoreA, scoreB, deltas, matchId: (match.metadata && match.metadata.match_id) || "" };
}

// 시즌 소프트 리셋 (관리자용)
function CKRunSeasonReset(newSeason) {
  const settings = CKGetSettings();
  if (!settings) return { ok: false, error: "Settings not found" };

  try {
    const rankings = $app.findRecordsByFilter("rankings", "season = {:s}", "elo", 5000, 0, { s: settings.getString("season") });
    let count = 0;
    for (const r of rankings) {
      const oldElo = Number(r.getInt("elo") || 1000);
      const newElo = CKSoftResetElo(oldElo);
      r.set("season", newSeason);
      r.set("elo", newElo);
      r.set("wins", 0);
      r.set("losses", 0);
      r.set("draws", 0);
      r.set("streak", "");
      r.set("peak_elo", Math.max(newElo, Number(r.getInt("peak_elo") || oldElo)));
      $app.save(r);
      count++;
    }
    // 시즌 설정 업데이트
    settings.set("season", newSeason);
    $app.save(settings);
    CKLog("settlement", "시즌 리셋 완료", { newSeason, count });
    return { ok: true, count, newSeason };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

module.exports = {
  CKDoSettlement,
  CKRunSeasonReset,
};