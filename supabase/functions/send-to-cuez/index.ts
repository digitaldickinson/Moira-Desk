// supabase/functions/send-to-cuez/index.ts
//
// Pushes stories into a Cuez Rundown part via Cuez's operation API, then reads
// the episode back to verify the items actually landed.
//
// Actions (POST JSON):
//   { action: "token-status" }
//       Admin-only expiry metadata. Never returns the Cuez token or its claims.
//   { action: "parts", episodeId, bulletinId? }
//       Lists the episode's parts and their items, for the admin page's Cuez
//       target picker. Admins only, or members of bulletinId.
//   { action: "send-bulletin", bulletinId }
//       Reads the bulletin's running order from the database and sends every
//       story above END OF PROGRAMME that isn't floated, isn't a segment, and
//       hasn't been sent yet. Each new story is placed after its nearest Moira
//       neighbour that is already in Cuez. Writes the Cuez item ID back.
//
// Security: the caller must be signed in (Moira:Desk's anonymous session) AND
// a member of the newsroom, i.e. have joined it with its code. The function
// reads and writes the database with the service role, so it checks
// membership itself rather than relying on Row Level Security.
//
// Script -> Cuez blocks (keep in step with parseTag/cuezBlocksPreview in index.html):
//   Plain text                         PROMPTER block (one paragraph per line)
//   [CLIP] / [CLIP:1:20 Title]         CLIP block, media left for production
//   [CLIP:1:20 Title | SOT | LW: ...]  ...with Sound (SOT/OFF) and Last Words
//   [STRAP: Name | Job title]          LOWER THIRD block
//   [any other direction]              INSTRUCTIONS block (red, not read out);
//                                      directions next to each other share one
//   A story in a clip format with no [CLIP] tag gets one clip after the script.
//   Clips without SOT/OFF get OFF in OOV and ULAY stories, SOT otherwise.
//   If the episode's template lacks a block type, that tag stays in the text.
//
// Secrets:
//   CUEZ_BEARER_TOKEN        required. The token only, without "Bearer ".
//   CUEZ_PROJECT_ID          optional. Refuses episodes from any other Cuez project.
//   CUEZ_CONTEXT_FIELD_ID    optional. Also initialise this context field, as the
//                            Cuez UI does. Only needed if items fail to appear.
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.

import { createClient } from "jsr:@supabase/supabase-js@2";
// Decode expiry metadata only. This does not verify the signature, revocation
// or Cuez permissions, and must never be used to authorise a request.
function tokenExpiryStatus(token: string, now = Date.now()) {
  const checkedAt = new Date(now).toISOString();
  const unknown = { status: 'unknown', expiresAt: null, checkedAt };
  if (!token) return { ...unknown, status: 'missing' };
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(Boolean)) return unknown;
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    if (typeof payload?.exp !== 'number' || !Number.isFinite(payload.exp)) return unknown;
    const expiry = new Date(payload.exp * 1000);
    if (!Number.isFinite(expiry.getTime())) return unknown;
    const expiresAt = expiry.toISOString();
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf))) return unknown;
    if (typeof payload.nbf === 'number' && payload.nbf * 1000 > now) {
      return { status: 'not-yet-valid', expiresAt, checkedAt };
    }
    return { status: expiry.getTime() <= now ? 'expired' : 'valid', expiresAt, checkedAt };
  } catch {
    return unknown;
  }
}

const CUEZ_API = "https://app.cuez.live/api";
const MAX_STORIES = 50;
const SEND_CLAIM_SECONDS = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BULLETIN_ID_RE = /^[a-z0-9-]{1,120}$/;

