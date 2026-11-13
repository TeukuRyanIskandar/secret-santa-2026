// Multi-person tests: an organizer and several teammates, each acting with their own link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCore, drawPairs } from "../lib/core.js";
import { memoryStore } from "../lib/store-memory.js";

async function setupTeam(names = ["Aisyah", "Daniel", "Mei Ling", "Snitco"]) {
  const core = makeCore(memoryStore(), { setupKey: "k" });
  const { token: ryan } = await core.setup({ setupKey: "k", name: "Ryan" });
  const snap = await core.handle({ token: ryan, action: "addPeople", names });
  const tokens = { Ryan: ryan };
  for (const p of snap.people) {
    const l = snap.admin.links.find((x) => x.id === p.id);
    if (p.name !== "Ryan") tokens[p.name] = l.token;
  }
  const as = (name) => (action, args = {}) => core.handle({ token: tokens[name], action, ...args });
  return { core, tokens, as };
}
const hints3 = (who) => [`${who} hint 1`, `${who} hint 2`, `${who} hint 3`];
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
    ["setApproved", { id: me.me.id, approved: true }],
    ["setReveal", { on: true }],
    ["setAdmin", { id: me.me.id, isAdmin: true }],
    ["resetLink", { id: me.me.id }],
    ["removePerson", { id: me.me.id }],
  ]) await rejects(as("Daniel")(action, args), 403);
});

test("full flow: hints, draw, privacy, hiding, hunt, reveal", async () => {
  const { as, tokens } = await setupTeam();
  const everyone = Object.keys(tokens);

  // Validation
  await rejects(as("Aisyah")("saveHints", { hints: ["a", "", "c"] }), 400);
  await rejects(as("Aisyah")("saveSpot", { spot: "x" }), 409); // before draw

  // Not enough people yet
  await as("Aisyah")("saveHints", { hints: hints3("Aisyah") });
  await rejects(as("Ryan")("draw"), 409);

  for (const n of everyone) await as(n)("saveHints", { hints: hints3(n) });

  // Before the draw, nobody sees anyone else's hints.
  const pre = await as("Daniel")("me");
  assert.equal(pre.myDraw, null);
  assert.ok(!JSON.stringify(pre).includes("Aisyah hint"), "other people's hints must not leak");

  await as("Ryan")("draw");

  // Each person sees exactly their own receiver; receivers form a full permutation, no self-draws.
  const views = {};
  for (const n of everyone) views[n] = await as(n)("me");
  const receivers = everyone.map((n) => views[n].myDraw.name);
  assert.equal(new Set(receivers).size, everyone.length, "everyone receives exactly one gift");
  for (const n of everyone) {
    const v = views[n];
    assert.notEqual(v.myDraw.name, n, `${n} drew themselves`);
    assert.deepEqual(v.myDraw.hints, hints3(v.myDraw.name), "Santa sees receiver's hints");
    const json = JSON.stringify(v);
    for (const other of everyone) {
      if (other === n || other === v.myDraw.name) continue;
      assert.ok(!json.includes(`${other} hint`), `${n} can see ${other}'s hints`);
    }
    if (n !== "Ryan") assert.equal(v.admin, undefined);
    assert.equal(v.state.reveal, null, "pairs hidden before reveal");
    for (const p of v.people) assert.equal(p.token, undefined, "tokens never in people list");
  }

  // Organizer view never says who is whose Santa.
  const org = views.Ryan.admin;
  assert.equal(org.gifts.length, everyone.length);
  for (const g of org.gifts) assert.deepEqual(Object.keys(g).sort(), ["hidden", "receiverId", "receiverName", "spot"]);

  // Hiding spots: only organizers see them, keyed by receiver.
  await as("Daniel")("saveSpot", { spot: "Behind the printer" });
  const danielReceiver = views.Daniel.myDraw.name;
  const afterHide = await as("Ryan")("me");
  const gift = afterHide.admin.gifts.find((g) => g.receiverName === danielReceiver);
  assert.equal(gift.hidden, true);
  assert.equal(gift.spot, "Behind the printer");
  const mei = await as("Mei Ling")("me");
  if (mei.myDraw.name !== danielReceiver) assert.ok(!JSON.stringify(mei).includes("printer"));

  // Hunt: can't mark found until approved; members can't mark others.
  await rejects(as("Aisyah")("setFound", { found: true }), 409);
  const aisyahId = views.Aisyah.me.id;
  await as("Ryan")("setApproved", { id: aisyahId, approved: true });
  await rejects(as("Daniel")("setFound", { id: aisyahId, found: true }), 403);
  const found = await as("Aisyah")("setFound", { found: true });
  assert.equal(found.people.find((p) => p.id === aisyahId).found, true);

  // Reveal shows pairs to everyone.
  await as("Ryan")("setReveal", { on: true });
  const revealed = await as("Daniel")("me");
  assert.equal(revealed.state.reveal.length, everyone.length);
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
