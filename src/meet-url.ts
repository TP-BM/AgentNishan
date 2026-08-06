const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;

/**
 * Pull the `abc-defg-hij` code out of a pasted Meet URL, or accept a bare code.
 * Returns null for anything else — including a Meet-shaped code sitting inside
 * some other site's URL, which is far more likely to be a mistake than intent.
 */
export function parseMeetingId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  const looksLikeUrl = /^https?:\/\//i.test(trimmed) || trimmed.includes("/");

  if (looksLikeUrl) {
    let url: URL;
    try {
      url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    } catch {
      return null;
    }
    if (url.hostname.toLowerCase() !== "meet.google.com") return null;

    const code = url.pathname.split("/").filter(Boolean)[0] ?? "";
    return MEET_CODE.test(code) ? code.toLowerCase() : null;
  }

  return MEET_CODE.test(trimmed) ? trimmed.toLowerCase() : null;
}