// Keep in step with TAG_RE / CLIP_FORMATS / OFF_FORMATS in index.html.
const TAG_RE = /\[([^\]\n]+)\]/g;
const CLIP_FORMATS = new Set(["WRAP", "CLIP", "OOV", "ULAY", "OOV/CLIP", "ULAY/CLIP", "PKG", "VT"]);
const OFF_FORMATS = new Set(["OOV", "ULAY"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Sound = "SOT" | "OFF";
type Block =
  | { kind: "prompter"; paragraphs: string[] }
  | { kind: "clip"; title: string; duration: string | null; sound: Sound | null; lastWords: string | null }
  | { kind: "strap"; name: string; role: string }
  | { kind: "instructions"; paragraphs: string[] };

type Caps = { clip: boolean; strap: boolean; instructions: boolean };

// itemUid is set when retrying an unconfirmed send, so the retry reuses the
// original identity instead of creating a second item.
// repair: the item is already in the part but incomplete, so the retry only
// re-sends its blocks and content (no item attach, no change of place).
type StoryIn = { slug: string; blocks: Block[]; ref?: string; itemUid?: string; retry?: boolean; repair?: boolean };

type CuezOp = {
  uid: string;
  entity_type: "context" | "item" | "part" | "block" | "block_instance";
  event_name: string;
  version: number;
  project_id: string;
  episode_id: string;
  payload: Record<string, unknown>;
};

type Placed = StoryIn & { ref: string; itemUid: string; placeAfter: string | null; position: number };

class HttpError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Script -> blocks
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// One paragraph per line, trimmed both ends (stray spaces around [CLIP] tags
// would otherwise indent the prompter). Blank lines inside are kept; leading
// and trailing blank lines are dropped.
function toParagraphs(text: string): string[] {
  const out = String(text ?? "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
  while (out.length && !out[0]) out.shift();
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

// ProseMirror rejects empty text nodes, so an empty line is a bare paragraph.
function prompterContent(paragraphs: string[]) {
  const paras = paragraphs.length ? paragraphs : [""];
  return {
    html: paras.map((p) => (p ? `<p>${escapeHtml(p)}</p>` : "<p></p>")).join(""),
    json: {
      type: "doc",
      content: paras.map((p) =>
        p ? { type: "paragraph", content: [{ type: "text", text: p }] } : { type: "paragraph" }
      ),
    },
  };
}

// What a [bracketed] tag means.
type Tag =
  | { kind: "clip"; title: string; duration: string | null; sound: Sound | null; lastWords: string | null }
  | { kind: "strap"; name: string; role: string }
  | { kind: "instructions"; text: string };

// Placeholders from the editor's insert buttons, ignored if left untouched.
const PLACEHOLDERS = new Set(["clip title", "last words", "name", "job title", "direction"]);
const real = (v: string) => (PLACEHOLDERS.has(v.trim().toLowerCase()) ? "" : v.trim());

function parseTag(inner: string): Tag {
  const t = inner.trim();
  let m = t.match(/^CLIP\b(?::(\d+):(\d{2}))?\s*([\s\S]*)$/i);
  if (m) {
    let title = "", sound: Sound | null = null, lastWords: string | null = null;
    for (const part of m[3].split("|").map((x) => x.trim()).filter(Boolean)) {
      if (/^(SOT|OFF)$/i.test(part)) sound = part.toUpperCase() as Sound;
      else if (/^LW\b/i.test(part)) lastWords = real(part.replace(/^LW\b\s*:?\s*/i, "")) || null;
      else if (!title) title = real(part);
    }
    return { kind: "clip", title, duration: m[1] !== undefined ? `${parseInt(m[1], 10)}:${m[2]}` : null, sound, lastWords };
  }
  m = t.match(/^STRAP\b\s*:?\s*([\s\S]*)$/i);
  if (m) {
    const [name = "", ...rest] = m[1].split("|").map((x) => real(x));
    return { kind: "strap", name, role: rest.filter(Boolean).join(" | ") };
  }
  return { kind: "instructions", text: real(t) };
}

function storyBlocks(script: string, format: string, slug: string, caps: Caps): Block[] {
  const text = String(script ?? "");
  const fmt = String(format ?? "").trim().toUpperCase();
  const blocks: Block[] = [];
  let buf = "";
  const flush = () => {
    const paragraphs = toParagraphs(buf);
    if (paragraphs.length) blocks.push({ kind: "prompter", paragraphs });
    buf = "";
  };

  let last = 0;
  for (const m of text.matchAll(TAG_RE)) {
    buf += text.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
    const tag = parseTag(m[1]);
    if (tag.kind === "clip" && caps.clip) {
      flush();
      blocks.push({ kind: "clip", title: tag.title, duration: tag.duration, sound: tag.sound, lastWords: tag.lastWords });
    } else if ((tag.kind === "strap" && !tag.name) || (tag.kind === "instructions" && !tag.text)) {
      // empty or untouched placeholder: drop it
    } else if (tag.kind === "strap" && caps.strap) {
      flush();
      blocks.push({ kind: "strap", name: tag.name, role: tag.role });
    } else if (tag.kind === "instructions" && caps.instructions) {
      flush();
      const prev = blocks[blocks.length - 1];
      if (prev?.kind === "instructions") prev.paragraphs.push(tag.text);
      else blocks.push({ kind: "instructions", paragraphs: [tag.text] });
    } else {
      buf += m[0]; // this template can't take it: leave it in the prompter text
    }
  }
  buf += text.slice(last);
  flush();

  let clips = blocks.filter((b) => b.kind === "clip") as Extract<Block, { kind: "clip" }>[];
  if (!clips.length && caps.clip && CLIP_FORMATS.has(fmt)) {
    blocks.push({ kind: "clip", title: "", duration: null, sound: null, lastWords: null });
    clips = blocks.filter((b) => b.kind === "clip") as Extract<Block, { kind: "clip" }>[];
  }
  // Default titles ("SLUG CLIP", numbered when several) and sound by format.
  clips.forEach((c, i) => {
    if (!c.title) c.title = clips.length > 1 ? `${slug} CLIP ${i + 1}` : `${slug} CLIP`;
    if (!c.sound) c.sound = OFF_FORMATS.has(fmt) ? "OFF" : "SOT";
  });

  // Every item gets at least a prompter block so the presenter sees it.
  if (!blocks.length) blocks.push({ kind: "prompter", paragraphs: [] });
  return blocks;
}

// ---------------------------------------------------------------------------
// Cuez calls
// ---------------------------------------------------------------------------

async function cuezFetch(
  path: string,
  token: string,
  clientInstance: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${CUEZ_API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
      "TL-Client-Instance": clientInstance,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch { /* leave as text */ }
  return { status: res.status, body };
}

async function getEpisode(episodeId: string, token: string, clientInstance: string) {
  const { status, body } = await cuezFetch(`/episode/${episodeId}`, token, clientInstance);
  if (status === 401 || status === 403) {
    throw new HttpError(502, "Cuez rejected the token. It has probably expired: set a fresh CUEZ_BEARER_TOKEN.");
  }
  if (status === 404) throw new HttpError(404, "Cuez could not find that episode.");
  if (status < 200 || status >= 300 || body?.status !== "SUCCESS" || !body?.data?.episode) {
    throw new HttpError(502, `Unexpected response reading the episode (HTTP ${status}).`, body);
  }
  return body.data;
}

function summariseParts(data: any) {
  const partUids: string[] = data.episode.parts ?? [];
  return partUids.map((uid, i) => {
    const part = data.parts?.[uid] ?? {};
    const items: string[] = part.items ?? [];
    return {
      uid,
      title: part.title || `Part ${i + 1}`,
      items: items.map((itemUid) => {
        const it = data.items?.[itemUid] ?? {};
        return { uid: itemUid, title: it.title ?? "", number: it.number ?? null };
      }),
    };
  });
}

// What the episode's template supports. Project-specific IDs (the clip's
// Duration field, the INSTRUCTIONS block, Sound's option IDs) are looked up
// by name rather than hard-coded.
function templateInfo(data: any) {
  const templates: any[] = data.template?.block_templates ?? [];
  const live = templates.filter((t) => t.status !== "deleted");
  const find = (id: string) => live.find((t) => t.identifier === id);
  const fieldsOf = (t: any): any[] => t?.block_template_fields ?? [];
  const has = (t: any, id: string) => fieldsOf(t).some((f) => f.identifier === id) ? id : null;
  const byTitle = (t: any, title: string) => fieldsOf(t).find((f) => String(f.title ?? "").trim().toLowerCase() === title);

  const clip = find("default_clip");
  const soundField = fieldsOf(clip).find((f) => f.identifier === "default_clip_sound");
  const soundValues: any[] = (soundField?.options ?? []).find((o: any) => o?.name === "possible_values")?.value ?? [];
  const soundOptions: Record<string, string> = {};
  for (const v of soundValues) if (!v?.deleted && v?.uid && v?.title) soundOptions[String(v.title).trim().toUpperCase()] = v.uid;

  const strap = find("default_strap");
  const instructions = live.find((t) => String(t.title ?? "").trim().toUpperCase() === "INSTRUCTIONS");
  const instructionsField = fieldsOf(instructions).find((f) => f.field_type_id === 3) ?? fieldsOf(instructions)[0];

  // Words per minute Cuez uses to time the prompter (an option on its text field).
  const prompterFields = fieldsOf(find("default_prompter"));
  const textField = prompterFields.find((f) => f.identifier === "default_prompter_text") ?? prompterFields[0];
  const speed = Number((textField?.options ?? []).find((o: any) => o?.name === "read_speed")?.value);

  return {
    readSpeed: Number.isFinite(speed) && speed > 0 ? Math.round(speed) : null,
    clip: !!clip,
    clipTitleField: has(clip, "default_clip_title"),
    clipDurationField: (byTitle(clip, "duration")?.identifier as string | undefined) ?? null,
    clipLastWordsField: has(clip, "default_clip_lw"),
    clipSoundField: soundField ? "default_clip_sound" : null,
    soundOptions,
    strap: !!strap,
    strapTitleField: has(strap, "default_strap_title"),
    strapRoleField: has(strap, "default_strap_description"),
    instructionsTemplate: (instructions?.identifier as string | undefined) ?? null,
    instructionsField: (instructionsField?.identifier as string | undefined) ?? null,
  };
}

function capsOf(tpl: ReturnType<typeof templateInfo>): Caps {
  return { clip: tpl.clip, strap: tpl.strap, instructions: !!(tpl.instructionsTemplate && tpl.instructionsField) };
}

// ---------------------------------------------------------------------------
// Placement and the operation batch
// ---------------------------------------------------------------------------

// sequence: the desired running order, mixing items already in Cuez and new
// stories. Each new story goes after the nearest earlier entry that is in Cuez
// (including stories placed earlier in this batch). If there is none, it goes
// just before the first later existing item; if nothing is in Cuez yet, it is
// appended to the end of the part.
function planPlacement(
  partItems: string[],
  sequence: ({ existing: string } | { story: StoryIn })[],
): { placed: Placed[]; simulated: string[] } {
  const list = [...partItems];
  const placed: Placed[] = [];
  let prev: string | null = null;

  sequence.forEach((entry, i) => {
    if ("existing" in entry) {
      prev = entry.existing;
      return;
    }
    let placeAfter: string | null;
    if (prev) {
      placeAfter = prev;
    } else {
      const next = sequence.slice(i + 1).find((e) => "existing" in e) as { existing: string } | undefined;
      if (next) {
        const idx = list.indexOf(next.existing);
        placeAfter = idx > 0 ? list[idx - 1] : null;
      } else {
        placeAfter = list.length ? list[list.length - 1] : null;
      }
    }
    const itemUid = entry.story.itemUid ?? crypto.randomUUID();
    const position = placeAfter ? list.indexOf(placeAfter) + 1 : 0;
    list.splice(position, 0, itemUid);
    placed.push({ ...entry.story, ref: entry.story.ref ?? itemUid, itemUid, placeAfter, position });
    prev = itemUid;
  });

  return { placed, simulated: list };
}

// Every ID in a story's send is derived from its item ID, so a retry of an
// unconfirmed send produces exactly the same entities as the original. If the
// original write turns up late, the two converge on the same item rather than
// creating two: Cuez rejects attaching an item or block that's already attached.
async function derivedUuid(seed: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed))).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

async function storyIds(itemUid: string, blockCount: number) {
  const itemCtx = await derivedUuid(`${itemUid}:item-context`);
  const blocks: { block: string; ctx: string; inst: string }[] = [];
  for (let i = 0; i < blockCount; i++) {
    blocks.push({
      block: await derivedUuid(`${itemUid}:block:${i}`),
      ctx: await derivedUuid(`${itemUid}:block-context:${i}`),
      inst: await derivedUuid(`${itemUid}:block-instance:${i}`),
    });
  }
  return { itemCtx, blocks };
}

// The field writes for one block: what buildBatch sends and what verification
// expects to read back.
type FieldWrite = { field: string; content: unknown };
function blockWrites(block: Block, tpl: ReturnType<typeof templateInfo>): { templateId: string; fields: FieldWrite[] } {
  const fields: FieldWrite[] = [];
  const set = (field: string | null, content: unknown) => { if (field) fields.push({ field, content }); };
  let templateId = "default_prompter";
  if (block.kind === "prompter") {
    set("default_prompter_text", prompterContent(block.paragraphs));
  } else if (block.kind === "instructions") {
    templateId = tpl.instructionsTemplate!;
    set(tpl.instructionsField, prompterContent(block.paragraphs));
  } else if (block.kind === "strap") {
    templateId = "default_strap";
    set(tpl.strapTitleField, { text: block.name });
    if (block.role) set(tpl.strapRoleField, { text: block.role });
  } else {
    templateId = "default_clip";
    if (block.title) set(tpl.clipTitleField, { text: block.title });
    if (block.duration) set(tpl.clipDurationField, { text: block.duration });
    const soundUid = block.sound ? tpl.soundOptions[block.sound] : undefined;
    if (soundUid) set(tpl.clipSoundField, [soundUid]); // Sound takes a list of option IDs
    if (block.lastWords) set(tpl.clipLastWordsField, { text: block.lastWords });
  }
  return { templateId, fields };
}

// What a complete story looks like in Cuez: its item, and each block's
// instance, block and field contents, in order.
type Expected = {
  ref: string; slug: string; itemUid: string; itemCtx: string; retry: boolean; repair?: boolean;
  blocks: { inst: string; block: string; ctx: string; fields: FieldWrite[] }[];
};
async function expectedStory(ref: string, slug: string, itemUid: string, blocks: Block[], tpl: ReturnType<typeof templateInfo>, retry: boolean): Promise<Expected & { templates: string[] }> {
  const ids = await storyIds(itemUid, blocks.length);
  const writes = blocks.map((b) => blockWrites(b, tpl));
  return {
    ref, slug, itemUid, retry, itemCtx: ids.itemCtx,
    templates: writes.map((w) => w.templateId),
    blocks: ids.blocks.map((b, i) => ({ inst: b.inst, block: b.block, ctx: b.ctx, fields: writes[i].fields })),
  };
}

async function buildBatch(opts: {
  projectId: string;
  episodeId: string;
  partUid: string;
  placed: Placed[];
  tpl: ReturnType<typeof templateInfo>;
  contextFieldId?: string;
}) {
  const { projectId, episodeId, partUid, placed, tpl, contextFieldId } = opts;
  const operations: CuezOp[] = [];
  const created: (Expected & { clips: number })[] = [];

  let version = Date.now() * 1000; // microseconds, strictly increasing through the batch
  const op = (uid: string, entity_type: CuezOp["entity_type"], event_name: string, payload: Record<string, unknown>) =>
    operations.push({ uid, entity_type, event_name, version: version++, project_id: projectId, episode_id: episodeId, payload });

  const initContext = (ctx: string) => {
    op(ctx, "context", "CONTEXT_CREATED", {});
    if (contextFieldId) {
      op(ctx, "context", "CONTEXT_CONTENT_CHANGED", { field_identifier: contextFieldId, content: { html: "" } });
    }
  };

  for (const story of placed) {
    const itemUid = story.itemUid;
    const exp = await expectedStory(story.ref, story.slug, itemUid, story.blocks, tpl, !!story.retry);

    initContext(exp.itemCtx);
    op(itemUid, "item", "ITEM_CREATED", {
      title: story.slug,
      color: { name: "foreground", value: "black" },
      context_id: exp.itemCtx,
    });
    if (!story.repair) {
      op(partUid, "part", "PART_ITEM_ADDED", {
        item_uid: itemUid,
        place_after: story.placeAfter,
        source: "EPISODE",
        place_holder_position: story.position,
      });
    }

    let prevInstance: string | null = null;
    exp.blocks.forEach((b, i) => {
      op(b.block, "block", "BLOCK_CREATED", { block_template_identifier: exp.templates[i] });
      initContext(b.ctx);
      op(b.inst, "block_instance", "BLOCK_INSTANCE_CREATED", { block_uid: b.block, context_id: b.ctx });
      op(itemUid, "item", "ITEM_BLOCK_INSTANCE_ADDED", {
        block_instance_uid: b.inst,
        place_after: prevInstance,
        source: "EPISODE",
        place_holder_position: i,
      });
      // Content is written to the BLOCK uid, not the instance.
      for (const f of b.fields) {
        op(b.block, "block", "BLOCK_CONTENT_CHANGED", { block_template_field_identifier: f.field, block_field_content: f.content });
      }
      prevInstance = b.inst;
    });

    created.push({ ...exp, repair: !!story.repair, clips: story.blocks.filter((b) => b.kind === "clip").length });
  }

  return { operations, created };
}

// ---------------------------------------------------------------------------
// Verification: "sent" means the whole story is in Cuez
// ---------------------------------------------------------------------------

// Looks an entity up in the episode read, which returns some collections as
// objects keyed by ID and (when empty) as plain lists.
function entity(collection: any, uid: string): any {
  if (!collection) return undefined;
  if (Array.isArray(collection)) return collection.find((e: any) => e?.id === uid || e?.uid === uid);
  return collection[uid];
}

// Comparable text for a field value, whatever wrapper it comes in: prompter
// html/ProseMirror json, {text}, an option list, or a plain string. Cuez may
// re-save prompter html through its editor, so compare words, not markup.
function plain(v: any): string {
  const textOf = (n: any): string => !n ? "" : typeof n === "string" ? n
    : n.type === "text" ? (n.text ?? "") : Array.isArray(n.content) ? n.content.map(textOf).join(" ") : "";
  let out: string;
  if (v === null || v === undefined) out = "";
  else if (typeof v === "string") out = v.replace(/<[^>]*>/g, " ");
  else if (Array.isArray(v)) out = v.map((x) => typeof x === "string" ? x : plain(x)).sort().join("|");
  else if (typeof v.html === "string") out = v.html.replace(/<[^>]*>/g, " ");
  else if (v.json) out = textOf(v.json);
  else if (v.type === "doc") out = textOf(v);
  else if (typeof v.text === "string") out = v.text;
  else if ("value" in v) out = plain(v.value);
  else out = JSON.stringify(v);
  return out.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();
}

// A field's stored content in a block from the episode read. Confirmed shape
// (captured from a real episode): blocks[uid].content[fieldId] = { value, ... },
// where value is {html, json} for text fields, {text} for single lines, and a
// list of option IDs for Sound. Other layouts are still accepted in case Cuez
// changes it:
//   found     the field is there (value returned)
//   missing   a recognised content container exists but lacks this field,
//             so the write didn't land
//   unknown   no recognised container (or no block entry at all): reported
//             as "content not checked", never as a pass
function fieldContent(block: any, field: string): { state: "found" | "missing" | "unknown"; value?: unknown } {
  if (!block || typeof block !== "object") return { state: "unknown" };
  let container = false;
  for (const key of ["content", "fields", "field_contents", "block_field_contents", "contents", "values"]) {
    const c = block[key];
    if (!c || typeof c !== "object") continue;
    container = true;
    if (Array.isArray(c)) {
      const hit = c.find((e: any) => e && [e.block_template_field_identifier, e.field_identifier, e.identifier, e.field].includes(field));
      if (hit) return { state: "found", value: hit.block_field_content ?? hit.content ?? hit.value };
    } else if (field in c) {
      return { state: "found", value: c[field] };
    }
  }
  return { state: container ? "missing" : "unknown" };
}

// complete: every block attached with its content. Block order is reported
// as a warning only: a retry can add a missing block but can't reorder ones
// already attached, so treating order as incomplete would never clear.
type StoryCheck = { complete: boolean; problems: string[]; warnings: string[]; contentUnchecked: boolean };

// Checks one story against the episode read: item in the part, every block
// attached to the item in order, and every field holding what was written.
function checkStory(exp: Expected, ep: any, partUid: string): StoryCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  let contentUnchecked = false;
  const partItems: string[] = ep?.parts?.[partUid]?.items ?? [];
  if (!partItems.includes(exp.itemUid)) return { complete: false, problems: ["not in the part"], warnings, contentUnchecked };

  const item = entity(ep.items, exp.itemUid);
  const attached: string[] | undefined = Array.isArray(item?.block_instances) ? item.block_instances : undefined;
  if (!attached) {
    problems.push("Cuez didn't list the item's blocks");
  } else {
    // Ours must all be there, in order. Others (a producer's) may be between.
    let at = -1;
    exp.blocks.forEach((b, i) => {
      const pos = attached.indexOf(b.inst);
      if (pos < 0) problems.push(`block ${i + 1} missing`);
      else if (pos < at) warnings.push("blocks out of order");
      else at = pos;
    });
  }

  exp.blocks.forEach((b, i) => {
    const block = entity(ep.blocks, b.block);
    for (const f of b.fields) {
      const got = fieldContent(block, f.field);
      if (got.state === "unknown") { contentUnchecked = true; continue; }
      if (got.state === "missing") problems.push(`block ${i + 1} content missing`);
      else if (plain(got.value) !== plain(f.content)) problems.push(`block ${i + 1} content differs`);
    }
  });

  return { complete: problems.length === 0, problems: [...new Set(problems)], warnings: [...new Set(warnings)], contentUnchecked };
}

// Writes the batch, then verifies every story by reading the episode back.
// Cuez answers 200 even when it rejects operations, so each rejection is
// matched to its story. The only rejections tolerated are duplicates from a
// retry, and only when the read-back shows the original is really there: an
// item attach for an item already in the part, a block attach for a block
// already on the item, or a create for a story that verifies complete. A
// rejected content write always counts against the story.
async function writeAndVerify(args: {
  token: string;
  clientInstance: string;
  episodeId: string;
  partUid: string;
  operations: CuezOp[];
  created: Expected[];
}) {
  const { token, clientInstance, episodeId, partUid, operations, created } = args;

  const write = await cuezFetch("/operation", token, clientInstance, { method: "POST", body: { operations } });
  const errors: any[] = Array.isArray(write.body?.errors) ? write.body.errors : [];
  const stale: any[] = Array.isArray(write.body?.stale_operations) ? write.body.stale_operations : [];
  const rejected = [...errors.map((e) => e?.operation ?? e), ...stale];
  const httpFailed = write.status < 200 || write.status >= 300;

  // Which story each operation belongs to.
  const owner = new Map<string, number>();
  created.forEach((c, i) => {
    owner.set(c.itemUid, i); owner.set(c.itemCtx, i);
    for (const b of c.blocks) { owner.set(b.block, i); owner.set(b.ctx, i); owner.set(b.inst, i); }
  });
  // An item attach is addressed to the part, so its story is in the payload.
  const ownerOf = (o: any): number | undefined =>
    o?.event_name === "PART_ITEM_ADDED" ? owner.get(o?.payload?.item_uid) : owner.get(o?.uid);

  // "Accepted" isn't "in the rundown": read it back, with a short retry for lag.
  let after: any = null;
  let checks: StoryCheck[] = created.map(() => ({ complete: false, problems: ["not read back"], warnings: [], contentUnchecked: false }));
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(400 * attempt);
    after = await getEpisode(episodeId, token, clientInstance);
    checks = created.map((c) => checkStory(c, after, partUid));
    if (checks.every((k) => k.complete)) break;
  }
  const partItems: string[] = after?.parts?.[partUid]?.items ?? [];

  // Classify each rejection. One that isn't tolerated makes its story
  // incomplete; one that matches no story is reported as unexpected.
  const unexpected: string[] = [];
  for (const o of rejected) {
    const i = ownerOf(o);
    const ev = String(o?.event_name ?? "unknown");
    if (i === undefined) { unexpected.push(ev); continue; }
    const c = created[i];
    const item = entity(after?.items, c.itemUid);
    const tolerated = c.retry && (
      (ev === "PART_ITEM_ADDED" && partItems.includes(c.itemUid)) ||
      (ev === "ITEM_BLOCK_INSTANCE_ADDED" && Array.isArray(item?.block_instances) &&
        item.block_instances.includes(o?.payload?.block_instance_uid)) ||
      (/_CREATED$/.test(ev) && checks[i].complete)
    );
    if (!tolerated) {
      checks[i] = { ...checks[i], complete: false, problems: [...new Set([...checks[i].problems, `Cuez rejected ${ev}`])] };
    }
  }

  const missing = created.filter((c) => !partItems.includes(c.itemUid)).map((c) => c.itemUid);
  // Repaired items stay where they already were, so only new placements count.
  const positions = created.filter((c) => !c.repair).map((c) => partItems.indexOf(c.itemUid));
  const inOrder = positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]));

  return {
    after, partItems, missing, inOrder, httpStatus: write.status, httpFailed, checks,
    unexpectedEvents: unexpected,
    cuez: rejected.length || httpFailed ? write.body : undefined,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function requireUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value.trim())) throw new HttpError(400, `${name} must be a UUID.`);
  return value.trim();
}

