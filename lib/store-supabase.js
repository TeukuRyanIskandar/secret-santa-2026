// Supabase (Postgres) store. Uses the service-role key, so it must only ever run server-side.
import { createClient } from "@supabase/supabase-js";

export function supabaseStore(url, serviceKey) {
  if (!url || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  const sb = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const q = async (promise) => {
    const { data, error } = await promise;
    if (error) throw error;
    return data;
  };

  return {
    getPersonByToken: (token) => q(sb.from("people").select("*").eq("token", token).maybeSingle()),
    listPeople: () => q(sb.from("people").select("*").order("name")),
    insertPeople: (rows) => q(sb.from("people").insert(rows).select()),
    updatePerson: (id, patch) => q(sb.from("people").update(patch).eq("id", id)),
    deletePerson: (id) => q(sb.from("people").delete().eq("id", id)),
    listDraw: () => q(sb.from("draw").select("*")),
    // One transaction in Postgres (see supabase/schema.sql), so a draw never half-applies.
    replaceDraw: (rows) => q(sb.rpc("replace_draw", { rows })),
    listHides: () => q(sb.from("hides").select("*")),
    upsertHide: (row) => q(sb.from("hides").upsert(row, { onConflict: "santa" })),
    getState: async () => {
      const row = await q(sb.from("settings").select("value").eq("key", "state").maybeSingle());
      return (row && row.value) || {};
    },
    setState: (value) => q(sb.from("settings").upsert({ key: "state", value })),
  };
}
