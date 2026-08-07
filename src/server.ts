import { createHash, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import { config } from "./config.ts";
import {
  ADMIN,
  createInvite,
  createMeeting,
  db,
  deleteMeeting,
  getDigest,
  getIdentity,
  getMeeting,
  getSegments,
  listInvites,
  listMeetings,
  revokeInvite,
  setSetting,
  updateMeeting,
  type Scope,
} from "./db.ts";
import { formatInviteToken } from "./invite.ts";
import { parseMeetingId } from "./meet-url.ts";
import { finalise, refetchAndDigest, startPoller, stopPoller } from "./poller.ts";
import { checkKeys, sendBot, VexaError } from "./vexa.ts";
import {
  STYLES,
  homePage,
  invitesPage,
  loginPage,
  meetingPage,
  settingsPage,
} from "./views.ts";

const app = Fastify({ logger: false });
await app.register(cookie, { secret: config.appSecret });
await app.register(formbody);

const SESSION_COOKIE = "mn_session";
const SESSION_VALUE = createHash("sha256")
  .update(`session:${config.appSecret}`)
  .digest("hex");

const PUBLIC_PATHS = new Set(["/login", "/healthz", "/styles.css"]);

function secretMatches(candidate: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(config.appSecret).digest();
  return timingSafeEqual(a, b);
}

declare module "fastify" {
  interface FastifyRequest {
    /** Who is asking. Set by the auth hook; every scoped read reads it here. */
    scope: Scope;
  }
}

/**
 * Resolve who is asking, once, before any handler runs.
 *
 * Handlers take the scope off the request rather than assuming admin, so
 * granting a second kind of caller (a demo invite) is a branch in this one
 * function instead of an audit of every route.
 */
app.addHook("onRequest", async (request, reply) => {
  request.scope = ADMIN;

  if (PUBLIC_PATHS.has(request.url.split("?")[0] ?? "")) return;

  const raw = request.cookies[SESSION_COOKIE];
  const unsigned = raw === undefined ? null : request.unsignCookie(raw);
  if (unsigned?.valid !== true || unsigned.value !== SESSION_VALUE) {
    return reply.redirect("/login");
  }

  // Everything under /admin is the owner's, stated once here rather than per
  // route — so a route added later under that prefix cannot be reachable by a
  // demo visitor just because someone forgot a check. Redundant today, since
  // only admin sessions exist; load-bearing the moment invite sessions do.
  if (request.url.startsWith("/admin") && request.scope.kind !== "admin") {
    return reply.redirect("/");
  }
});

function html(reply: import("fastify").FastifyReply, body: string): void {
  reply.type("text/html; charset=utf-8").send(body);
}

/** Flash messages ride in the query string; there is no server-side session store. */
function flashOf(query: unknown): { error: string; notice: string } {
  const q = (query ?? {}) as Record<string, unknown>;
  return {
    error: typeof q["err"] === "string" ? q["err"] : "",
    notice: typeof q["ok"] === "string" ? q["ok"] : "",
  };
}

// --- public ------------------------------------------------------------------

app.get("/healthz", async (_request, reply) => {
  reply.send({ ok: true });
});

app.get("/styles.css", async (_request, reply) => {
  reply
    .type("text/css; charset=utf-8")
    .header("cache-control", "public, max-age=3600")
    .send(STYLES);
});

app.get("/login", async (request, reply) => {
  html(reply, loginPage(flashOf(request.query).error));
});

app.post("/login", async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const secret = typeof body["secret"] === "string" ? body["secret"] : "";

  if (!secretMatches(secret)) {
    return reply.redirect("/login?err=" + encodeURIComponent("Wrong secret."));
  }

  reply.setCookie(SESSION_COOKIE, SESSION_VALUE, {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    secure: config.baseUrl.startsWith("https://"),
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return reply.redirect("/");
});

app.get("/logout", async (_request, reply) => {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  return reply.redirect("/login");
});

// --- meetings ----------------------------------------------------------------

app.get("/", async (request, reply) => {
  const { error, notice } = flashOf(request.query);
  html(
    reply,
    homePage(listMeetings(request.scope), error, notice, getIdentity(request.scope)),
  );
});

app.post("/meetings", async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const input = typeof body["url"] === "string" ? body["url"] : "";
  const nativeMeetingId = parseMeetingId(input);

  if (nativeMeetingId === null) {
    return reply.redirect(
      "/?err=" +
        encodeURIComponent(
          "That doesn't look like a Google Meet link. Expected something like https://meet.google.com/abc-defg-hij",
        ),
    );
  }

  // Dispatch before persisting, so a rejected bot doesn't leave a dead row behind.
  let vexaMeetingId: string | null = null;
  try {
    vexaMeetingId = await sendBot(nativeMeetingId);
  } catch (error) {
    const message =
      error instanceof VexaError
        ? error.friendly()
        : `Could not reach Vexa: ${(error as Error).message}`;
    return reply.redirect("/?err=" + encodeURIComponent(message));
  }

  const meeting = createMeeting({
    meetUrl: `https://meet.google.com/${nativeMeetingId}`,
    nativeMeetingId,
    title: nativeMeetingId,
    scope: request.scope,
  });
  if (vexaMeetingId !== null) {
    updateMeeting(meeting.id, { vexa_meeting_id: vexaMeetingId });
  }

  return reply.redirect(`/m/${meeting.id}`);
});

app.get<{ Params: { id: string } }>("/m/:id", async (request, reply) => {
  const meeting = getMeeting(request.scope, request.params.id);
  if (meeting === undefined) {
    return reply.redirect("/?err=" + encodeURIComponent("Meeting not found."));
  }
  const { error, notice } = flashOf(request.query);
  html(
    reply,
    meetingPage(
      meeting,
      getDigest(meeting.id),
      getSegments(meeting.id),
      error,
      notice,
    ),
  );
});

app.post<{ Params: { id: string } }>("/m/:id/end", async (request, reply) => {
  const meeting = getMeeting(request.scope, request.params.id);
  if (meeting === undefined) {
    return reply.redirect("/?err=" + encodeURIComponent("Meeting not found."));
  }

  // Redirect immediately — the digest call takes a while and shouldn't block
  // the response.
  void finalise(meeting.id, "ended manually").catch((error: Error) => {
    console.error("[web] manual finalise failed:", error.message);
  });

  return reply.redirect(
    `/m/${meeting.id}?ok=` +
      encodeURIComponent("Ending the meeting and generating the digest…"),
  );
});

app.post<{ Params: { id: string } }>("/m/:id/retry", async (request, reply) => {
  const meeting = getMeeting(request.scope, request.params.id);
  if (meeting === undefined) {
    return reply.redirect("/?err=" + encodeURIComponent("Meeting not found."));
  }

  // Re-pull from Vexa rather than reusing local segments — the usual reason for
  // a retry is that the local copy is missing or partial.
  void refetchAndDigest(meeting.id).catch((error: Error) => {
    console.error("[web] retry digest failed:", error.message);
  });

  return reply.redirect(
    `/m/${meeting.id}?ok=` +
      encodeURIComponent("Fetching the transcript and regenerating the digest…"),
  );
});

app.post<{ Params: { id: string } }>("/m/:id/delete", async (request, reply) => {
  deleteMeeting(request.scope, request.params.id);
  return reply.redirect("/?ok=" + encodeURIComponent("Meeting deleted."));
});

// --- invites (owner only) ----------------------------------------------------

app.get("/admin/invites", async (request, reply) => {
  const { error, notice } = flashOf(request.query);
  html(reply, invitesPage(listInvites(), config.baseUrl, error, notice));
});

app.post("/admin/invites", async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const label = typeof body["label"] === "string" ? body["label"].trim() : "";

  if (label === "") {
    return reply.redirect(
      "/admin/invites?err=" + encodeURIComponent("Give the invite a name."),
    );
  }

  const invite = createInvite({ label });
  return reply.redirect(
    "/admin/invites?ok=" +
      encodeURIComponent(
        `Invite for ${label}: ${formatInviteToken(invite.token)} — copy the link below.`,
      ),
  );
});