function cleanSlug(slug: unknown): string {
  const s = typeof slug === "string" ? slug.trim() : "";
  return (s || "UNTITLED").slice(0, 200);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Ctx = {
  token: string;
  allowedProject: string | null;
  contextFieldId?: string;
  clientInstance: string;
  db: any;
  userId: string;
};

// The caller's Supabase session -> user id. Rejects the bare anon key.
async function requireUser(db: any, req: Request): Promise<string> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) throw new HttpError(401, "Not signed in. Reload the page.");
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data?.user?.id) throw new HttpError(401, "Not signed in. Reload the page.");
  return data.user.id as string;
}

async function requireMember(ctx: Ctx, bulletinId: unknown): Promise<string> {
  const id = typeof bulletinId === "string" ? bulletinId : "";
  if (!BULLETIN_ID_RE.test(id)) throw new HttpError(400, "bulletinId is not valid.");
  const { data, error } = await ctx.db.from("newsroom_members")
    .select("bulletin_id").eq("user_id", ctx.userId).eq("bulletin_id", id).maybeSingle();
  if (error) throw new HttpError(500, "Could not check newsroom membership.", error.message);
  if (!data) throw new HttpError(403, "You haven't joined this newsroom. Enter its code first.");
  return id;
}

async function loadEpisode(ctx: Ctx, episodeId: string) {
  const episode = await getEpisode(episodeId, ctx.token, ctx.clientInstance);
  if (ctx.allowedProject && episode.episode.project_id !== ctx.allowedProject) {
    throw new HttpError(403, "That episode belongs to a Cuez project this function is not allowed to write to.");
  }
  return episode;
}

