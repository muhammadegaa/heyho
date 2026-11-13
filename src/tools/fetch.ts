import { declined, fail, ok, type Tool } from "./types.ts";

const MAX_CHARS = 8000;
const TIMEOUT_MS = 20_000;

// Readable text from an HTML page: its title, then the body with scripts, styles and tags
// removed and entities decoded.
export function htmlToText(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  return ((title.trim() ? `<p>${title}</p>\n` : "") + html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, ""))
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|pre|br)\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const fetchTool: Tool = {
  name: "fetch",
  description: "Get the text of a web page, for documentation.",
  parameters: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
  async run(args, ctx) {
    let url: URL;
    try {
      url = new URL(String(args.url));
    } catch {
      return fail(`"${args.url}" is not a URL.`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return fail("Only http and https URLs can be fetched.");
    const no = await declined(ctx, "fetch", url.href);
    if (no) return no;
    try {
      const res = await fetch(url, { signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
      const body = await res.text();
      const text = /html/i.test(res.headers.get("content-type") ?? "") ? htmlToText(body) : body;
      const head = `${res.status} ${res.statusText} · ${url.href}`;
      if (!res.ok) return fail(`${head}\n${text.slice(0, 500)}`);
      return ok(`${head}\n${text.slice(0, MAX_CHARS)}${text.length > MAX_CHARS ? `\n[cut: ${text.length - MAX_CHARS} more characters]` : ""}`);
    } catch (e) {
      return fail(`Could not fetch ${url.href}: ${(e as Error).message}`);
    }
  },
};
