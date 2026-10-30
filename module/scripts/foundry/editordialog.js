/*
  The game editors' dialog: Foundry's DialogV2 with the guard rails
  (views/editorguard.js) between the GM and a lost form.

  DialogV2 closes at once on Cancel, the window's X and Escape: Cancel
  submits (its callback, then the `submit` that resolves DialogV2.wait,
  then close({ submitted: true })), and X and Escape call close(). Before
  this, a typed price, a stock, a hand-built prize list or deck went with
  it. Now a dialog given a guard (`dialog.lcGuard`, set once its form is
  on screen) asks first, but only once something differs from how it
  opened:
    lcGuard.dirty()       whether the form differs from how it opened
    lcGuard.discard()     asks "Discard your changes to <name>?" and
                          resolves true to close (Keep editing, the
                          default, resolves false and the form stays as it
                          was, focus where it was)
    lcGuard.beforeSave()  optional: asked on the default button before the
                          form is read (the price of 0: "Free to play?");
                          false keeps the dialog open
  Cancel is checked before DialogV2 resolves anything, so Keep editing
  leaves the editor's promise waiting for a real answer. A press while a
  question is up does nothing (a second Escape, a double click). A dialog
  with no guard is DialogV2 as it is.

  `Base` is DialogV2 (the tests pass a stand-in that behaves as it does).
*/
export function guardDialog(Base) {
  return class GuardedDialog extends Base {
    lcGuard = null;
    #asking = false;

    async #confirm(ask) {
      this.#asking = true;
      try { return !!(await ask()); } finally { this.#asking = false; }
    }

    async _onSubmit(target, event) {
      const guard = this.lcGuard;
      if (!guard) return super._onSubmit(target, event);
      event?.preventDefault?.();
      if (this.#asking) return this;
      const action = target?.dataset?.action;
      if (action === "cancel" && guard.dirty() && !await this.#confirm(guard.discard)) return this;
      if (action === "ok" && guard.beforeSave && !await this.#confirm(guard.beforeSave)) return this;
      return super._onSubmit(target, event);
    }

    async close(options = {}) {
      const guard = this.lcGuard;
      if (guard && !options?.submitted) {
        if (this.#asking) return this;
        if (guard.dirty() && !await this.#confirm(guard.discard)) return this;
      }
      return super.close(options);
    }
  };
}
