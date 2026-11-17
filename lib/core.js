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
const MAX_HIDE = 600; // clues and exact spot, each
const MAX_NAME = 60;
// Clues unlock and organizers see names from this moment. Override with HUNT_START.
export const DEFAULT_HUNT_START = "2026-12-23T00:00:00+08:00";

export const newToken = () => randomBytes(18).toString("base64url");
const clean = (s, max) => String(s ?? "").trim().slice(0, max);
const hintCount = (p) => (p.hints || []).filter((h) => h && h.trim()).length;
const sameSet = (a, b) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Pair everyone in one closed loop: shuffle, then each person gives to the next. Nobody draws themselves.
 * Each receiver also gets a gift number 1..N from a second, independent shuffle, so numbers say
 * nothing about join order or the loop.
 */
export function drawPairs(ids) {
  const a = shuffle(ids);
  const numbers = shuffle(a.map((_, i) => i + 1));
  return a.map((santa, i) => ({ santa, receiver: a[(i + 1) % a.length], number: numbers[i] }));
}

export function makeCore(store, { setupKey, huntStart = DEFAULT_HUNT_START, clock = () => new Date() } = {}) {
  const huntAt = new Date(huntStart || DEFAULT_HUNT_START);
  if (Number.isNaN(huntAt.getTime())) throw new Error(`HUNT_START is not a valid date: ${huntStart}`);
  const huntStarted = () => clock().getTime() >= huntAt.getTime();
  const now = () => clock().toISOString();

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

  /**
   * Everything one person is allowed to see. The privacy rule: a Santa gets their receiver's NUMBER
   * and wishlist, never a name or id, and nobody (organizers included, until the hunt starts) gets
   * anything that links a number to a person other than their own number and their receiver's.
   * Exception, by the organizers' choice: organizers see everyone's wishlist by name.
   */
  async function snapshot(me) {
    const [people, draws, state] = await Promise.all([store.listPeople(), store.listDraw(), store.getState()]);
    const byId = new Map(people.map((p) => [p.id, p]));
    const started = huntStarted();
    const inDraw = new Set(draws.flatMap((d) => [d.santa, d.receiver]));
    const myDrawRow = draws.find((d) => d.santa === me.id); // I give to...
    const mySantaRow = draws.find((d) => d.receiver === me.id); // ...and someone gives to me
    const receiver = myDrawRow && byId.get(myDrawRow.receiver);
    const needHides = me.is_admin || receiver || (started && mySantaRow);
    const hides = needHides ? await store.listHides() : [];
    const hideFor = (d) => hides.find((h) => h.santa === d.santa && h.receiver === d.receiver);
    const myHide = receiver && hideFor(myDrawRow);
    const hideForMe = started && mySantaRow ? hideFor(mySantaRow) : null;

    const out = {
      me: {
        id: me.id,
        name: me.name,
        isAdmin: !!me.is_admin,
        hints: me.hints || [],
        hintsUpdatedAt: me.hints_updated_at || null,
        number: mySantaRow ? mySantaRow.number : null,
      },
      people: people.map((p) => ({
        id: p.id,
        name: p.name,
        hintCount: hintCount(p),
        found: !!p.found_at,
        inDraw: inDraw.has(p.id),
      })),
      state: {
        drawnAt: state.drawnAt || null,
        drawnCount: draws.length,
        huntStart: huntAt.toISOString(),
        huntStarted: started,
      },
      myDraw: receiver
        ? { receiverNumber: myDrawRow.number, hints: (receiver.hints || []).filter((h) => h && h.trim()) }
        : null,
      myHide: myHide ? { clues: myHide.clues ?? null, spot: myHide.spot, at: myHide.at } : null,
      // Clues for me unlock on hunt day. Before that, not even whether my Santa wrote any.
      myClues: started && mySantaRow ? { clues: (hideForMe && hideForMe.clues) || null } : null,
    };

    if (me.is_admin) {
      // Gift readiness by number. Santas are never sent. Names, clues and spots only from hunt start,
      // so an organizer can't link anyone's number to their name before the hunt.
      const gifts = draws
        .filter((d) => byId.has(d.receiver))
        .sort((a, b) => a.number - b.number)
        .map((d) => {
          const h = hideFor(d);
          const g = { number: d.number, hasClues: !!(h && h.clues), hasSpot: !!(h && h.spot) };
          if (!started) return g;
          return { ...g, receiverId: d.receiver, receiverName: byId.get(d.receiver).name, clues: (h && h.clues) || null, spot: (h && h.spot) || null };
        });
      out.admin = {
        // Organizers can read everyone's wishes to keep them safe and friendly (agreed trade-off: an
        // organizer who is also a Santa can match their receiver's wishlist to a name).
        links: people.map((p) => ({ id: p.id, token: p.token, isAdmin: !!p.is_admin, hints: p.hints || [] })),
        gifts,
        // Removing someone cascades away their rows, leaving a Santa with no receiver and a receiver
        // with no Santa. A healthy draw has the same set of Santas and receivers.
        drawBroken: !!state.drawnAt && !sameSet(draws.map((d) => d.santa), draws.map((d) => d.receiver)),
        joinCode: state.joinCode || null,
        tvCode: state.tvCode || null,
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

    async saveHide(me, { clues, spot }) {
      const c = clean(clues, MAX_HIDE);
      const s = clean(spot, MAX_HIDE);
      if (!c) throw new AppError(400, "Write a few clues so they can find their gift on hunt day.");
      if (!s) throw new AppError(400, "Describe exactly where the gift is so the organizer can help if it isn't found.");
      const d = (await store.listDraw()).find((x) => x.santa === me.id);
      if (!d) throw new AppError(409, "Names haven't been drawn yet.");
      await store.upsertHide({ santa: me.id, receiver: d.receiver, clues: c, spot: s, at: now() });
    },

    async setFound(me, { id, found }) {
      const targetId = id || me.id;
      if (targetId !== me.id) requireAdmin(me);
      if (targetId !== me.id) await personOr404(targetId);
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
        rows.push({ name, token: newToken(), is_admin: false, hints: [], found_at: null });
      }
      if (rows.length) await store.insertPeople(rows);
    },

    /** Turn the read-only TV board link on (a fresh code, so any old link stops working) or off. */
    async setTv(me, { open }) {
      requireAdmin(me);
      const state = await store.getState();
      await store.setState({ ...state, tvCode: open ? newToken() : null });
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

    async draw(me) {
      requireAdmin(me);
      const ids = (await store.listPeople()).filter((p) => hintCount(p) > 0).map((p) => p.id);
      if (ids.length < 2) throw new AppError(409, "At least 2 people need to save their hints before the draw.");
      const at = now();
      await store.replaceDraw(drawPairs(ids).map((r) => ({ ...r, drawn_at: at })));
      const { reveal, ...state } = await store.getState(); // `reveal` is from an older version; drop it
      // Close the join link: anyone joining after the draw would have no Santa.
      await store.setState({ ...state, drawnAt: at, joinCode: null });
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
      await store.insertPeople([{ name: n, token, is_admin: true, hints: [], found_at: null }]);
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
      await store.insertPeople([{ name: n, token, is_admin: false, hints: [], found_at: null }]);
      return { token };
    },

    /** Read-only hunt board for a shared screen. Names and found status only: no ids, no numbers. */
    async tv({ code }) {
      const [{ tvCode }, people, draws] = await Promise.all([store.getState(), store.listPeople(), store.listDraw()]);
      if (!tvCode || !code || !sameSecret(code, tvCode)) throw new AppError(403, "This TV link isn't valid any more. Ask an organizer for the current one.");
      const inDraw = new Set(draws.flatMap((d) => [d.santa, d.receiver]));
      const shown = draws.length ? people.filter((p) => inDraw.has(p.id)) : people.filter((p) => hintCount(p) > 0);
      const board = shown.map((p) => ({ name: p.name, found: !!p.found_at })).sort((a, b) => a.name.localeCompare(b.name));
      return { people: board, foundCount: board.filter((p) => p.found).length, total: board.length, huntStarted: huntStarted() };
    },

    async handle(body) {
      const { token, action, ...args } = body || {};
      if (action === "setup") return this.setup(args);
      if (action === "join") return this.join(args);
      if (action === "tv") return this.tv(args);
      const fn = Object.hasOwn(actions, action) ? actions[action] : null;
      if (!fn) throw new AppError(400, "Unknown action.");
      const me = await auth(token);
      await fn(me, args);
      return snapshot(await auth(token)); // re-read so the reply reflects the change
    },
  };
}
