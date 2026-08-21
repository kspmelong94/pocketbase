// CK 패널티/매너 시스템
// 노쇼 신고, 매너 신고, 페널티 만료, 매너 점수 자연 회복

const { CKGetSettings, CKGetCurrentSeason, CKNow, CKLog, CKSafeParse, CKAllUserIds, CKTeamOf } = require(`${__hooks}/ck-utils.js`);

// 페널티 체크 (큐 진입 시)
function CKCheckPenalty(userId) {
  try {
    const penalty = $app.findFirstRecordByFilter(
      "penalties",
      "user = {:u} && penalty_until > {:now} && (type = 'no_show' || type = 'manner')",
      "penalty_until",
      1,
      { u: userId, now: CKNow() }
    );
    if (penalty) {
      return {
        blocked: true,
        penalty: {
          type: penalty.getString("type"),
          reason: penalty.getString("reason"),
          penalty_until: penalty.getString("penalty_until"),
        },
        message: `페널티로 인해 매칭할 수 없습니다. (해제: ${penalty.getString("penalty_until")})`,
      };
    }
  } catch (e) {
    /* 무시 */
  }
  return { blocked: false };
}

// 노쇼 신고 처리
function CKHandleNoShowReport(room, reporterId, targetId) {
  const settings = CKGetSettings();
  if (!settings) return { ok: false, error: "Settings not found" };

  const graceMin = settings.getInt("no_show_grace_min") || 5;
  const createdAt = new Date(room.getString("created") || "").getTime();
  if (!createdAt || Date.now() - createdAt < graceMin * 60000) {
    return { ok: false, error: `아직 노쇼 유예 시간(${graceMin}분)이 지나지 않았습니다.` };
  }

  // 게임 시작됐으면 노쇼 신고 불가
  if (room.getString("playing_at")) {
    return { ok: false, error: "이미 게임이 시작되었습니다." };
  }

  // 대상 유저가 방 참가자인지 확인
  const allUsers = CKAllUserIds(room);
  if (!allUsers.includes(targetId)) {
    return { ok: false, error: "대상 유저는 이 방의 참가자가 아닙니다." };
  }

  // 신고자도 참가자인지 확인
  if (!allUsers.includes(reporterId)) {
    return { ok: false, error: "참가자만 신고할 수 있습니다." };
  }

  // 이미 페널티 있는지 확인
  let existing = null;
  try {
    existing = $app.findFirstRecordByFilter(
      "penalties",
      "user = {:u} && type = 'no_show' && penalty_until > {:now}",
      { u: targetId, now: CKNow() }
    );
  } catch (e) {
    existing = null;
  }

  const isFirstOffense = !existing;
  const penaltyMin = isFirstOffense ? (settings.getInt("no_show_penalty_min") || 15) : (settings.getInt("no_show_penalty_max_hours") || 24) * 60;
  const penaltyUntil = new Date(Date.now() + penaltyMin * 60000).toISOString();

  // 페널티 생성
  try {
    const col = $app.findCollectionByNameOrId("penalties");
    const penalty = new Record(col);
    penalty.set("user", targetId);
    penalty.set("type", "no_show");
    penalty.set("reason", `노쇼 신고 (by ${reporterId})`);
    penalty.set("penalty_until", penaltyUntil);
    penalty.set("match_room", room.id);
    penalty.set("created_by", reporterId);
    penalty.set("auto", true);
    $app.save(penalty);
  } catch (e) {
    return { ok: false, error: "페널티 생성 실패: " + String(e) };
  }

  CKLog("penalties", "노쇼 페널티 부과", { targetId, reporterId, roomId: room.id, isFirstOffense, penaltyUntil });

  return {
    ok: true,
    penalty: {
      type: "no_show",
      penalty_until: penaltyUntil,
      isFirstOffense,
    },
    message: `노쇼 신고가 접수되었습니다. 대상 유저는 ${penaltyMin}분간 매칭이 차단됩니다.`,
  };
}

