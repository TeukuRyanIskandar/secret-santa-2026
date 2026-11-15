// Multi-person tests: an organizer and several teammates, each acting with their own link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCore, drawPairs } from "../lib/core.js";
import { memoryStore } from "../lib/store-memory.js";

const HUNT = "2026-12-23T00:00:00+08:00";

// `clock.set(iso)` moves time for the server, so tests can step across hunt start.
function fakeClock(iso = "2026-11-20T09:00:00+08:00") {
  let t = new Date(iso);
  const clock = () => new Date(t);
  clock.set = (x) => (t = new Date(x));
  return clock;
}

async function setupTeam(names = ["Aisyah", "Daniel", "Mei Ling", "Snitco"]) {
  const clock = fakeClock();
  const core = makeCore(memoryStore(), { setupKey: "k", huntStart: HUNT, clock });
  const { token: ryan } = await core.setup({ setupKey: "k", name: "Ryan" });
  const snap = await core.handle({ token: ryan, action: "addPeople", names });
  const tokens = { Ryan: ryan };
  for (const p of snap.people) {
    const l = snap.admin.links.find((x) => x.id === p.id);
    if (p.name !== "Ryan") tokens[p.name] = l.token;
  }
  const as = (name) => (action, args = {}) => core.handle({ token: tokens[name], action, ...args });
  return { core, tokens, as, clock };
}
// Wishlist items are tagged per person but never contain the name, so "name not in JSON" checks stay meaningful.
const tag = (who) => Buffer.from(who).toString("hex");
const hints3 = (who) => [`wish ${tag(who)} 1`, `wish ${tag(who)} 2`, `wish ${tag(who)} 3`];
const rejects = (p, status) => assert.rejects(p, (e) => e.status === status);

test("setup creates exactly one first organizer, guarded by the key", async () => {
  const core = makeCore(memoryStore(), { setupKey: "k" });
  await rejects(core.setup({ setupKey: "wrong", name: "X" }), 403);
  await core.setup({ setupKey: "k", name: "Ryan" });
  await rejects(core.setup({ setupKey: "k", name: "Intruder" }), 409);
  await rejects(makeCore(memoryStore(), {}).setup({ setupKey: "", name: "X" }), 503);
});

test("bad or missing links are refused", async () => {
  const { core } = await setupTeam();
  await rejects(core.handle({ action: "me" }), 401);
  await rejects(core.handle({ token: "nope", action: "me" }), 401);
  await rejects(core.handle({ token: "nope", action: "__proto__" }), 400);
});

test("members cannot use organizer actions", async () => {
  const { as } = await setupTeam();
  const me = await as("Daniel")("me");
  assert.equal(me.admin, undefined, "no admin data for members");
  for (const [action, args] of [
    ["addPeople", { names: ["Fake"] }],
    ["draw", {}],
    ["setTv", { open: true }],
    ["setAdmin", { id: me.me.id, isAdmin: true }],
    ["resetLink", { id: me.me.id }],
    ["removePerson", { id: me.me.id }],
  ]) await rejects(as("Daniel")(action, args), 403);
});