function requirePart(episode: any, partUid: string) {
  // Cuez accepts operations against a part that doesn't exist and silently
  // orphans the item, so check before writing anything.
  if (!(episode.episode.parts ?? []).includes(partUid) || !episode.parts?.[partUid]) {
    throw new HttpError(400, "That part is no longer in the Cuez episode. Choose the part again.");
  }
  return (episode.parts[partUid].items ?? []) as string[];
}

async function isAdmin(ctx: Ctx): Promise<boolean> {
  const { data, error } = await ctx.db.from("admins").select("user_id").eq("user_id", ctx.userId).maybeSingle();
  if (error) throw new HttpError(500, "Could not check admin status.", error.message);
  return !!data;
}

// Admins only: the admin page's Cuez target picker. (Students never need it,
// and allowing members would let them read any episode the token can see.)
async function actionParts(ctx: Ctx, body: any) {
  if (!(await isAdmin(ctx))) throw new HttpError(403, "Only admins can look up Cuez episodes.");
  const episodeId = requireUuid(body?.episodeId, "episodeId");
  const episode = await loadEpisode(ctx, episodeId);
  return json({ ok: true, episodeTitle: episode.episode.title, readSpeed: templateInfo(episode).readSpeed, parts: summariseParts(episode) });
}

// Cuez's display number for an item ("4"), or null.
function numberOf(items: any, itemUid: string): string | null {
  const n = items?.[itemUid]?.number;
  return n === undefined || n === null || n === "" ? null : String(n);
}

