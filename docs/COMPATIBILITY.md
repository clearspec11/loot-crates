# Compatibility

What `module/module.json` promises, and the evidence behind each part of it. Audited on 2026-10-25 for 1.0.1.

## The manifest

| | Minimum | Verified |
| --- | --- | --- |
| Foundry VTT | 13.341 | 14 (build 14.369) |
| D&D 5e system | 5.0.0 | 6.0.6 |

`test/release.test.js` checks that this table and `module/module.json` agree.

**Tested** means a live check ran on it. Every live check, smoke run and probe so far ran on one world: Foundry v14 build 14.369 with dnd5e 6.0.6 (cc-dev).

**Read** means the API was looked up in Foundry v13's public API docs and release notes, or in dnd5e 5.x's source on GitHub, and the module's use of it compared by hand. Nothing has run on Foundry v13 or on dnd5e 5. The first v13 or dnd5e 5 world to load it is the first live test, and a bug report from one is welcome: [issues](https://github.com/clearspec11/loot-crates/issues).

### Why 13.341 and not 13

Before 1.0.1 the minimum was `13`, which lets Foundry install the module on v13's prototype and testing builds. Three things the module needs only settled during them, so the minimum is now 13.341, v13's first stable build:

- **13.336** added the directory context-menu hooks, and **13.338** reworked their signatures into the `get<Document>ContextOptions` hooks the v13 docs describe. Before 13.336, the Roll Tables sidebar's "Make a crate" has no hook to join. ([13.336](https://foundryvtt.com/releases/13.336), [13.338](https://foundryvtt.com/releases/13.338))
- **13.340** changed DialogV2's button and render callbacks to receive the DialogV2 instance rather than its element. The editors' forms read `dialog.element`. ([13.340](https://foundryvtt.com/releases/13.340))
- **13.338 and 13.339** reorganised `game.time` and the TimeComponents the day key reads. ([13.338](https://foundryvtt.com/releases/13.338), [13.339](https://foundryvtt.com/releases/13.339))

dnd5e 5.0.0 itself needs Foundry 13.339, so no dnd5e world could run on the builds this rules out.

### Which pairs exist

dnd5e 6.0.0 and later need Foundry 14.367 or later. dnd5e 5.0.0 needs Foundry 13.339, and dnd5e 5.3.x is verified on Foundry 14. So the pairs are v13 with dnd5e 5, v14 with dnd5e 5.3, and v14 with dnd5e 6. Only the last one is tested. ([5.0.0 system.json](https://github.com/foundryvtt/dnd5e/blob/release-5.0.0/system.json), [5.3.3](https://github.com/foundryvtt/dnd5e/blob/release-5.3.3/system.json), [6.0.0](https://github.com/foundryvtt/dnd5e/blob/release-6.0.0/system.json))

## Differences found, and what the module does

| Difference | v14 / dnd5e 6 (tested) | v13 / dnd5e 5 (read) | What the module does | Test |
| --- | --- | --- | --- | --- |
| A sidebar menu entry's keys | `label`, `visible`, `onClick(event, li)`, and these win when present | `name`, `condition`, `callback(li)`, where `li` may be a jQuery object ([ContextMenuEntry](https://foundryvtt.com/api/v13/interfaces/foundry.ContextMenuEntry.html)) | `route.js directoryMenuEntry` sets both sets of keys; `entryIdOf` takes an element or a jQuery object | `test/compat.test.js` |
| An item's rarity | `system.rarities`, a Set ([6.0.6 physical-item.mjs](https://github.com/foundryvtt/dnd5e/blob/release-6.0.6/module/data/item/templates/physical-item.mjs#L42)) | `system.rarity`, a string ([5.0.0 physical-item.mjs](https://github.com/foundryvtt/dnd5e/blob/release-5.0.0/module/data/item/templates/physical-item.mjs#L46)) | Every index read asks for both fields (`store.js RARITY_FIELDS`), and `odds.js rawRarityOf` then `normalizeRarity` read either | `test/rarity.test.js`, `test/compat.test.js` |
| dnd5e's `calendarConfig` setting | `enabled`, `dailyRecovery` and the `manualRecovery` getter ([6.0.6 calendar-setting.mjs](https://github.com/foundryvtt/dnd5e/blob/release-6.0.6/module/data/settings/calendar-setting.mjs#L22-L40)) | Absent in 5.0 and 5.1. In 5.2 and 5.3 only `enabled`, which shows the calendar, while daily uses always come back at a long rest's new day ([5.3.3 calendar-setting.mjs](https://github.com/foundryvtt/dnd5e/blob/release-5.3.3/module/data/settings/calendar-setting.mjs#L22), [5.3.3 actor.mjs](https://github.com/foundryvtt/dnd5e/blob/release-5.3.3/module/documents/actor/actor.mjs#L2557)) | **Fixed in 1.0.1.** `clock.js dayModeOf` reads the setting's shape, not a version. With no setting, or one without `dailyRecovery`, a day ends at each character's long rest, as dnd5e 5 does for its own daily uses. Before this, a dnd5e 5.2+ world with the calendar shown keyed the well's cap on a clock a long rest doesn't move | `test/compat.test.js`, `test/clock.test.js` |
| Coin fields | Numbers, at least 0 ([6.0.6 currency.mjs](https://github.com/foundryvtt/dnd5e/blob/release-6.0.6/module/data/shared/currency.mjs#L14)) | Whole numbers only, `integer: true` ([5.0.0 currency.mjs](https://github.com/foundryvtt/dnd5e/blob/release-5.0.0/module/data/shared/currency.mjs#L15)) | `currency.js settle` writes only whole coins, so dnd5e 5 accepts every purse the module writes | `test/currency.test.js`, `test/compat.test.js` |
| The starter crates' packs | `dnd5e.items` and `dnd5e.equipment24` | The same two, both listed in [5.0.0 system.json](https://github.com/foundryvtt/dnd5e/blob/release-5.0.0/system.json) | `starter.js starterPackPlan` reads the packs the system lists. `equipment24` is optional, so a dnd5e without it builds from `dnd5e.items` alone | `test/starter.test.js`, `test/compat.test.js` |
| dnd5e's `rulesVersion` setting | Present | Present since 4.0 ([5.0.0 settings.mjs](https://github.com/foundryvtt/dnd5e/blob/release-5.0.0/module/settings.mjs#L65)) | `starterbuild.js starterPlan` reads it in a try. If it can't be read, it treats the rules as modern | `test/compat.test.js` |
| `CONFIG.Item.compendiumIndexFields` | An array of field paths | Not in v13's public API docs | `store.js registerIndexFields` adds the rarity fields only when the array is there. Otherwise each read asks `getIndex` for its own fields | `test/rarity.test.js`, `test/compat.test.js` |

## Hooks

Every hook the module registers (`main.js`, and `shop.js registerShopHooks`).

| Hook | v14 / dnd5e 6 (tested) | v13 / dnd5e 5 (read) | What the module does |
| --- | --- | --- | --- |
| `init` | Yes | [hookEvents.init](https://foundryvtt.com/api/v13/functions/hookEvents.init.html) | Settings, the menu, index fields |
| `i18nInit` | Yes; fires after `init`, once Foundry's translations are loaded | [hookEvents.i18nInit](https://foundryvtt.com/api/v13/functions/hookEvents.i18nInit.html) | Hands the module's words to `game.i18n` (`main.js`, `i18n.js setLocalizer`), so a `lang/<code>.json` translation wins over the English the module loads itself |
| `ready` | Yes | [hookEvents.ready](https://foundryvtt.com/api/v13/functions/hookEvents.ready.html) | Socket, `api`, sweep and round recovery on the GM, the welcome |
| `renderItemDirectory` | Yes; the ItemDirectory is an ApplicationV2 and passes an HTMLElement | The ItemDirectory is an ApplicationV2 too ([ItemDirectory](https://foundryvtt.com/api/v13/classes/foundry.applications.sidebar.tabs.ItemDirectory.html), and from [13.340](https://foundryvtt.com/releases/13.340) every core application is) | Adds Crates and Manage crates to `.directory-header .header-actions`, or `.directory-header` if that isn't there. It takes an element, or a jQuery object's first element |
| `getRollTableContextOptions` | Yes | [hookEvents.getDocumentContextOptions](https://foundryvtt.com/api/v13/functions/hookEvents.getDocumentContextOptions.html): "Substitute Document in the hook name", since [13.338](https://foundryvtt.com/releases/13.338) | Pushes "Make a crate" in both entry shapes (above) |
| `renderChatMessageHTML` | Yes | [hookEvents.renderChatMessageHTML](https://foundryvtt.com/api/v13/functions/hookEvents.renderChatMessageHTML.html), (message, HTMLElement, context) | Seals a pull's card while it spins, and adds Watch again |
| `createItem` | Yes | [hookEvents.createDocument](https://foundryvtt.com/api/v13/functions/hookEvents.createDocument.html) | Hides a pull's item on the sheet until its spin lands |
| `updateActor` | Yes | [hookEvents.updateDocument](https://foundryvtt.com/api/v13/functions/hookEvents.updateDocument.html) | Redraws the shop on a purse change |
| `createActor` | Yes | [hookEvents.createDocument](https://foundryvtt.com/api/v13/functions/hookEvents.createDocument.html) | Redraws the shop |
| `deleteActor` | Yes | [hookEvents.deleteDocument](https://foundryvtt.com/api/v13/functions/hookEvents.deleteDocument.html) | Redraws the shop |
| `updateUser` | Yes | [hookEvents.updateDocument](https://foundryvtt.com/api/v13/functions/hookEvents.updateDocument.html) | Redraws the shop on a character change; on a role change, moves the stale-round timer to the active GM (table.js watchStale) |
| `userConnected` | Yes | [hookEvents.userConnected](https://foundryvtt.com/api/v13/functions/hookEvents.userConnected.html) | Redraws the shop; moves the stale-round timer to whichever GM is now active (table.js watchStale) |
| `updateWorldTime` | Yes | [hookEvents.updateWorldTime](https://foundryvtt.com/api/v13/functions/hookEvents.updateWorldTime.html) | Redraws the shop, for a per-day count |
| `dnd5e.restCompleted` | Yes, (actor, result, config) with `result.newDay` ([6.0.6 actor.mjs](https://github.com/foundryvtt/dnd5e/blob/release-6.0.6/module/documents/actor/actor.mjs#L2418)) | The same call and `newDay` ([5.0.0 actor.mjs](https://github.com/foundryvtt/dnd5e/blob/release-5.0.0/module/documents/actor/actor.mjs#L2229), [newDay](https://github.com/foundryvtt/dnd5e/blob/release-5.0.0/module/documents/actor/actor.mjs#L2183)) | Ends the day for that character on the GM (`socket.js restCompleted`). With the calendar on (dnd5e 6 only: 5.x always ends the day at a rest), `config.advanceTime` and `config.duration` say whether dnd5e already moved the clock on a GM's client ([6.0.6 actor.mjs](https://github.com/foundryvtt/dnd5e/blob/release-6.0.6/module/documents/actor/actor.mjs#L2406)), so the rest's start is read back over it; a client that can't tell takes the rest as begun now |
| `dnd5e.preUseActivity` | Yes, (activity, usageConfig, dialogConfig, messageConfig), called before the configuration dialog, consumption and the chat card, on a clone of the item that keeps its id and actor; `false` cancels the use ([6.0.6 mixin.mjs](https://github.com/foundryvtt/dnd5e/blob/release-6.0.6/module/documents/activity/mixin.mjs#L257)) | The same call ([5.0.0 mixin.mjs](https://github.com/foundryvtt/dnd5e/blob/release-5.0.0/module/documents/activity/mixin.mjs#L256)) | A ticket's Use (`tickets.js ticketUseHook`): returns `false` for an item with the ticket flag, so dnd5e consumes and posts nothing, and asks the GM to play it (`socket.js requestRedeem`). A ticket is a consumable with one `utility` activity, which both versions show a Use for |

## Foundry APIs

| API | v14 (tested) | v13 (read) | What the module does |
| --- | --- | --- | --- |
| `foundry.applications.api` `ApplicationV2`: `_renderHTML`, `_replaceHTML`, `_onRender`, `_onClose`, `_getHeaderControls`, `DEFAULT_OPTIONS.actions` | Yes | [ApplicationV2](https://foundryvtt.com/api/v13/classes/foundry.applications.api.ApplicationV2.html), [header controls](https://foundryvtt.com/api/v13/interfaces/foundry.applications.types.ApplicationHeaderControlsEntry.html) | Every window. The action names `close`, `tab` and `toggleControls` are ApplicationV2's own in both versions, and none of the module's actions uses them (`test/actions.test.js`) |
| `foundry.applications.api.DialogV2.confirm`, `DialogV2.wait`, `DialogV2.prompt` with `rejectClose`, `render(event, dialog)`, button `callback(event, button, dialog)` | Yes | [DialogV2](https://foundryvtt.com/api/v13/classes/foundry.applications.api.DialogV2.html), [button callback](https://foundryvtt.com/api/v13/types/foundry.DialogV2ButtonCallback.html); `rejectClose` defaults to false from [13.333](https://foundryvtt.com/releases/13.333) | Confirms and editor forms. `rejectClose: false` is passed explicitly |
| `foundry.applications.instances.values`, `foundry.applications.instances.get` | Yes | [instances](https://foundryvtt.com/api/v13/variables/foundry.applications.instances.html), a Map | Finds an open reveal or replay window, with optional chaining |
| `foundry.applications.ux.TextEditor.implementation` `getDragEventData` | Yes | [TextEditor](https://foundryvtt.com/api/v13/classes/foundry.applications.ux.TextEditor.html) | Reads a drop on a pool. The global `TextEditor` is a fallback the supported versions never reach |
| `foundry.utils.escapeHTML`, `foundry.utils.deepClone`, `foundry.utils.randomID` | Yes | [escapeHTML](https://foundryvtt.com/api/v13/functions/foundry.utils.escapeHTML.html), [deepClone](https://foundryvtt.com/api/v13/functions/foundry.utils.deepClone.html), [randomID](https://foundryvtt.com/api/v13/functions/foundry.utils.randomID.html) | Escaping, settings copies, ids |
| `fromUuid`, `fromUuidSync` | Yes | [fromUuid](https://foundryvtt.com/api/v13/functions/foundry.utils.fromUuid.html), [fromUuidSync](https://foundryvtt.com/api/v13/functions/foundry.utils.fromUuidSync.html) | Resolves pool entries. A missing one is reported |
| `Roll`: `evaluate({ allowInteractive: false })`, `toJSON`, `Roll.fromData` | Yes | [Roll](https://foundryvtt.com/api/v13/classes/foundry.dice.Roll.html) | The dice game and the wheel roll on the GM, and each client rebuilds the roll from the GM's data |
| `ChatMessage.create`, `ChatMessage.getSpeaker`, `ChatMessage#update` | Yes | [ChatMessage](https://foundryvtt.com/api/v13/classes/foundry.documents.ChatMessage.html) | The pull and refund cards, which never carry a Roll. A refund marks the pull's card |
| `game.i18n.has`, `game.i18n.format`, `game.i18n.localize` | Yes; `format` is `localize` with data, and `{name}` is filled from it | [Localization](https://foundryvtt.com/api/v13/classes/foundry.helpers.Localization.html): `has(stringId, fallback)`, `format(stringId, data)`, `localize(stringId)` | Every word the module shows (`i18n.js t()`, installed by `main.js` at `i18nInit`): a key Foundry has comes through `format` (or `localize` with no data), one it hasn't from the module's own `lang/en.json`. The manager's item type names are dnd5e's, through `localize` |
| `module.json` `languages` | Yes | [Module development: languages](https://foundryvtt.com/article/module-development/) | Declares `lang/en.json`, so Foundry merges it, and a translation adds its own entry |
| `game.settings.register`, `registerMenu`, `get`, `set` | Yes | [ClientSettings](https://foundryvtt.com/api/v13/classes/foundry.helpers.ClientSettings.html) | World state, and the manager in Game Settings |
| `game.packs` and a pack's `getIndex({ fields })`, `index`, `documentName` | Yes | [CompendiumCollection](https://foundryvtt.com/api/v13/classes/foundry.documents.collections.CompendiumCollection.html) | Pool imports and the starter crates |
| `game.users.activeGM` | Yes | [Users](https://foundryvtt.com/api/v13/classes/foundry.documents.collections.Users.html) | Which client writes |
| `game.time.components` (`year`, `day`), `game.time.worldTime` | Yes | [GameTime](https://foundryvtt.com/api/v13/classes/foundry.helpers.GameTime.html), [TimeComponents](https://foundryvtt.com/api/v13/interfaces/foundry.data.types.TimeComponents.html) | The day key when the clock decides the day (`clock.js dayKeyOf`) |
| `game.time.calendar.timeToComponents` | Yes | [CalendarData](https://foundryvtt.com/api/v13/classes/foundry.data.CalendarData.html) | The day a long rest began on, when dnd5e moved the clock before the hook (`store.js dayAt`; dnd5e reads past moments the same way). Without it, the day from the seconds alone |
| `game.audio.interface` | Yes | [AudioHelper](https://foundryvtt.com/api/v13/classes/foundry.audio.AudioHelper.html) | The synthesised sounds' channel |
| `Actor#update`, `createEmbeddedDocuments`, `testUserPermission`, `Item#delete` | Yes | [Actor](https://foundryvtt.com/api/v13/classes/foundry.documents.Actor.html), [Item](https://foundryvtt.com/api/v13/classes/foundry.documents.Item.html) | Purses, grants, ownership checks, refunds |
| `CONFIG.Item.typeLabels` | Yes | dnd5e 5.0.0 reads it on v13 ([abstract.mjs](https://github.com/foundryvtt/dnd5e/blob/release-5.0.0/module/data/abstract.mjs#L195)) | The type list in Add from compendium, read with `?? {}` |
| Theme classes `.theme-light`, `.theme-dark`, `.themed` | Yes | [13.332](https://foundryvtt.com/releases/13.332) and [13.333](https://foundryvtt.com/releases/13.333) | `module.css` sets its tokens with `@scope (.theme-x) to (.themed)` |

## dnd5e data

| Field or pack | dnd5e 6.0.6 (tested) | dnd5e 5.0.0 (read) | What the module does |
| --- | --- | --- | --- |
| `system.rarities` / `system.rarity` | `rarities` | `rarity` | See the differences above |
| `system.currency` | `pp`, `gp`, `ep`, `sp`, `cp` | The same keys, whole numbers ([currency.mjs](https://github.com/foundryvtt/dnd5e/blob/release-5.0.0/module/data/shared/currency.mjs#L15)) | Reads and writes through `currency.js` |
| `system.type.value` | Present | `ItemTypeField` on consumable, equipment, weapon, tool and loot ([consumable.mjs](https://github.com/foundryvtt/dnd5e/blob/release-5.0.0/module/data/item/consumable.mjs#L61), [equipment.mjs](https://github.com/foundryvtt/dnd5e/blob/release-5.0.0/module/data/item/equipment.mjs#L63)) | The starter pools' subtypes: `potion`, `scroll`, `wondrous`, `trinket`, `ring`, `clothing`, `light`, `medium`, `heavy`, `shield`, all in 5.0.0's [config.mjs](https://github.com/foundryvtt/dnd5e/blob/release-5.0.0/module/config.mjs#L1594) |
| `system.quantity`, `system.activities`, `system.price` | A consumable's stack, its activities keyed by id (a `utility` one has `roll`), its price `{ value, denomination }` | The same ([consumable.mjs](https://github.com/foundryvtt/dnd5e/blob/release-5.0.0/module/data/item/consumable.mjs), [utility-data.mjs](https://github.com/foundryvtt/dnd5e/blob/release-5.0.0/module/data/activity/utility-data.mjs)) | A ticket (`games/ticket.js ticketData`): a `trinket` consumable with one `utility` activity; a use spends one from `system.quantity` (`tickets.js spendTicket`) |
| Item types `weapon`, `equipment`, `consumable`, `tool`, `loot`, `container` | Present | Present ([data/item](https://github.com/foundryvtt/dnd5e/tree/release-5.0.0/module/data/item)) | What a pool takes (`store.js LOOT_TYPES`) |
| Rarity keys `common` to `artifact` | Present | The same six ([config.mjs](https://github.com/foundryvtt/dnd5e/blob/release-5.0.0/module/config.mjs#L1484)) | `normalizeRarity` |
| `dnd5e.items` | Listed | Listed | Starter crates and the editor's example UUID |
| `dnd5e.equipment24` | Listed | Listed | Starter crates, optional |

## Not checked

- **Dice So Nice.** It's optional, and the dice game uses it only when `game.dice3d.showForRoll` is there. No other version of it has been tried.
- **The Items sidebar's header markup on v13.** Foundry's templates aren't public. The buttons go in `.directory-header .header-actions` when it exists, and in `.directory-header` otherwise. If neither exists, the buttons aren't added, and Game Settings, Loot Crates still opens the manager.
- **Other sheet modules.** Tidy 5e Sheets is active on cc-dev. No other sheet module has been tried.

## How to check again

Run this when the manifest's versions change, or when the module starts using a new hook or API:

1. For each hook, `foundry.*` path and `system.*` field in `module/scripts/`, look it up in `https://foundryvtt.com/api/v<N>/` and in the oldest dnd5e release the manifest allows (`https://github.com/foundryvtt/dnd5e/tree/release-<x.y.z>/module`).
2. Add a row here. `test/release.test.js` fails until every hook, `foundry.*` path, `system.*` field and starter pack the scripts use is named in this file.
3. Feature-detect any difference (check for a field or a method, never the version number), and add a test to `test/compat.test.js`.