test("full flow: wishlist, draw, numbers, privacy before the hunt", async () => {
  const { as, tokens } = await setupTeam();
  const everyone = Object.keys(tokens);

  // Validation
  await rejects(as("Aisyah")("saveHints", { hints: ["a", "", "c"] }), 400);
  await rejects(as("Aisyah")("saveHide", { clues: "x", spot: "y" }), 409); // before draw

  // Not enough people yet
  await as("Aisyah")("saveHints", { hints: hints3("Aisyah") });
  await rejects(as("Ryan")("draw"), 409);

  for (const n of everyone) await as(n)("saveHints", { hints: hints3(n) });

  // Before the draw, nobody sees anyone else's wishlist and nobody has a number.
  const pre = await as("Daniel")("me");
  assert.equal(pre.myDraw, null);
  assert.equal(pre.me.number, null);
  assert.equal(pre.myClues, null);
  assert.ok(!JSON.stringify(pre).includes(hints3("Aisyah")[0]), "other people's wishlists must not leak");

  await as("Ryan")("draw");

  const views = {};
  for (const n of everyone) views[n] = await as(n)("me");
  const N = everyone.length;
  const range = [...Array(N).keys()].map((i) => i + 1);
  const sorted = (xs) => xs.slice().sort((a, b) => a - b);

  // Numbers are a permutation of 1..N, both as owned and as seen by Santas.
  assert.deepEqual(sorted(everyone.map((n) => views[n].me.number)), range);
  assert.deepEqual(sorted(everyone.map((n) => views[n].myDraw.receiverNumber)), range);

  for (const n of everyone) {
    const v = views[n];
    // Who is n's receiver? The person whose own number is the one n sees.
    const r = everyone.find((m) => views[m].me.number === v.myDraw.receiverNumber);
    assert.notEqual(r, n, `${n} drew themselves`);
    assert.deepEqual(v.myDraw.hints, hints3(r), "own number matches what one's Santa sees");

    // The Santa's view never names the receiver.
    assert.deepEqual(Object.keys(v.myDraw).sort(), ["hints", "receiverNumber"]);
    const rid = views[r].me.id;
    for (const part of [v.myDraw, v.myHide, v.myClues, v.state]) {
      const json = JSON.stringify(part);
      assert.ok(!json.includes(rid), `${n}'s snapshot leaks receiver id`);
      assert.ok(!json.includes(r), `${n}'s snapshot leaks receiver name`);
    }
    // Nothing else in the snapshot carries a number.
    for (const p of v.people) {
      assert.deepEqual(Object.keys(p).sort(), ["found", "hintCount", "id", "inDraw", "name"]);
      assert.equal(p.inDraw, true);
    }
    // Only my wishlist and my receiver's are visible.
    const json = JSON.stringify(v);
    for (const other of everyone) {
      if (other === n || other === r) continue;
      assert.ok(!json.includes(hints3(other)[0]), `${n} can see ${other}'s wishlist`);
    }
    if (n !== "Ryan") assert.equal(v.admin, undefined);
    assert.equal(v.state.huntStarted, false);
    assert.equal(v.myClues, null, "clues hidden before the hunt");
  }

  // Organizer before the hunt: readiness by number only, no names, no ids.
  const org = views.Ryan.admin;
  assert.deepEqual(org.gifts.map((g) => g.number), range, "sorted by number");
  for (const g of org.gifts) assert.deepEqual(Object.keys(g).sort(), ["hasClues", "hasSpot", "number"]);
  const giftsJson = JSON.stringify(org.gifts);
  for (const n of everyone) {
    assert.ok(!giftsJson.includes(views[n].me.id), "organizer gifts leak an id");
    assert.ok(!giftsJson.includes(n), "organizer gifts leak a name");
  }
  for (const l of org.links) assert.deepEqual(Object.keys(l).sort(), ["id", "isAdmin", "token"]);
});

