// CK 정산 엔진
// 매치 결과 기반 ELO ±25 적용, 랭킹 업데이트

const { CKGetSettings, CKGetCurrentSeason, CKNow, CKLog, CKSafeParse, CKEloSum, CKRankingOf, CKEnsureRanking, CKSoftResetElo } = require(`${__hooks}/ck-utils.js`);

// 정산 실행
async function CKDoSettlement(room, match) {
  const settings = CKGetSettings();
  if (!settings) return { ok: false, error: "Settings not found" };

  const eloK = settings.getInt("ck_elo_k") || 25;
  const season = room.getString("season") || CKGetCurrentSeason();

  // 승리 팀 판정
  // HenrikDev match 구조: teams[0], teams[1] 중 won=true인 팀
  let winner = "a";
  if (match.teams && match.teams.length === 2) {
    if (match.teams[1]?.won === true) winner = "b";
    else if (match.teams[0]?.won === true) winner = "a";
    else {
      // won 필드 없으면 라운드 수 비교
      const roundsA = match.teams[0]?.rounds_won || 0;
      const roundsB = match.teams[1]?.rounds_won || 0;
      winner = roundsA > roundsB ? "a" : "b";
    }
  }

  const loser = winner === "a" ? "b" : "a";
  const teamA = CKSafeParse(room.getString("team_a"), []);
  const teamB = CKSafeParse(room.getString("team_b"), []);
  const winnerTeam = winner === "a" ? teamA : teamB;
  const loserTeam = winner === "a" ? teamB : teamA;

  // 스코어 기록 (승자 13, 패자 라운드 수)
  const winnerRounds = match.teams?.find((t) => t.won === true)?.rounds_won || 13;
  const loserRounds = match.teams?.find((t) => t.won !== true)?.rounds_won || 0;
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

  // 방 레코드 업데이트
  room.set("status", "finished");
  room.set("winner", winner);
  room.set("score_a", scoreA);
  room.set("score_b", scoreB);
  room.set("match_id", match.metadata?.matchid || "");
  room.set("map", match.metadata?.map || "");
  room.set("finished_at", match.metadata?.game_start_patched || CKNow());
  room.set("elo_deltas", deltas);

  $app.save(room);

  CKLog("settlement", "정산 완료", { roomId: room.id, winner, scoreA, scoreB, deltas });

  return { ok: true, winner, scoreA, scoreB, deltas, matchId: match.metadata?.matchid };
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