app.post<{ Params: { token: string } }>(
  "/admin/invites/:token/revoke",
  async (request, reply) => {
    revokeInvite(request.params.token);
    return reply.redirect(
      "/admin/invites?ok=" + encodeURIComponent("Invite revoked — the link no longer works."),
    );
  },
);

// --- settings ----------------------------------------------------------------

app.get("/settings", async (request, reply) => {
  const { error, notice } = flashOf(request.query);
  html(reply, settingsPage(getIdentity(request.scope), error, notice));
});

app.post("/settings", async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const str = (key: string): string =>
    typeof body[key] === "string" ? (body[key] as string).trim() : "";

  setSetting("display_name", str("display_name"));
  setSetting("aliases", str("aliases"));
  setSetting("notify_email", str("notify_email"));

  return reply.redirect("/settings?ok=" + encodeURIComponent("Saved."));
});

// --- lifecycle ---------------------------------------------------------------

await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`[web] MeetNish listening on ${config.baseUrl}`);
console.log(
  `[web] mailer=${config.mail.kind} model=${config.anthropic.model} poll=${config.poll.intervalMs}ms`,
);
// Checked at boot, not after a meeting: a key pair that can dispatch bots but
// not read transcripts fails silently until the meeting is already over.
const keyCheck = await checkKeys();
if (keyCheck.bot !== null) {
  console.error(`\n  ⚠  Bot key problem: ${keyCheck.bot}\n     Bots cannot be sent.\n`);
}
if (keyCheck.tx !== null) {
  console.error(
    `\n  ⚠  Transcription key problem: ${keyCheck.tx}\n` +
      `     Bots will join meetings, but nothing can be transcribed or digested.\n`,
  );
}
if (keyCheck.bot === null && keyCheck.tx === null) {
  console.log("[vexa] both keys OK (bot + transcription)");
}

startPoller();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n[web] ${signal} received, shutting down`);
    stopPoller();
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
