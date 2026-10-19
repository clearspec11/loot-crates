/*
  What a pull's chat card turns into once the pull is refunded, and which
  card that is, with no Foundry in them so Vitest can run them. The caller
  passes its own escape function (foundry.utils.escapeHTML in a world).

  After a refund the card stays where it was in chat but stops announcing a
  win: muted (lc-chat--refunded), the name struck through and linked to the
  pool's source instead of the deleted copy on the sheet, and a line saying
  when it was refunded, the same time the manager's log shows.
*/

export const REFUNDED_CLASS = "lc-chat--refunded";
// A card from before pulls carried their log row's id is matched by item,
// buyer and time instead: the card posts when the spin lands, a few seconds
// after the row is written.
export const LEGACY_WINDOW_MS = 60000;

const flagsOf = msg => msg?.flags?.["loot-crates"] ?? {};

// "20 Oct 2026, 14:05" in the viewer's locale.
export const refundTime = at => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/*
  The newest message that announced this log row's pull, or null. Cards
  carrying a logId match on it alone; older cards (no logId) match on the
  pool source's uuid, the buyer as speaker, and a timestamp within
  LEGACY_WINDOW_MS of the row. Refund cards never match.
*/
export function findPullCard(messages, row) {
  const list = [...(messages ?? [])];
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    const f = flagsOf(msg);
    if (f.refunded || !f.uuid) continue;
    if (f.logId) {
      if (f.logId === row.id) return msg;
      continue;
    }
    if (f.uuid === row.uuid && msg.speaker?.actor === row.actorId
      && Number.isFinite(msg.timestamp) && Number.isFinite(row.at)
      && Math.abs(msg.timestamp - row.at) <= LEGACY_WINDOW_MS) return msg;
  }
  return null;
}

export const isRefundedCard = content => String(content ?? "").includes(REFUNDED_CLASS);

/*
  The card's content with the refund written in: the card's class gains
  lc-chat--refunded, the item link (to the granted copy, now deleted) becomes
  a link to the pool's source with the name struck through, any other link to
  an actor's item is unlinked, and "Refunded <time>" is appended. A card that
  already says refunded comes back unchanged.
*/
export function refundedCardContent(content, row, { esc = String, when = refundTime(row.refunded ?? Date.now()) } = {}) {
  let html = String(content ?? "");
  if (isRefundedCard(html)) return html;

  html = html.replace(/class="([^"]*\blc-chat\b[^"]*)"/, (_m, cls) => `class="${cls} ${REFUNDED_CLASS}"`);

  const struck = `<s>${esc(row.name)}</s>`;
  const source = row.uuid
    ? `<a class="content-link" draggable="true" data-link data-uuid="${esc(row.uuid)}" data-type="Item" data-tooltip="Item"><i class="fa-solid fa-suitcase" inert></i>${struck}</a>`
    : struck;
  html = html.replace(/(<div class="lc-chat__name">)[\s\S]*?(<\/div>)/, (_m, open, close) => open + source + close);
  html = html.replace(/<a\b[^>]*data-uuid="Actor\.[^"]*"[^>]*>([\s\S]*?)<\/a>/g, "$1");

  const at = Number.isFinite(row.refunded) ? ` datetime="${new Date(row.refunded).toISOString()}"` : "";
  const note = `<div class="lc-chat__refund">Refunded <time${at}>${esc(when)}</time></div>`;
  const end = html.lastIndexOf("</div>");
  return end < 0 ? html + note : html.slice(0, end) + note + html.slice(end);
}
