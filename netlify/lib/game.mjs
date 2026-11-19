// Core game-sync logic. `store` needs: get(key,{type:'json'}), setJSON(key,val), delete(key).
export const MAX_TEAMS = 12;
const tKey = (room, n) => `r-${room}-t${n}`;
const teacherKey = room => `r-${room}-teacher`;
const newRoom = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const freshTeacher = () => ({ teamCount: 7, start: 0, limit: 11, bonus: {}, adj: {}, escAt: {}, log: [] });
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

async function getJSON(store, key) {
  try { return await store.get(key, { type: 'json' }); } catch { return null; }
}
async function meta(store, now) {
  let m = await getJSON(store, 'meta');
  if (!m || !m.room) { m = { room: newRoom(), created: now }; await store.setJSON('meta', m); }
  return m;
}
const ok = json => ({ status: 200, json });
const bad = (status, json) => ({ status, json });

export async function handle({ store, method, path, body = {}, now = Date.now(), pin }) {
  const route = path.replace(/^\/api\/?/, '').replace(/\/$/, '');

  if (method === 'GET' && route === 'room') {
    const m = await meta(store, now);
    const T = await getJSON(store, teacherKey(m.room));
    return ok({ room: m.room, now, teamCount: (T && T.teamCount) || 7 });
  }

  if (method === 'GET' && route === 'state') {
    const m = await meta(store, now);
    const keys = Array.from({ length: MAX_TEAMS }, (_, i) => tKey(m.room, i + 1));
    const [teacher, ...recs] = await Promise.all([getJSON(store, teacherKey(m.room)), ...keys.map(k => getJSON(store, k))]);
    const teams = {};
    recs.forEach((r, i) => { teams[i + 1] = r ? { ...r, device: undefined, deviceTag: (r.device || '').slice(-4) } : null; });
    const T = teacher || freshTeacher(); if (!T.teamCount) T.teamCount = 7;
    return ok({ room: m.room, now, teacher: T, teams });
  }

  if (method === 'POST' && (route === 'claim' || route === 'report')) {
    const m = await meta(store, now);
    if (body.room !== m.room) return ok({ ok: false, reason: 'room', room: m.room });
    const team = clampInt(body.team, 0, MAX_TEAMS);
    const device = String(body.device || '').slice(0, 40);
    if (!team || !device) return bad(400, { ok: false, reason: 'bad' });
    const key = tKey(m.room, team);
    const old = await getJSON(store, key);
    if (old && old.device !== device && !(route === 'claim' && body.force)) {
      return ok({ ok: false, reason: 'taken' });
    }
    const keepOld = old && old.device === device;
    const rec = keepOld ? { ...old } : { team, device, joinedAt: now, stage: 0, stageAt: {}, digits: [], hints: 0, wrong: 0 };
    if (route === 'report') {
      const stage = clampInt(body.stage, 0, 5);
      for (let s = (rec.stage || 0) + 1; s <= stage; s++) if (!rec.stageAt[s]) rec.stageAt[s] = now;
      rec.stage = Math.max(rec.stage || 0, stage);
      rec.digits = Array.isArray(body.digits) ? body.digits.slice(0, 4).map(d => clampInt(d, 0, 9)) : rec.digits;
      rec.hints = clampInt(body.hints, 0, 99);
      rec.wrong = clampInt(body.wrong, 0, 999);
    }
    rec.updated = now;
    await store.setJSON(key, rec);
    return ok({ ok: true, room: m.room });
  }

  if (method === 'POST' && route === 'teacher') {
    if (!pin || String(body.pin || '') !== String(pin)) return bad(401, { ok: false, reason: 'pin' });
    let m = await meta(store, now);
    const action = body.action;
    if (action === 'check') return ok({ ok: true });
    if (action === 'newclass') {
      m = { room: newRoom(), created: now };
      await store.setJSON('meta', m);
      await store.setJSON(teacherKey(m.room), freshTeacher());
      return ok({ ok: true, room: m.room });
    }
    const tk = teacherKey(m.room);
    const T = (await getJSON(store, tk)) || freshTeacher();
    const n = clampInt(body.team, 0, MAX_TEAMS);
    const log = msg => { T.log.unshift({ at: now, msg }); T.log = T.log.slice(0, 80); };
    if (action === 'start') { if (!T.start) { T.start = now; log('🏁 遊戲開始'); } }
    else if (action === 'teams') {
      const before = T.teamCount || 7;
      T.teamCount = clampInt(before + (Number(body.delta) > 0 ? 1 : -1), 2, MAX_TEAMS);
      if (T.teamCount !== before) log(`組數改為 ${T.teamCount} 組`);
    }
    else if (action === 'limit') { T.limit = clampInt(T.limit + Number(body.delta || 0), 3, 30); }
    else if (action === 'bonus' && n) {
      const v = clampInt(body.value, -20, 20);
      T.bonus[n] = (T.bonus[n] || 0) + v;
      log(`第 ${n} 組 ${v > 0 ? '+' : ''}${v} ${String(body.why || '').slice(0, 20)}`);
    }
    else if (action === 'adj' && n) {
      const rec = await getJSON(store, tKey(m.room, n));
      const base = rec ? rec.stage || 0 : 0;
      const cur = clampInt(base + (T.adj[n] || 0), 0, 5);
      const next = clampInt(cur + (Number(body.delta) > 0 ? 1 : -1), 0, 5);
      T.adj[n] = next - base;
      if (next >= 5 && !(rec && rec.stageAt && rec.stageAt[5]) && !T.escAt[n]) T.escAt[n] = now;
      if (next < 5) delete T.escAt[n];
      log(`第 ${n} 組 老師手動${next > cur ? '加' : '減'}一關（現在 ${next >= 5 ? '已逃脫' : '過 ' + next + ' 關'}）`);
    }
    else if (action === 'release' && n) {
      await store.delete(tKey(m.room, n));
      delete T.adj[n]; delete T.escAt[n];
      log(`第 ${n} 組 已清除，可重新選組`);
    }
    else return bad(400, { ok: false, reason: 'action' });
    await store.setJSON(tk, T);
    return ok({ ok: true });
  }

  return bad(404, { ok: false, reason: 'route' });
}
