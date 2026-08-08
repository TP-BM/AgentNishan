import nodemailer from "nodemailer";
import { Resend } from "resend";
import { config } from "./config.ts";
import type { Digest } from "./digest.ts";
import { escapeHtml } from "./views.ts";

export interface Mailer {
  send(message: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<void>;
}

function resendMailer(): Mailer {
  if (config.mail.resendApiKey === "") {
    throw new Error("MAILER=resend but RESEND_API_KEY is not set.");
  }
  const resend = new Resend(config.mail.resendApiKey);

  return {
    async send(message) {
      const { error } = await resend.emails.send({
        from: config.mail.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
      if (error !== null) {
        throw new Error(`Resend refused the message: ${error.message}`);
      }
    },
  };
}

function smtpMailer(): Mailer {
  const { host, port, user, pass } = config.mail.smtp;
  if (host === "" || user === "" || pass === "") {
    throw new Error("MAILER=smtp but SMTP_HOST / SMTP_USER / SMTP_PASS are incomplete.");
  }

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  return {
    async send(message) {
      await transport.sendMail({
        from: config.mail.from === "" ? user : config.mail.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
    },
  };
}

function noopMailer(): Mailer {
  return {
    async send(message) {
      console.log(`[mail] MAILER=none, skipping send: "${message.subject}"`);
    },
  };
}

let cached: Mailer | null = null;

export function mailer(): Mailer {
  if (cached === null) {
    cached =
      config.mail.kind === "resend"
        ? resendMailer()
        : config.mail.kind === "smtp"
          ? smtpMailer()
          : noopMailer();
  }
  return cached;
}

// --- message bodies ----------------------------------------------------------

export function digestSubject(digest: Digest): string {
  const mine = digest.action_items.filter((a) => a.is_mine).length;
  const decisions = digest.decisions.length;
  const parts = [
    `${decisions} decision${decisions === 1 ? "" : "s"}`,
    `${mine} for you`,
  ];
  const title = digest.title.trim() === "" ? "Meeting" : digest.title.trim();
  return `Digest: ${title} — ${parts.join(", ")}`;
}

export function digestEmail(
  digest: Digest,
  meetingUrl: string,
): { html: string; text: string } {
  const mine = digest.action_items.filter((a) => a.is_mine);
  const others = digest.action_items.filter((a) => !a.is_mine);

  // --- text ---
  const textParts: string[] = [digest.summary, ""];

  textParts.push(mine.length > 0 ? "YOUR ACTION ITEMS" : "YOUR ACTION ITEMS: none");
  for (const item of mine) {
    textParts.push(`  - ${item.task}${item.due === "" ? "" : ` (due ${item.due})`}`);
  }
  textParts.push("");

  if (digest.decisions.length > 0) {
    textParts.push("DECISIONS");
    for (const d of digest.decisions) {
      textParts.push(`  - ${d.decision}${d.owner === "" ? "" : ` [${d.owner}]`}`);
    }
    textParts.push("");
  }

  if (others.length > 0) {
    textParts.push("OTHER ACTION ITEMS");
    for (const item of others) {
      textParts.push(`  - ${item.owner}: ${item.task}`);
    }
    textParts.push("");
  }

  if (digest.open_questions.length > 0) {
    textParts.push("OPEN QUESTIONS");
    for (const q of digest.open_questions) textParts.push(`  - ${q}`);
    textParts.push("");
  }

  textParts.push(`Full transcript: ${meetingUrl}`);

  // --- html ---
  const section = (title: string, body: string): string =>
    `<h2 style="font:600 13px/1.4 -apple-system,Segoe UI,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;margin:28px 0 10px">${escapeHtml(title)}</h2>${body}`;

  const list = (items: string[]): string =>
    items.length === 0
      ? `<p style="margin:0;color:#6b7280">Nothing recorded.</p>`
      : `<ul style="margin:0;padding-left:20px">${items.map((i) => `<li style="margin:0 0 8px">${i}</li>`).join("")}</ul>`;

  const html = `<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111827;max-width:640px;margin:0 auto;padding:24px">
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(digest.title || "Meeting digest")}</h1>
<p style="margin:0;color:#374151">${escapeHtml(digest.summary)}</p>

${section(
  mine.length > 0 ? `Your action items (${mine.length})` : "Your action items",
  list(
    mine.map(
      (i) =>
        `<strong>${escapeHtml(i.task)}</strong>${i.due === "" ? "" : ` <span style="color:#6b7280">— due ${escapeHtml(i.due)}</span>`}${
          i.evidence_quote === ""
            ? ""
            : `<br><span style="color:#6b7280;font-size:13px">“${escapeHtml(i.evidence_quote)}”</span>`
        }`,
    ),
  ),
)}

${section(
  "Decisions",
  list(
    digest.decisions.map(
      (d) =>
        `<strong>${escapeHtml(d.decision)}</strong>${d.owner === "" ? "" : ` <span style="color:#6b7280">— ${escapeHtml(d.owner)}</span>`}${
          d.rationale === ""
            ? ""
            : `<br><span style="color:#374151;font-size:14px">${escapeHtml(d.rationale)}</span>`
        }`,
    ),
  ),
)}

${
  others.length === 0
    ? ""
    : section(
        "Other action items",
        list(
          others.map(
            (i) =>
              `<strong>${escapeHtml(i.owner)}</strong> — ${escapeHtml(i.task)}${i.due === "" ? "" : ` <span style="color:#6b7280">(due ${escapeHtml(i.due)})</span>`}`,
          ),
        ),
      )
}

${
  digest.open_questions.length === 0
    ? ""
    : section("Open questions", list(digest.open_questions.map(escapeHtml)))
}

${digest.risks.length === 0 ? "" : section("Risks raised", list(digest.risks.map(escapeHtml)))}

<p style="margin:32px 0 0;padding-top:16px;border-top:1px solid #e5e7eb">
  <a href="${escapeHtml(meetingUrl)}" style="color:#2563eb">Read the full transcript →</a>
</p>
</div>`;

  return { html, text: textParts.join("\n") };
}

/**
 * `denied` distinguishes the two ways admission fails. They read very
 * differently to whoever gets this mail: nobody noticed the request, versus
 * somebody looked at it and said no.
 */
export function notAdmittedEmail(
  meetUrl: string,
  meetingUrl: string,
  denied = false,
): { subject: string; html: string; text: string } {
  const subject = denied
    ? "Notetaker was denied entry to the meeting"
    : "Notetaker was never let into the meeting";
  const headline = denied
    ? "No transcript — bot was denied"
    : "No transcript — bot wasn't admitted";
  const body = denied
    ? `someone in the meeting declined its request to join, so there is nothing to summarise.`
    : `it stayed in the lobby for the whole meeting, so there is nothing to summarise.`;
  const advice = denied
    ? "Let an attendee know the notetaker is coming, then send it again."
    : "Someone already in the meeting has to admit the bot. If this keeps happening, ask a regular attendee to let it in.";

  const text = `The bot was sent to ${meetUrl} but ${body}\n\n${advice}\n\n${meetingUrl}`;
  const html = `<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111827;max-width:640px;margin:0 auto;padding:24px">
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(headline)}</h1>
<p style="margin:0 0 16px;color:#374151">The bot was sent to <a href="${escapeHtml(meetUrl)}">${escapeHtml(meetUrl)}</a> but ${escapeHtml(body)}</p>
<p style="margin:0;color:#6b7280">${escapeHtml(advice)}</p>
<p style="margin:24px 0 0"><a href="${escapeHtml(meetingUrl)}" style="color:#2563eb">View in Sendlegate →</a></p>
</div>`;
  return { subject, html, text };
}
