// All game rules and privacy checks live here. The HTTP layer (api/rpc.js, dev-server.js)
// only parses JSON and maps AppError to a status code; the store only reads and writes rows.
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_HINT = 280;
const MAX_SPOT = 400;
const MAX_NAME = 60;

export const newToken = () => randomBytes(18).toString("base64url");
const clean = (s, max) => String(s ?? "").trim().slice(0, max);
const hintCount = (p) => (p.hints || []).filter((h) => h && h.trim()).length;
const now = () => new Date().toISOString();
const sameSet = (a, b) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Pair everyone in one closed loop: shuffle, then each person gives to the next. Nobody draws themselves. */
export function drawPairs(ids) {
  const a = ids.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.map((santa, i) => ({ santa, receiver: a[(i + 1) % a.length] }));
}

export function makeCore(store, { setupKey } = {}) {
  async function auth(token) {
    if (!token || typeof token !== "string") throw new AppError(401, "Open the app with your personal link.");
    const me = await store.getPersonByToken(token);
    if (!me) throw new AppError(401, "This link isn't valid any more. Ask the organizer for your personal link.");
    return me;
  }
  const requireAdmin = (me) => {
    if (!me.is_admin) throw new AppError(403, "Only organizers can do that.");
  };
  async function personOr404(id) {
    const p = (await store.listPeople()).find((x) => x.id === id);
    if (!p) throw new AppError(404, "That person isn't in the exchange any more.");
    return p;
  }

  /** Everything one person is allowed to see. */
  async function snapshot(me) {
    const [people, draws, state] = await Promise.all([store.listPeople(), store.listDraw(), store.getState()]);
    const byId = new Map(people.map((p) => [p.id, p]));
    const drawnSantas = new Set(draws.map((d) => d.santa));
    const myDrawRow = draws.find((d) => d.santa === me.id);
    const receiver = myDrawRow && byId.get(myDrawRow.receiver);
    const hides = me.is_admin || myDrawRow ? await store.listHides() : [];
    const myHide = hides.find((h) => h.santa === me.id && receiver && h.receiver === receiver.id);

    const out = {
      me: {
        id: me.id,
        name: me.name,
        isAdmin: !!me.is_admin,
        hints: me.hints || [],
        hintsUpdatedAt: me.hints_updated_at || null,
      },
      people: people.map((p) => ({
        id: p.id,
        name: p.name,
        hintCount: hintCount(p),
        approved: !!p.approved,
        found: !!p.found_at,
        inDraw: drawnSantas.has(p.id),
      })),
      state: {
        drawnAt: state.drawnAt || null,
        drawnCount: draws.length,
        reveal: state.reveal
          ? draws.map((d) => ({ santa: d.santa, receiver: d.receiver }))
          : null,
      },
      myDraw: receiver
        ? { receiverId: receiver.id, name: receiver.name, hints: (receiver.hints || []).filter((h) => h && h.trim()) }
        : null,
      myHide: myHide ? { spot: myHide.spot, at: myHide.at } : null,
    };

    if (me.is_admin) {
      // Organizers see who is hidden where, keyed by RECEIVER only. Santas are never sent.
      out.admin = {
        links: people.map((p) => ({ id: p.id, token: p.token, isAdmin: !!p.is_admin })),
        gifts: draws
          .filter((d) => byId.has(d.receiver))
          .map((d) => {
            const h = hides.find((x) => x.santa === d.santa && x.receiver === d.receiver);
            return { receiverId: d.receiver, receiverName: byId.get(d.receiver).name, hidden: !!h, spot: h ? h.spot : null };
          }),
        // Removing someone cascades away their rows, leaving a Santa with no receiver and a receiver
        // with no Santa. A healthy draw has the same set of Santas and receivers.
        drawBroken: !!state.drawnAt && !sameSet(draws.map((d) => d.santa), draws.map((d) => d.receiver)),
        joinCode: state.joinCode || null,
      };
    }
    return out;
  }

  const actions = {
    async me(me) {},

    async saveHints(me, { hints }) {
      if (!Array.isArray(hints) || hints.length !== 3) throw new AppError(400, "Send exactly three hints.");
      const cleaned = hints.map((h) => clean(h, MAX_HINT));
      if (cleaned.some((h) => !h)) throw new AppError(400, "Fill in all three hints so your Santa has enough to go on.");
      await store.updatePerson(me.id, { hints: cleaned, hints_updated_at: now() });
    },

    async saveSpot(me, { spot }) {
      const s = clean(spot, MAX_SPOT);
      if (!s) throw new AppError(400, "Describe where the gift is so the organizer can help if it isn't found.");
      const d = (await store.listDraw()).find((x) => x.santa === me.id);
      if (!d) throw new AppError(409, "Names haven't been drawn yet.");
      await store.upsertHide({ santa: me.id, receiver: d.receiver, spot: s, at: now() });
    },

    async setFound(me, { id, found }) {
      const targetId = id || me.id;
      if (targetId !== me.id) requireAdmin(me);
      const target = targetId === me.id ? me : await personOr404(targetId);
      if (found && !target.approved) throw new AppError(409, "The ornament needs the organizer's approval before the hunt.");
      await store.updatePerson(targetId, { found_at: found ? now() : null });
    },

    // ----- organizer only -----
    async addPeople(me, { names }) {
      requireAdmin(me);
      if (!Array.isArray(names)) throw new AppError(400, "Send a list of names.");
      const existing = new Set((await store.listPeople()).map((p) => p.name.toLowerCase()));
      const rows = [];
      for (const raw of names) {
        const name = clean(raw, MAX_NAME);
        if (!name || existing.has(name.toLowerCase())) continue;
        existing.add(name.toLowerCase());
        rows.push({ name, token: newToken(), is_admin: false, hints: [], approved: false, found_at: null });
      }
      if (rows.length) await store.insertPeople(rows);
    },

    /** Turn the shared join link on (a fresh code, so any old link stops working) or off. */
    async setJoin(me, { open }) {
      requireAdmin(me);
      const state = await store.getState();
      await store.setState({ ...state, joinCode: open ? newToken() : null });
    },

    async removePerson(me, { id }) {
      requireAdmin(me);
      if (id === me.id) throw new AppError(400, "You can't remove yourself. Ask another organizer.");
      await personOr404(id);
      await store.deletePerson(id); // draw and hide rows cascade
    },

    async setAdmin(me, { id, isAdmin }) {
      requireAdmin(me);
      if (id === me.id && !isAdmin) throw new AppError(400, "You can't remove your own organizer access.");
      await personOr404(id);
      await store.updatePerson(id, { is_admin: !!isAdmin });
    },

    async resetLink(me, { id }) {
      requireAdmin(me);
      if (id === me.id) throw new AppError(400, "Ask another organizer to reset your own link.");
      await personOr404(id);
      await store.updatePerson(id, { token: newToken() });
    },

    async setApproved(me, { id, approved }) {
      requireAdmin(me);
      await personOr404(id);
      await store.updatePerson(id, approved ? { approved: true } : { approved: false, found_at: null });
    },

    async draw(me) {
      requireAdmin(me);
      const ids = (await store.listPeople()).filter((p) => hintCount(p) > 0).map((p) => p.id);
      if (ids.length < 2) throw new AppError(409, "At least 2 people need to save their hints before the draw.");
      const at = now();
      await store.replaceDraw(drawPairs(ids).map((r) => ({ ...r, drawn_at: at })));
      const state = await store.getState();
      // Close the join link: anyone joining after the draw would have no Santa.
      await store.setState({ ...state, drawnAt: at, reveal: false, joinCode: null });
    },

    async setReveal(me, { on }) {
      requireAdmin(me);
      const state = await store.getState();
      if (on && !state.drawnAt) throw new AppError(409, "Draw names first.");
      await store.setState({ ...state, reveal: !!on });
    },
  };

  return {
    /** One-time bootstrap: creates the first organizer. Returns their personal link token. */
    async setup({ setupKey: given, name }) {
      if (!setupKey) throw new AppError(503, "Setup is turned off. Set SETUP_KEY on the server to enable it.");
      if (!given || !sameSecret(given, setupKey)) throw new AppError(403, "That setup key is wrong.");
      const people = await store.listPeople();
      if (people.some((p) => p.is_admin)) throw new AppError(409, "An organizer already exists. Ask them for your link.");
      const n = clean(name, MAX_NAME);
      if (!n) throw new AppError(400, "Enter your name.");
      const token = newToken();
      await store.insertPeople([{ name: n, token, is_admin: true, hints: [], approved: false, found_at: null }]);
      return { token };
    },

    /** Self sign-up through the organizer's shared join link. Returns the new person's link token. */
    async join({ code, name }) {
      const { joinCode } = await store.getState();
      if (!joinCode) throw new AppError(403, "Joining is closed. Ask the organizer for your personal link.");
      if (!code || !sameSecret(code, joinCode)) throw new AppError(403, "This join link isn't valid any more. Ask the organizer for the current one.");
      const n = clean(name, MAX_NAME);
      if (!n) throw new AppError(400, "Enter your name.");
      const people = await store.listPeople();
      if (people.some((p) => p.name.toLowerCase() === n.toLowerCase())) {
        throw new AppError(409, `Someone called ${n} has already joined. If that's you, ask the organizer for your link. Otherwise add a surname or initial.`);
      }
      const token = newToken();
      await store.insertPeople([{ name: n, token, is_admin: false, hints: [], approved: false, found_at: null }]);
      return { token };
    },

    async handle(body) {
      const { token, action, ...args } = body || {};
      if (action === "setup") return this.setup(args);
      if (action === "join") return this.join(args);
      const fn = Object.hasOwn(actions, action) ? actions[action] : null;
      if (!fn) throw new AppError(400, "Unknown action.");
      const me = await auth(token);
      await fn(me, args);
      return snapshot(await auth(token)); // re-read so the reply reflects the change
    },
  };
}
