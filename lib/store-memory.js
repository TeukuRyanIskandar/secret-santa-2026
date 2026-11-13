// In-memory store for local development and tests. Same interface as store-supabase.js.
import { randomUUID } from "node:crypto";

export function memoryStore() {
  let people = [];
  let draw = [];
  let hides = [];
  let state = {};
  const copy = (x) => structuredClone(x);

  return {
    async getPersonByToken(token) {
      return copy(people.find((p) => p.token === token) || null);
    },
    async listPeople() {
      return copy([...people].sort((a, b) => a.name.localeCompare(b.name)));
    },
    async insertPeople(rows) {
      const added = rows.map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), hints_updated_at: null, ...r }));
      people.push(...added);
      return copy(added);
    },
    async updatePerson(id, patch) {
      people = people.map((p) => (p.id === id ? { ...p, ...patch } : p));
    },
    async deletePerson(id) {
      people = people.filter((p) => p.id !== id);
      draw = draw.filter((d) => d.santa !== id && d.receiver !== id);
      hides = hides.filter((h) => h.santa !== id && h.receiver !== id);
    },
    async listDraw() {
      return copy(draw);
    },
    async replaceDraw(rows) {
      draw = copy(rows);
    },
    async listHides() {
      return copy(hides);
    },
    async upsertHide(row) {
      hides = hides.filter((h) => h.santa !== row.santa).concat(copy(row));
    },
    async getState() {
      return copy(state);
    },
    async setState(v) {
      state = copy(v);
    },
  };
}
