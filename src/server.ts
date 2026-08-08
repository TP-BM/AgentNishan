import { createHash, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import { config } from "./config.ts";
import {
  ADMIN,
  consumeInvite,
  createInvite,
  createMeeting,
  db,
  deleteMeeting,
  getDigest,
  getIdentity,
  getInvite,
  getMeeting,
  getSegments,
  listInvites,
  listMeetings,
  refundInvite,
  revokeInvite,
  setSetting,
  updateMeeting,
  type Scope,
} from "./db.ts";
import {
  formatInviteToken,
  inviteUsable,
  normaliseInviteToken,
} from "./invite.ts";
import { parseMeetingId } from "./meet-url.ts";
import { finalise, refetchAndDigest, startPoller, stopPoller } from "./poller.ts";
import { checkKeys, sendBot, VexaError } from "./vexa.ts";
import {
  STYLES,
  homePage,
  inviteClosedPage,
  landingPage,
  invitesPage,
  loginPage,
  meetingPage,
  settingsPage,
  tryPage,
} from "./views.ts";

// trustProxy: Fly always fronts this app, so the socket address is its proxy
// and every visitor would otherwise share one rate-limit bucket — one person
// mistyping a code would lock out everyone. Only safe because the app is never
// reachable directly; exposed on its own, the header would be forgeable.
const app = Fastify({ logger: false, trustProxy: true });
await app.register(cookie, { secret: config.appSecret });
await app.register(formbody);

const SESSION_COOKIE = "mn_session";
const SESSION_VALUE = createHash("sha256")
  .update(`session:${config.appSecret}`)
  .digest("hex");

const PUBLIC_PATHS = new Set(["/login", "/healthz", "/styles.css", "/code"]);

/**
 * A demo visitor's session. Separate cookie from the owner's, so the two can
 * coexist in one browser — you can hold an invite open in a tab while still
 * being logged in as yourself, which is how this gets tested.
 */
const INVITE_COOKIE = "mn_invite";

/**
 * Guessing an 8-character token is hopeless, but guesses are cheap, so cap the
 * typed-code route. In-memory is right at this scale: it resets on deploy, and
 * the thing it protects is not a secret worth more than that.
 */
const codeAttempts = new Map<string, { count: number; resetAt: number }>();
const CODE_LIMIT = 10;
const CODE_WINDOW_MS = 60 * 60 * 1000;

/** How many times a guest may re-run the digest on their one meeting. */
const GUEST_DIGEST_LIMIT = 3;

function tooManyCodeAttempts(ip: string, now = Date.now()): boolean {
  const entry = codeAttempts.get(ip);
  if (entry === undefined || now >= entry.resetAt) {
    codeAttempts.set(ip, { count: 1, resetAt: now + CODE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > CODE_LIMIT;
}

function secretMatches(candidate: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(config.appSecret).digest();
  return timingSafeEqual(a, b);
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Who is asking, or null for an unauthenticated request.
     *
     * Nullable on purpose. It used to default to ADMIN, which was harmless
     * while every route was behind the login — and a trap the moment a public
     * route existed, because a stranger's request would have arrived carrying
     * the owner's scope. Null makes that a type error instead.
     */
    scope: Scope | null;
  }
}

/** For routes behind the auth hook, which guarantees a scope. */
function requireScope(request: import("fastify").FastifyRequest): Scope {
  if (request.scope === null) {
    throw new Error("a route reachable without a session read request.scope");
  }
  return request.scope;
}

/**
 * The invite a request carries, if any.
 *
 * Deliberately does NOT check `inviteUsable`: a spent invite must still be able
 * to read the meeting it produced. Usability gates *starting* a run; the cookie
 * grants *seeing* what that run made. Conflating the two would hand someone a
 * digest link that stops working the moment their one meeting is used up.
 */
function inviteFromCookie(request: import("fastify").FastifyRequest) {
  const raw = request.cookies[INVITE_COOKIE];
  if (raw === undefined) return undefined;
  const unsigned = request.unsignCookie(raw);
  if (unsigned.valid !== true || unsigned.value === null) return undefined;
  return getInvite(unsigned.value);
}

/**
 * Resolve who is asking, once, before any handler runs.
 *
 * Handlers take the scope off the request rather than assuming admin, so
 * granting a second kind of caller (a demo invite) is a branch in this one
 * function instead of an audit of every route.
 */
app.addHook("onRequest", async (request, reply) => {
  const raw = request.cookies[SESSION_COOKIE];
  const unsigned = raw === undefined ? null : request.unsignCookie(raw);
  if (unsigned?.valid === true && unsigned.value === SESSION_VALUE) {
    request.scope = ADMIN;
  } else {
    const invite = inviteFromCookie(request);
    request.scope = invite === undefined ? null : { kind: "invite", token: invite.token };
  }

  // `/` is public but not scope-free: a signed-in visitor gets their meetings
  // there and a stranger gets the pitch, so the handler branches on scope
  // rather than the hook turning them away.
  const path = request.url.split("?")[0] ?? "";
  if (PUBLIC_PATHS.has(path) || path === "/" || path.startsWith("/try/")) return;

  if (request.scope === null) return reply.redirect("/login");

  // Everything under /admin is the owner's, stated once here rather than per
  // route — so a route added later under that prefix cannot be reachable by a
  // demo visitor just because someone forgot a check. Redundant today, since
  // only admin sessions exist; load-bearing the moment invite sessions do.
  if (request.url.startsWith("/admin") && request.scope?.kind !== "admin") {
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

// --- demo invites (public) ---------------------------------------------------

/**
 * Someone typed a code instead of following a link — the same value, entered
 * the other way. Normalising here means a code read off a screen ("that's an
 * ell, or a one?") still lands on the right invite.
 */
app.post("/code", async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const typed = typeof body["code"] === "string" ? body["code"] : "";
  const token = normaliseInviteToken(typed);

  if (tooManyCodeAttempts(request.ip)) {
    return reply
      .code(429)
      .type("text/html; charset=utf-8")
      .send(inviteClosedPage("Too many attempts. Try again in an hour."));
  }
  if (token === "") {
    return reply.redirect("/login");
  }
  return reply.redirect(`/try/${encodeURIComponent(token)}`);
});

app.get<{ Params: { token: string } }>("/try/:token", async (request, reply) => {
  const token = normaliseInviteToken(request.params.token);
  const invite = getInvite(token);

  // One message for "spent", "revoked" and "never existed" — a stranger poking
  // at tokens learns nothing from the difference.
  if (invite === undefined) {
    return reply
      .type("text/html; charset=utf-8")
      .send(inviteClosedPage("That invite link isn't valid. Ask Thilina for a new one."));
  }
  const verdict = inviteUsable(invite, Date.now());
  if (!verdict.usable) {
    return reply
      .type("text/html; charset=utf-8")
      .send(inviteClosedPage(verdict.reason));
  }

  reply.setCookie(INVITE_COOKIE, invite.token, {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    secure: config.baseUrl.startsWith("https://"),
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });

  const { error, notice } = flashOf(request.query);
  html(reply, tryPage(invite, error, notice));
});

app.post<{ Params: { token: string } }>("/try/:token", async (request, reply) => {
  const token = normaliseInviteToken(request.params.token);
  const invite = getInvite(token);
  const back = (message: string): string =>
    `/try/${encodeURIComponent(token)}?err=${encodeURIComponent(message)}`;

  if (invite === undefined) {
    return reply
      .type("text/html; charset=utf-8")
      .send(inviteClosedPage("That invite link isn't valid. Ask Thilina for a new one."));
  }

  const body = (request.body ?? {}) as Record<string, unknown>;
  // Capped here, not just with a maxlength attribute: the objective is pasted
  // into the digest prompt and the bot name into Vexa's payload, and neither
  // should be sized by whoever is posting the form.
  const str = (key: string, limit = 200): string =>
    typeof body[key] === "string" ? (body[key] as string).trim().slice(0, limit) : "";

  const email = str("email", 254);
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    return reply.redirect(back("That email address doesn't look right."));
  }

  const nativeMeetingId = parseMeetingId(str("url"));
  if (nativeMeetingId === null) {
    return reply.redirect(
      back(
        "That doesn't look like a Google Meet link. Expected something like https://meet.google.com/abc-defg-hij",
      ),
    );
  }

  // Spend the invite *before* dispatching, and refund on failure. The guard
  // lives in the UPDATE, so two submissions of the same link race to one
  // winner rather than both passing a read-then-write check and sending two
  // bots. A refund on a Vexa error is cheaper than burning someone's one go.
  if (!consumeInvite(invite.token)) {
    return reply
      .type("text/html; charset=utf-8")
      .send(
        inviteClosedPage("This invite has already been used. Ask Thilina for a new one."),
      );
  }

  const botName = str("bot_name", 60) === "" ? config.vexa.botName : str("bot_name", 60);
  let vexaMeetingId: string | null = null;
  try {
    vexaMeetingId = await sendBot(nativeMeetingId, botName);
  } catch (error) {
    refundInvite(invite.token);
    const message =
      error instanceof VexaError
        ? error.friendly()
        : `Could not reach Vexa: ${(error as Error).message}`;
    return reply.redirect(back(message));
  }

  const scope: Scope = { kind: "invite", token: invite.token };
  const meeting = createMeeting({
    meetUrl: `https://meet.google.com/${nativeMeetingId}`,
    nativeMeetingId,
    title: str("title") === "" ? nativeMeetingId : str("title"),
    scope,
    notifyEmail: email,
    objective: str("objective", 500) === "" ? null : str("objective", 500),
    botName,
  });
  if (vexaMeetingId !== null) {
    updateMeeting(meeting.id, { vexa_meeting_id: vexaMeetingId });
  }

  reply.setCookie(INVITE_COOKIE, invite.token, {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    secure: config.baseUrl.startsWith("https://"),
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return reply.redirect(`/m/${meeting.id}`);
});

// --- meetings ----------------------------------------------------------------

app.get("/", async (request, reply) => {
  const { error, notice } = flashOf(request.query);
  const scope = request.scope;

  if (scope === null) {
    return html(reply, landingPage(error));
  }

  const invite = scope.kind === "invite" ? getInvite(scope.token) : undefined;
  html(
    reply,
    homePage(listMeetings(scope), error, notice, getIdentity(scope), {
      canDispatch: scope.kind === "admin",
      resumeToken:
        invite !== undefined && inviteUsable(invite, Date.now()).usable
          ? invite.token
          : null,
    }),
  );
});

/**
 * The owner's own dispatch. Guests never come through here — their bot is sent
 * by POST /try/:token, which spends the invite first. Without this check an
 * invite session could sit on this route and send bots forever, since nothing
 * else in the path counts them.
 */
app.post("/meetings", async (request, reply) => {
  if (requireScope(request).kind !== "admin") return reply.redirect("/");
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
    scope: requireScope(request),
  });
  if (vexaMeetingId !== null) {
    updateMeeting(meeting.id, { vexa_meeting_id: vexaMeetingId });
  }

  return reply.redirect(`/m/${meeting.id}`);
});

app.get<{ Params: { id: string } }>("/m/:id", async (request, reply) => {
  const meeting = getMeeting(requireScope(request), request.params.id);
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
  const meeting = getMeeting(requireScope(request), request.params.id);
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
  const meeting = getMeeting(requireScope(request), request.params.id);
  if (meeting === undefined) {
    return reply.redirect("/?err=" + encodeURIComponent("Meeting not found."));
  }

  // Each retry is a fresh Opus call. The owner can spend their own money; a
  // guest holds a link that may have been forwarded, so cap them.
  if (requireScope(request).kind !== "admin" && meeting.digest_runs >= GUEST_DIGEST_LIMIT) {
    return reply.redirect(
      `/m/${meeting.id}?err=` +
        encodeURIComponent("This demo has already regenerated its digest a few times."),
    );
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
  deleteMeeting(requireScope(request), request.params.id);
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

/**
 * Settings are global, single-row and the owner's. Notably `notify_email` is
 * where every one of the owner's digests is sent — so an unguarded write here
 * is not a defacement, it is mail redirection.
 */
app.get("/settings", async (request, reply) => {
  if (requireScope(request).kind !== "admin") return reply.redirect("/");
  const { error, notice } = flashOf(request.query);
  html(reply, settingsPage(getIdentity(requireScope(request)), error, notice));
});

app.post("/settings", async (request, reply) => {
  if (requireScope(request).kind !== "admin") return reply.redirect("/");
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
