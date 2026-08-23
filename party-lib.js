// CK 파티 로직 — 핸들러 격리 컨텍스트에서 require 되므로 $app 은 실행 시점에 존재함
const { CKGetCurrentSeason } = require(`${__hooks}/ck-utils.js`);

const PARTY_MAX = 5;

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 6; i++) c += chars.charAt(Math.floor(Math.random() * chars.length));
  return c;
}

function parseMembers(raw) {
  try {
    if (typeof raw === "string") {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    }
    if (Array.isArray(raw)) return raw;
  } catch (e) {
    /* 무시 */
  }
  return [];
}

function joinedMembers(members) {
  return members.filter((m) => m.state === "leader" || m.state === "joined");
}

// 활성 파티 목록 (정렬은 -id — created 필드 부재 컬렉션 방어)
function getActiveParties() {
  try {
    return $app.findRecordsByFilter("parties", "status != 'disbanded'", "-id", 200, 0);
  } catch (e) {
    return [];
  }
}

// 내가 리더/합류 상태인 활성 파티
function findUserParty(userId) {
  for (const p of getActiveParties()) {
    const members = parseMembers(p.getString("members"));
    const mine = members.find((m) => m.user === userId && (m.state === "leader" || m.state === "joined"));
    if (mine) return { record: p, entry: mine, members: members };
  }
  return null;
}

// 내가 초대받은 파티 목록
function findPendingInvites(userId) {
  const out = [];
  for (const p of getActiveParties()) {
    const members = parseMembers(p.getString("members"));
    if (members.some((m) => m.user === userId && m.state === "invited")) out.push(p);
  }
  return out;
}

// 멤버 정보 보강 뷰 (rankings 에서 닉네임·riot_id·elo 조회)
function buildPartyView(record) {
  const members = parseMembers(record.getString("members"));
  const season = CKGetCurrentSeason();
  const enriched = members.map((m) => {
    let nickname = "";
    let riot_id = "";
    let elo = 0;
    try {
      const rk = $app.findFirstRecordByFilter("rankings", "user = {:u} && season = {:s}", {
        u: m.user,
        s: season,
      });
      if (rk) {
        nickname = rk.getString("nickname");
        riot_id = rk.getString("riot_id");
        elo = Number(rk.getInt("elo") || 0);
      }
    } catch (e) {
      /* 무시 */
    }
    return { user: m.user, state: m.state || "", nickname: nickname, riot_id: riot_id, elo: elo };
  });
  return {
    id: record.id,
    code: record.getString("code"),
    leader: record.getString("leader"),
    status: record.getString("status"),
    season: record.getString("season"),
    created: record.getString("created"),
    members: enriched,
  };
}

// 경기 종료/취소 시 연관 파티를 open 으로 복원
function reopenPartiesForBattle(battleId) {
  let qs = [];
  try {
    qs = $app.findRecordsByFilter("match_queue", "battle_id = {:b}", "-id", 20, 0, { b: battleId });
  } catch (e) {
    return;
  }
  const seen = {};
  for (const q of qs) {
    const pid = q.getString("party_id") || "";
    if (!pid || seen[pid]) continue;
    seen[pid] = true;
    try {
      const pr = $app.findRecordById("parties", pid);
      if (pr.getString("status") === "queued") {
        pr.set("status", "open");
        $app.save(pr);
      }
    } catch (e) {
      /* 무시 */
    }
  }
}

// 유저의 waiting 큐 취소 (라우트 격리 컨텍스트 대비 lib 화)
function cancelUserQueue(season, uid) {
  try {
    const q = $app.findFirstRecordByFilter(
      "match_queue",
      "user = {:u} && season = {:s} && status = 'waiting'",
      { u: uid, s: season }
    );
    if (q) {
      q.set("status", "cancelled");
      $app.save(q);
    }
  } catch (e) {
    /* 큐 없음 무시 */
  }
}

module.exports = {
  PARTY_MAX: PARTY_MAX,
  genCode: genCode,
  parseMembers: parseMembers,
  joinedMembers: joinedMembers,
  getActiveParties: getActiveParties,
  findUserParty: findUserParty,
  findPendingInvites: findPendingInvites,
  buildPartyView: buildPartyView,
  reopenPartiesForBattle: reopenPartiesForBattle,
  cancelUserQueue: cancelUserQueue,
};