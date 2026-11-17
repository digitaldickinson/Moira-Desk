// supabase/functions/link-preview/index.ts
//
// Looks up the headline of a BBC News or Manchester Evening News link pasted
// into the conference's new-pitch box, so the desk can fill in the angle.
//
// POST JSON: { bulletinId, url }
//   -> { ok: true, title, siteName, site }   title may be '' if none was found
//   -> { ok: false, message }                on refusal or failure
//
// Security: the caller must be signed in (Moira:Desk's anonymous session) and
// a member of the newsroom. Only the sites listed in preview.js are fetched,
// redirects are re-checked, only the top of the page is read, and only the
// headline and site name are returned. Nothing is stored.
//
// Deploy: supabase functions deploy link-preview
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchPreview, PreviewError } from "./preview.js";

const BULLETIN_ID_RE = /^[a-z0-9-]{1,120}$/;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, message: "Use POST." }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new PreviewError(500, "The function has no Supabase service credentials.");
    const db = createClient(url, key, { auth: { persistSession: false } });

    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const { data: who, error: authErr } = jwt ? await db.auth.getUser(jwt) : { data: null, error: true };
    if (authErr || !who?.user?.id) throw new PreviewError(401, "Not signed in. Reload the page.");

    let body: any;
    try { body = await req.json(); } catch { throw new PreviewError(400, "Body must be JSON."); }
    const bulletinId = typeof body?.bulletinId === "string" ? body.bulletinId : "";
    if (!BULLETIN_ID_RE.test(bulletinId)) throw new PreviewError(400, "bulletinId is not valid.");
    const { data: member, error: mErr } = await db.from("newsroom_members")
      .select("bulletin_id").eq("user_id", who.user.id).eq("bulletin_id", bulletinId).maybeSingle();
    if (mErr) throw new PreviewError(500, "Could not check newsroom membership.");
    if (!member) throw new PreviewError(403, "You haven't joined this newsroom. Enter its code first.");

    const preview = await fetchPreview(typeof body?.url === "string" ? body.url.trim() : "");
    return json({ ok: true, ...preview });
  } catch (e) {
    const status = e instanceof PreviewError ? e.status : 500;
    return json({ ok: false, message: e instanceof PreviewError ? e.message : "Headline lookup failed." }, status);
  }
});