// 매너 신고 처리
function CKHandleMannerReport(room, reporterId, targetId, reason) {
  const settings = CKGetSettings();
  if (!settings) return { ok: false, error: "Settings not found" };

  // 경기 종료된 방만 가능
  if (room.getString("status") !== "finished") {
    return { ok: false, error: "종료된 경기만 신고 가능합니다." };
  }

  // 24시간 경과 확인
  const finishedAt = new Date(room.getString("finished_at") || "").getTime();
  if (!finishedAt || Date.now() - finishedAt > 24 * 60 * 60 * 1000) {
    return { ok: false, error: "신고 가능 기간(24시간)이 지났습니다." };
  }

  // 대상 유저가 방 참가자인지 확인
  const allUsers = CKAllUserIds(room);
  if (!allUsers.includes(targetId)) {
    return { ok: false, error: "대상 유저는 이 방의 참가자가 아닙니다." };
  }

  // 신고자도 참가자이고, 자기 자신 신고 불가
  if (!allUsers.includes(reporterId)) {
    return { ok: false, error: "참가자만 신고할 수 있습니다." };
  }
  if (reporterId === targetId) {
    return { ok: false, error: "자기 자신을 신고할 수 없습니다." };
  }

  // 매너 점수 조회/생성
  let mannerScore;
  try {
    mannerScore = $app.findFirstRecordByFilter("manner_scores", "user = {:u}", { u: targetId });
  } catch (e) {
    mannerScore = null;
  }

  if (!mannerScore) {
    const col = $app.findCollectionByNameOrId("manner_scores");
    mannerScore = new Record(col);
    mannerScore.set("user", targetId);
    mannerScore.set("score", 100);
    mannerScore.set("reports", []);
    mannerScore.set("last_decay_at", CKNow());
  }

  // 점수 차감
  const currentScore = Number(mannerScore.getInt("score") || 100);
  const newScore = Math.max(0, currentScore - 10);
  mannerScore.set("score", newScore);

  // 신고 내역 추가
  const reports = CKSafeParse(mannerScore.getString("reports"), []);
  reports.push({
    from: reporterId,
    reason: reason || "비매너",
    at: CKNow(),
    match_room: room.id,
  });
  mannerScore.set("reports", reports);
  $app.save(mannerScore);

  // 정지 임계값 확인
  const suspendThreshold = settings.getInt("manner_suspend_threshold") || 40;
  let suspended = false;
  if (newScore < suspendThreshold) {
    // 영구 정지 페널티 생성
    try {
      const col = $app.findCollectionByNameOrId("penalties");
      const penalty = new Record(col);
      penalty.set("user", targetId);
      penalty.set("type", "manner");
      penalty.set("reason", `매너 점수 ${newScore}로 서비스 정지`);
      penalty.set("penalty_until", ""); // null = 영구
      penalty.set("match_room", room.id);
      penalty.set("created_by", "system");
      penalty.set("auto", true);
      $app.save(penalty);
      suspended = true;
    } catch (e) {
      CKLog("penalties", "매너 정지 페널티 생성 실패", { error: String(e) });
    }
  }

  CKLog("penalties", "매너 신고 처리", { targetId, reporterId, roomId: room.id, oldScore: currentScore, newScore, suspended });

  return {
    ok: true,
    mannerScore: newScore,
    suspended,
    message: `신고가 접수되었습니다. 대상 유저 매너 점수: ${newScore}${suspended ? " (서비스 정지됨)" : ""}`,
  };
}

// 크론: 페널티 만료 해제 (시간마다)
function CKDecayPenalties() {
  try {
    const expired = $app.findRecordsByFilter("penalties", "penalty_until != '' && penalty_until < {:now}", "penalty_until", 100, 0, { now: CKNow() });
    let count = 0;
    for (const p of expired) {
      // 만료된 페널티 삭제 (또는 비활성화 표시)
      $app.delete(p);
      count++;
    }
    if (count > 0) CKLog("penalties", "페널티 만료 해제", { count });
    return count;
  } catch (e) {
    return 0;
  }
}

// 크론: 매너 점수 자연 회복 (일일)
function CKDecayMannerScores() {
  const settings = CKGetSettings();
  if (!settings) return 0;
  const decayAmount = settings.getInt("manner_decay_per_day") || 5;

  try {
    const scores = $app.findRecordsByFilter("manner_scores", "score < 100", "score", 500, 0);
    let count = 0;
    for (const m of scores) {
      const lastDecay = new Date(m.getString("last_decay_at") || "").getTime();
      const daysPassed = Math.floor((Date.now() - lastDecay) / (24 * 60 * 60 * 1000));
      if (daysPassed > 0) {
        const currentScore = Number(m.getInt("score") || 0);
        const newScore = Math.min(100, currentScore + decayAmount * daysPassed);
        m.set("score", newScore);
        m.set("last_decay_at", CKNow());
        $app.save(m);
        count++;
      }
    }
    if (count > 0) CKLog("penalties", "매너 점수 회복", { count, decayAmount });
    return count;
  } catch (e) {
    return 0;
  }
}

// 매너 점수 조회
function CKGetMannerScore(userId) {
  try {
    const m = $app.findFirstRecordByFilter("manner_scores", "user = {:u}", { u: userId });
    return m ? { score: m.getInt("score"), reports: CKSafeParse(m.getString("reports"), []) } : { score: 100, reports: [] };
  } catch (e) {
    return { score: 100, reports: [] };
  }
}

module.exports = {
  CKCheckPenalty,
  CKHandleNoShowReport,
  CKHandleMannerReport,
  CKDecayPenalties,
  CKDecayMannerScores,
  CKGetMannerScore,
};