test("hiding, clues unlock on hunt day, organizers see names only from hunt start", async () => {
  const { as, tokens, clock } = await setupTeam();
  const everyone = Object.keys(tokens);
  for (const n of everyone) await as(n)("saveHints", { hints: hints3(n) });
  await as("Ryan")("draw");
  const views = {};
  for (const n of everyone) views[n] = await as(n)("me");
  const receiverOf = (n) => everyone.find((m) => views[m].me.number === views[n].myDraw.receiverNumber);

  await rejects(as("Daniel")("saveHide", { clues: "", spot: "Behind the printer" }), 400);
  await rejects(as("Daniel")("saveHide", { clues: "Where paper lives", spot: "  " }), 400);
  const saved = await as("Daniel")("saveHide", { clues: "Where paper lives", spot: "Behind the printer" });
  assert.equal(saved.myHide.clues, "Where paper lives");
  assert.equal(saved.myHide.spot, "Behind the printer");

  const r = receiverOf("Daniel");
  const num = views.Daniel.myDraw.receiverNumber;

  // Before the hunt: organizer sees readiness, not the text; receiver sees nothing.
  let org = await as("Ryan")("me");
  assert.deepEqual(org.admin.gifts.find((g) => g.number === num), { number: num, hasClues: true, hasSpot: true });
  assert.ok(!JSON.stringify(org.admin).includes("printer"));
  assert.ok(!JSON.stringify(org.admin).includes("paper"));
  clock.set("2026-12-22T23:59:59+08:00");
  const early = await as(r)("me");
  assert.equal(early.state.huntStarted, false);
  assert.equal(early.myClues, null);
  assert.ok(!JSON.stringify(early).includes("paper"), "clues leak before the hunt");
  for (const n of everyone) {
    if (n === "Daniel") continue;
    assert.ok(!JSON.stringify(await as(n)("me")).includes("printer"), `${n} sees the hiding spot`);
  }

  // Hunt starts.
  clock.set(HUNT);
  const day = await as(r)("me");
  assert.equal(day.state.huntStarted, true);
  assert.equal(day.state.huntStart, new Date(HUNT).toISOString());
  assert.deepEqual(day.myClues, { clues: "Where paper lives" });
  // (The receiver may be an organizer, who legitimately sees spots in `admin` from hunt start.)
  assert.ok(!JSON.stringify({ ...day, admin: undefined }).includes("printer"), "exact spot is organizers only");

  // Someone whose Santa wrote nothing gets clues: null.
  const lonely = everyone.find((n) => n !== r);
  assert.deepEqual((await as(lonely)("me")).myClues, { clues: null });

  org = await as("Ryan")("me");
  const g = org.admin.gifts.find((x) => x.number === num);
  assert.deepEqual(g, {
    number: num, hasClues: true, hasSpot: true,
    receiverId: views[r].me.id, receiverName: r, clues: "Where paper lives", spot: "Behind the printer",
  });
  assert.equal(org.admin.gifts.length, everyone.length);

  // Members still never see other people's numbers or the gift list.
  const member = await as("Snitco")("me");
  assert.equal(member.admin, undefined);
  for (const p of member.people) assert.equal(p.number, undefined);
});

test("found: self without approval, organizer for anyone", async () => {
  const { as, tokens } = await setupTeam();
  for (const n of Object.keys(tokens)) await as(n)("saveHints", { hints: hints3(n) });
  await as("Ryan")("draw");
  const aisyahId = (await as("Aisyah")("me")).me.id;
  await rejects(as("Daniel")("setFound", { id: aisyahId, found: true }), 403);
  const found = await as("Aisyah")("setFound", { found: true });
  assert.equal(found.people.find((p) => p.id === aisyahId).found, true);
  const undone = await as("Ryan")("setFound", { id: aisyahId, found: false });
  assert.equal(undone.people.find((p) => p.id === aisyahId).found, false);
});

test("removed actions are gone", async () => {
  const { as } = await setupTeam();
  const me = await as("Ryan")("me");
  await rejects(as("Ryan")("setApproved", { id: me.me.id, approved: true }), 400);
  await rejects(as("Ryan")("setReveal", { on: true }), 400);
  await rejects(as("Ryan")("saveSpot", { spot: "x" }), 400);
});

test("TV board: secret link, names and found only", async () => {
  const { core, as, tokens, clock } = await setupTeam();
  const tv = (code) => core.handle({ action: "tv", code });
  await rejects(tv("anything"), 403); // off by default
  await rejects(as("Daniel")("setTv", { open: true }), 403);
  assert.equal((await as("Ryan")("me")).admin.tvCode, null);

  const code = (await as("Ryan")("setTv", { open: true })).admin.tvCode;
  assert.ok(code);
  await rejects(tv("wrong"), 403);
  await rejects(tv(undefined), 403);

  // Before the draw: people with a saved wishlist.
  await as("Daniel")("saveHints", { hints: hints3("Daniel") });
  await as("Aisyah")("saveHints", { hints: hints3("Aisyah") });
  let board = await tv(code);
  assert.deepEqual(board, {
    people: [{ name: "Aisyah", found: false }, { name: "Daniel", found: false }],
    foundCount: 0, total: 2, huntStarted: false,
  });

  // After the draw: people in the draw, sorted by name; no ids or numbers anywhere.
  for (const n of Object.keys(tokens)) await as(n)("saveHints", { hints: hints3(n) });
  await as("Ryan")("draw");
  await as("Mei Ling")("setFound", { found: true });
  clock.set(HUNT);
  board = await tv(code);
  const names = Object.keys(tokens).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(board.people.map((p) => p.name), names);
  assert.equal(board.foundCount, 1);
  assert.equal(board.total, names.length);
  assert.equal(board.huntStarted, true);
  assert.deepEqual(Object.keys(board).sort(), ["foundCount", "huntStarted", "people", "total"]);
  for (const p of board.people) assert.deepEqual(Object.keys(p).sort(), ["found", "name"]);
  const json = JSON.stringify(board);
  const org = await as("Ryan")("me");
  for (const p of org.people) assert.ok(!json.includes(p.id), "TV board leaks an id");
  assert.ok(!json.includes(code), "TV board echoes its code");

  // A new link replaces the old one; turning it off kills it.
  const code2 = (await as("Ryan")("setTv", { open: true })).admin.tvCode;
  await rejects(tv(code), 403);
  await tv(code2);
  await as("Ryan")("setTv", { open: false });
  await rejects(tv(code2), 403);
});