// Update stored item numbers for already-sent stories whose number changed.
async function refreshNumbers(db: any, rows: any[], items: any) {
  for (const r of rows) {
    if (!r.cuez_item_uid) continue;
    const n = numberOf(items, r.cuez_item_uid);
    if (n !== null && n !== (r.cuez_item_number ?? null)) {
      await db.from("stories").update({ cuez_item_number: n }).eq("id", r.id);
    }
  }
}

// Send the bulletin's unsent running order.
async function actionSendBulletin(ctx: Ctx, body: any) {
  const bulletinId = await requireMember(ctx, body?.bulletinId);
  const db = ctx.db;

  const { data: bulletin, error: bErr } = await db.from("bulletins")
    .select("id, order_ids, cuez_episode_id, cuez_part_uid, cuez_read_speed, producer_user, producer_name").eq("id", bulletinId).maybeSingle();
  if (bErr) throw new HttpError(500, "Could not read the bulletin.", bErr.message);
  if (!bulletin) throw new HttpError(404, "That newsroom doesn't exist.");
  // Once someone has claimed producer, sending is theirs alone. With no
  // producer (a newsroom not using conference), any member can send. A
  // producer who is no longer a member doesn't count: the database frees the
  // role when members are removed, and this covers anything that predates it.
  if (bulletin.producer_user && bulletin.producer_user !== ctx.userId) {
    const { data: still, error: pErr } = await db.from("newsroom_members")
      .select("user_id").eq("bulletin_id", bulletinId).eq("user_id", bulletin.producer_user).maybeSingle();
    if (pErr) throw new HttpError(500, "Could not check who the producer is.", pErr.message);
    if (still) throw new HttpError(403, `Only the producer${bulletin.producer_name ? ` (${bulletin.producer_name})` : ""} can send to Cuez.`);
  }
  if (!bulletin.cuez_episode_id || !bulletin.cuez_part_uid) {
    throw new HttpError(400, "Choose a Cuez episode and part for this newsroom first.");
  }

  // One send per newsroom at a time.
  const { data: claimed, error: cErr } = await db.rpc("claim_cuez_send", {
    p_bulletin_id: bulletinId, p_stale_seconds: SEND_CLAIM_SECONDS,
  });
  if (cErr) throw new HttpError(500, "Could not start the send.", cErr.message);
  if (!claimed) throw new HttpError(409, "Someone in this newsroom is already sending to Cuez. Try again in a moment.");

  try {
    const episodeId = requireUuid(bulletin.cuez_episode_id, "Cuez episode");
    const partUid = requireUuid(bulletin.cuez_part_uid, "Cuez part");

    const { data: rows, error: sErr } = await db.from("stories")
      .select("id, slug, script, format, type, is_floated, rev, cuez_item_uid, cuez_item_number, cuez_pending_uid, cuez_pending_at, cuez_pending_rev, cuez_pending_plan")
      .eq("bulletin_id", bulletinId);
    if (sErr) throw new HttpError(500, "Could not read the stories.", sErr.message);
    const byId = new Map((rows ?? []).map((r: any) => [r.id, r]));

    // The running order Cuez should reflect: above the line, no segments, no floats.
    const order: string[] = Array.isArray(bulletin.order_ids) ? bulletin.order_ids : [];
    const markerIdx = order.indexOf("marker-line");
    const live = (markerIdx > -1 ? order.slice(0, markerIdx) : order)
      .map((id) => byId.get(id))
      .filter((r: any) => r && r.type !== "segment" && !r.is_floated);

    const episode = await loadEpisode(ctx, episodeId);
    const partItems = requirePart(episode, partUid);
    const tpl = templateInfo(episode);

    // Keep the desk's read-time estimate in step with how Cuez times the prompter.
    if (tpl.readSpeed && tpl.readSpeed !== bulletin.cuez_read_speed) {
      await db.from("bulletins").update({ cuez_read_speed: tpl.readSpeed }).eq("id", bulletinId);
    }

    // Reconcile earlier sends whose outcome wasn't confirmed. Each send records
    // its item ID and exactly what it sent BEFORE writing. That identity is kept
    // until the item is seen in Cuez: a story that isn't there yet is re-sent
    // with the same item ID and the same content, never a fresh one. Elapsed time
    // proves nothing (Cuez can return an out-of-date read, or the first write can
    // land late), so the retry is built to collide with the original instead.
    const inSomePart = (uid: string) =>
      Object.values(episode.parts ?? {}).some((p: any) => Array.isArray(p?.items) && p.items.includes(uid));
    const adopted: string[] = [];
    const held: { storyId: string; slug: string; reason: "elsewhere" | "legacy" }[] = [];
    const retryPlan = new Map<string, { itemUid: string; slug: string; blocks: Block[]; repair: boolean }>();
    const validPlan = (plan: any) => plan && typeof plan.slug === "string" && Array.isArray(plan.blocks);
    for (const r of live as any[]) {
      if (r.cuez_item_uid || !r.cuez_pending_uid) continue;
      const plan = r.cuez_pending_plan;
      if (partItems.includes(r.cuez_pending_uid) && validPlan(plan)) {
        // There, but only "sent" if the whole story is: otherwise repair it.
        const exp = await expectedStory(r.id, plan.slug, r.cuez_pending_uid, plan.blocks, tpl, true);
        if (!checkStory(exp, episode, partUid).complete) {
          retryPlan.set(r.id, { itemUid: r.cuez_pending_uid, slug: plan.slug, blocks: plan.blocks, repair: true });
          continue;
        }
      }
      if (partItems.includes(r.cuez_pending_uid)) {
        // Complete, or recorded by an older version with no plan to check against.
        const update = {
          cuez_item_uid: r.cuez_pending_uid, cuez_sent_at: r.cuez_pending_at ?? new Date().toISOString(),
          cuez_sent_rev: r.cuez_pending_rev ?? r.rev, cuez_item_number: numberOf(episode.items, r.cuez_pending_uid),
          cuez_pending_uid: null, cuez_pending_at: null, cuez_pending_rev: null, cuez_pending_plan: null,
        };
        const { error } = await db.from("stories").update(update).eq("id", r.id);
        if (error) throw new HttpError(500, "Could not record a story that is already in Cuez.", error.message);
        Object.assign(r, update);
        adopted.push(r.slug);
      } else if (inSomePart(r.cuez_pending_uid)) {
        held.push({ storyId: r.id, slug: r.slug, reason: "elsewhere" });
      } else {
        if (!validPlan(plan)) {
          // Recorded by an older version that didn't keep what it sent, so a
          // retry couldn't be made identical. A person has to check Cuez.
          held.push({ storyId: r.id, slug: r.slug, reason: "legacy" });
        } else {
          retryPlan.set(r.id, { itemUid: r.cuez_pending_uid, slug: plan.slug, blocks: plan.blocks, repair: false });
        }
      }
    }
    const heldIds = new Set(held.map((h) => h.storyId));
    const heldNote = held.length
      ? ` Held back: ${held.map((h) => h.reason === "elsewhere"
          ? `${h.slug} (already in Cuez, but in a different part: check Cuez, then mark it as not sent to resend)`
          : `${h.slug} (an earlier send wasn't confirmed: check Cuez, then mark it as not sent to resend)`).join("; ")}.`
      : "";
    const adoptedNote = adopted.length ? ` Confirmed from an earlier send: ${adopted.join(", ")}.` : "";

    // Sent stories that are no longer in that part are reported, not re-sent.
    const missingInCuez = live
      .filter((r: any) => r.cuez_item_uid && !partItems.includes(r.cuez_item_uid))
      .map((r: any) => ({ storyId: r.id, slug: r.slug }));

    const toSend = live.filter((r: any) => !r.cuez_item_uid && !heldIds.has(r.id));
    if (!toSend.length) {
      await refreshNumbers(db, live, episode.items);
      return json({ ok: true, stage: "done", message: `Nothing new to send.${adoptedNote}${heldNote}`, results: [], missingInCuez, held, adopted });
    }
    if (toSend.length > MAX_STORIES) throw new HttpError(400, `Send at most ${MAX_STORIES} stories at a time.`);

    const sequence = live
      .filter((r: any) => !heldIds.has(r.id))
      .map((r: any) => {
        if (!r.cuez_item_uid) {
          const again = retryPlan.get(r.id);
          // A repair is already in place, so it anchors placement like a sent story.
          if (again?.repair) return { existing: again.itemUid };
          if (again) return { story: { ref: r.id, slug: again.slug, blocks: again.blocks, itemUid: again.itemUid, retry: true } };
          const slug = cleanSlug(r.slug);
          return { story: { ref: r.id, slug, blocks: storyBlocks(r.script ?? "", r.format ?? "", slug, capsOf(tpl)) } };
        }
        return partItems.includes(r.cuez_item_uid) ? { existing: r.cuez_item_uid as string } : null;
      })
      .filter(Boolean) as ({ existing: string } | { story: StoryIn })[];

    const { placed } = planPlacement(partItems, sequence);
    for (const [ref, again] of retryPlan) {
      if (again.repair) placed.push({ ref, slug: again.slug, blocks: again.blocks, itemUid: again.itemUid, retry: true, repair: true, placeAfter: null, position: 0 });
    }
    const { operations, created } = await buildBatch({
      projectId: episode.episode.project_id, episodeId, partUid, placed, tpl, contextFieldId: ctx.contextFieldId,
    });

    // Record each new story's identity and content BEFORE writing to Cuez. A
    // retried story keeps the identity it already has.
    const rowById = new Map(toSend.map((r: any) => [r.id, r]));
    const placedByRef = new Map(placed.map((p) => [p.ref, p]));
    const sentAt = new Date().toISOString();
    for (const c of created) {
      if (c.retry) continue;
      const p = placedByRef.get(c.ref)!;
      const { error } = await db.from("stories")
        .update({
          cuez_pending_uid: c.itemUid, cuez_pending_at: sentAt,
          cuez_pending_rev: rowById.get(c.ref)?.rev ?? null,
          cuez_pending_plan: { slug: p.slug, blocks: p.blocks },
        })
        .eq("id", c.ref);
      if (error) throw new HttpError(500, "Could not record the send before writing to Cuez, so nothing was sent.", error.message);
    }

    let result: Awaited<ReturnType<typeof writeAndVerify>>;
    try {
      result = await writeAndVerify({ token: ctx.token, clientInstance: ctx.clientInstance, episodeId, partUid, operations, created });
    } catch (e) {
      if (e instanceof HttpError) {
        e.message += " The stories are marked Unconfirmed; the next send checks Cuez and, if needed, sends them again under the same identity.";
      }
      throw e;
    }

    // Record what landed, against the revision that was actually sent.
    const sentRev = (c: { ref: string; retry: boolean }) => c.retry
      ? (rowById.get(c.ref)?.cuez_pending_rev ?? null)
      : (rowById.get(c.ref)?.rev ?? null);
    // Only a complete story is sent. An incomplete one keeps its identity and
    // plan, so the next send repairs it in place.
    const landed = created.filter((_c, i) => result.checks[i].complete);
    const incomplete = created
      .map((c, i) => ({ c, k: result.checks[i] }))
      .filter(({ c, k }) => !k.complete && result.partItems.includes(c.itemUid));
    const contentUnchecked = result.checks.some((k) => k.contentUnchecked);
    const disordered = landed.filter((c) => result.checks[created.indexOf(c)].warnings.length).map((c) => c.slug);
    const writeFailures: string[] = [];
    for (const c of landed) {
      const { error } = await db.from("stories")
        .update({
          cuez_item_uid: c.itemUid,
          cuez_sent_at: c.retry ? (rowById.get(c.ref)?.cuez_pending_at ?? sentAt) : sentAt,
          cuez_sent_rev: sentRev(c),
          cuez_item_number: numberOf(result.after?.items, c.itemUid),
          cuez_pending_uid: null, cuez_pending_at: null, cuez_pending_rev: null, cuez_pending_plan: null,
        })
        .eq("id", c.ref);
      if (error) writeFailures.push(c.slug);
    }
    // Items inserted mid-rundown renumber the ones below, so refresh those too.
    await refreshNumbers(db, live, result.after?.items);

    const problems = result.httpFailed || result.unexpectedEvents.length > 0;
    const ok = !result.missing.length && !incomplete.length && result.inOrder && !writeFailures.length && !problems;
    const retriedCount = created.filter((c) => c.retry).length;
    let message = `Sent ${landed.length} stor${landed.length === 1 ? "y" : "ies"} to Cuez.`;
    if (retriedCount) message += ` (${retriedCount === 1 ? "One was a retry" : `${retriedCount} were retries`} of an earlier unconfirmed send, under the same identity.)`;
    if (incomplete.length) {
      message += ` Not complete in Cuez: ${incomplete.map(({ c, k }) => `${c.slug} (${k.problems.join(", ")})`).join("; ")}. ${incomplete.length === 1 ? "It stays" : "They stay"} Unconfirmed; the next send repairs ${incomplete.length === 1 ? "it" : "them"} in place.`;
    }
    if (result.missing.length) {
      const n = result.missing.length;
      message += ` Cuez doesn't show ${n} of ${created.length} ${created.length === 1 ? "story" : "stories"} in the part yet. ${n === 1 ? "It stays" : "They stay"} Unconfirmed; the next send looks for ${n === 1 ? "it" : "them"} first and only resends under the same identity.`;
    } else if (!result.inOrder) {
      message += " Check the order in Cuez: the items didn't land where expected.";
    }
    if (disordered.length) {
      message += ` Sent, but with blocks in a different order from the script: ${disordered.join(", ")}. Check ${disordered.length === 1 ? "it" : "them"} in Cuez.`;
    }
    if (contentUnchecked) {
      message += " Note: Cuez didn't return block content in a form this version recognises, so blocks were checked but their content wasn't.";
    }
    if (problems) {
      message += result.httpFailed
        ? ` Cuez answered with HTTP ${result.httpStatus}.`
        : ` Cuez reported problems with: ${[...new Set(result.unexpectedEvents)].join(", ")}. Check those items in Cuez.`;
    }
    if (writeFailures.length) message += ` Couldn't mark as sent: ${writeFailures.join(", ")}. The next send will find them in Cuez rather than duplicate them.`;
    message += adoptedNote + heldNote;

    return json({
      ok,
      stage: ok ? "done" : "verify",
      message,
      results: created.map((c) => ({
        storyId: c.ref, slug: c.slug, itemUid: c.itemUid, clips: c.clips, retried: c.retry,
        number: result.after?.items?.[c.itemUid]?.number ?? null,
        landed: result.partItems.includes(c.itemUid),
        complete: result.checks[created.indexOf(c)].complete,
        problems: result.checks[created.indexOf(c)].problems,
        warnings: result.checks[created.indexOf(c)].warnings,
      })),
      cuez: result.cuez,
      missingInCuez, held, adopted,
    }, ok ? 200 : 502);
  } finally {
    await db.from("bulletins").update({ cuez_sending_at: null }).eq("id", bulletinId);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, message: "Use POST." }, 405);

  try {
    const token = Deno.env.get("CUEZ_BEARER_TOKEN")?.trim().replace(/^Bearer\s+/i, "") || "";
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new HttpError(500, "The function has no Supabase service credentials.");
    const db = createClient(url, key, { auth: { persistSession: false } });

    const userId = await requireUser(db, req);

    let body: any;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, "Body must be JSON.");
    }

    const ctx: Ctx = {
      token,
      allowedProject: Deno.env.get("CUEZ_PROJECT_ID")?.trim() || null,
      contextFieldId: Deno.env.get("CUEZ_CONTEXT_FIELD_ID")?.trim() || undefined,
      clientInstance: crypto.randomUUID(),
      db,
      userId,
    };

    // Check access even when the token is missing, so admins can see that
    // status without exposing configuration details to students.
    if (body?.action === "token-status") {
      if (!(await isAdmin(ctx))) throw new HttpError(403, "Only admins can check Cuez token expiry.");
      return json(tokenExpiryStatus(token));
    }
    if (!token) throw new HttpError(500, "CUEZ_BEARER_TOKEN is not set on the function.");

    switch (body?.action) {
      case "parts": return await actionParts(ctx, body);
      case "send-bulletin": return await actionSendBulletin(ctx, body);
      default: throw new HttpError(400, `Unknown action "${body?.action}".`);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ ok: false, message: err.message, detail: err.detail ?? null }, err.status);
    }
    console.error(err);
    return json({ ok: false, message: "Unexpected error in send-to-cuez. Stories that were on their way show as Unconfirmed: the next send looks for them in Cuez first.", detail: String(err) }, 500);
  }
});
