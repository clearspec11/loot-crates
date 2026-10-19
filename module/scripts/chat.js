import { RARITY_LABEL } from "./config.js";
import { formatPrice } from "./currency.js";

const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

// The chat card everyone keeps after the spin: who opened what and got what.
export async function postPullCard(reveal) {
  const r = reveal.result;
  const content = `
    <div class="loot-crates lc-chat lc-rarity-${esc(r.rarity)}">
      <div class="lc-chat__head">${esc(reveal.actorName)} opened <strong>${esc(reveal.box.name)}</strong> <span class="lc-chat__price">${esc(formatPrice(reveal.box.price))}</span></div>
      <div class="lc-chat__item">
        <img src="${esc(r.img)}" alt="">
        <div>
          <div class="lc-chat__name">${esc(r.name)}</div>
          <div class="lc-chat__rarity">${esc(RARITY_LABEL[r.rarity] ?? r.rarity)}${r.pity ? " · pity" : ""}</div>
        </div>
      </div>
    </div>`;
  const actor = game.actors.get(reveal.actorId);
  return ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor }),
    flags: { "loot-crates": { uuid: r.uuid, boxId: reveal.box.id } },
  });
}