test("a second organizer can run things; links can be reset", async () => {
  const { as, tokens } = await setupTeam();
  const snitco = await as("Snitco")("me");
  await as("Ryan")("setAdmin", { id: snitco.me.id, isAdmin: true });
  const s2 = await as("Snitco")("me");
  assert.equal(s2.me.isAdmin, true);
  assert.ok(s2.admin);

  const daniel = await as("Daniel")("me");
  await as("Snitco")("resetLink", { id: daniel.me.id });
  await rejects(as("Daniel")("me"), 401); // old link dead
  await rejects(as("Ryan")("setAdmin", { id: (await as("Ryan")("me")).me.id, isAdmin: false }), 400);
});

test("removing someone in the draw flags it for a redraw", async () => {
  const { as, tokens } = await setupTeam();
  for (const n of Object.keys(tokens)) await as(n)("saveHints", { hints: hints3(n) });
  await as("Ryan")("draw");
  const mei = await as("Mei Ling")("me");
  await as("Ryan")("removePerson", { id: mei.me.id });
  let org = await as("Ryan")("me");
  assert.equal(org.admin.drawBroken, true);
  await as("Ryan")("draw");
  org = await as("Ryan")("me");
  assert.equal(org.admin.drawBroken, false);
  assert.equal(org.state.drawnCount, 4);
});

test("drawPairs: always a valid, fair draw", () => {
  for (const n of [2, 3, 18]) {
    for (let t = 0; t < 3000; t++) {
      const ids = [...Array(n).keys()].map(String);
      const pairs = drawPairs(ids);
      assert.equal(pairs.length, n);
      assert.equal(new Set(pairs.map((p) => p.receiver)).size, n);
      assert.ok(pairs.every((p) => p.santa !== p.receiver));
      assert.deepEqual(pairs.map((p) => p.number).sort((a, b) => a - b), ids.map((_, i) => i + 1));
    }
  }
});

test("join link: people add themselves; closes at the draw; members can't control it", async () => {
  const { core, as } = await setupTeam(["Daniel"]);
  const join = (code, name) => core.handle({ action: "join", code, name });

  await rejects(join("anything", "Zed"), 403); // off by default
  await rejects(as("Daniel")("setJoin", { open: true }), 403);
  assert.equal((await as("Daniel")("me")).admin, undefined, "members never see the join code");

  const code1 = (await as("Ryan")("setJoin", { open: true })).admin.joinCode;
  assert.ok(code1);
  await rejects(join("wrong", "Zed"), 403);
  await rejects(join(code1, "   "), 400);
  await rejects(join(code1, "daniel"), 409); // can't take over an existing person's spot

  const { token: zed } = await join(code1, "  Zed  ");
  const zedSnap = await core.handle({ token: zed, action: "me" });
  assert.equal(zedSnap.me.name, "Zed");
  assert.equal(zedSnap.me.isAdmin, false);
  assert.equal(zedSnap.admin, undefined);

  // A new join link replaces the old one.
  const code2 = (await as("Ryan")("setJoin", { open: true })).admin.joinCode;
  assert.notEqual(code2, code1);
  await rejects(join(code1, "Old"), 403);
  await join(code2, "New");

  // Drawing closes joining.
  for (const who of ["Ryan", "Daniel"]) await as(who)("saveHints", { hints: hints3(who) });
  await core.handle({ token: zed, action: "saveHints", hints: hints3("Zed") });
  const drawn = await as("Ryan")("draw");
  assert.equal(drawn.admin.joinCode, null);
  await rejects(join(code2, "Late"), 403);
});
