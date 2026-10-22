/*
  A minimal DOM for tests of pure DOM helpers (boxcard.js patchShop, morph)
  and of a manager drop: elements and text nodes, attributes, listeners,
  innerHTML parsing of the module's own markup, simple selectors (tag,
  .class, [attr], [attr="v"] and descendant combinators), a <select>'s
  value, and focus. Like a browser, a focused node that is removed or moved
  drops focus to the body, so a test can tell "kept the node" from "rebuilt
  it".
*/
const VOID = new Set(["img", "input", "br", "hr", "meta", "link"]);
const decode = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

class Node {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument.documentElement;
  }
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    const doc = this.ownerDocument;
    if (doc.activeElement && this.contains(doc.activeElement)) doc.activeElement = doc.body;
    parent.childNodes.splice(parent.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  replaceWith(node) {
    const parent = this.parentNode;
    const next = parent.childNodes[parent.childNodes.indexOf(this) + 1] ?? null;
    this.remove();
    parent.insertBefore(node, next);
  }
}

class Text extends Node {
  constructor(doc, value) { super(doc); this.nodeType = 3; this.nodeName = "#text"; this.nodeValue = value; }
  get textContent() { return this.nodeValue; }
}

class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.nodeName = tag.toUpperCase();
    this.attrs = new Map();
    this._value = null;
    // Inline styles as a plain bag (well.js sets transform and opacity).
    this.style = {};
    const el = this;
    this.dataset = new Proxy({}, {
      get: (_t, k) => el.getAttribute(`data-${String(k).replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`) ?? undefined,
      set: (_t, k, v) => { el.setAttribute(`data-${String(k).replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, String(v)); return true; },
    });
  }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  hasAttribute(name) { return this.attrs.has(name); }
  getAttributeNames() { return [...this.attrs.keys()]; }
  get className() { return this.getAttribute("class") ?? ""; }
  set className(v) { this.setAttribute("class", v); }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: c => list().includes(c),
      add: (...cs) => { this.className = [...new Set([...list(), ...cs])].join(" "); },
      remove: (...cs) => { this.className = list().filter(c => !cs.includes(c)).join(" "); },
    };
  }
  // Listeners run on the target only (no bubbling): enough for a test that
  // dispatches on the element a handler was added to.
  addEventListener(type, fn) { ((this._listeners ??= new Map()).get(type) ?? this._listeners.set(type, []).get(type)).push(fn); }
  dispatchEvent(event) {
    event.target ??= this;
    for (const fn of this._listeners?.get(event.type) ?? []) fn(event);
    return !event.defaultPrevented;
  }
  get tagName() { return this.nodeName; }
  get id() { return this.getAttribute("id") ?? ""; }
  set id(v) { this.setAttribute("id", v); }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get textContent() { return this.childNodes.map(n => n.textContent).join(""); }
  set textContent(v) { this.replaceChildren(...(v ? [new Text(this.ownerDocument, String(v))] : [])); }
  set innerHTML(html) { this.replaceChildren(...parse(this.ownerDocument, html)); }
  get childElementCount() { return this.children.length; }
  // "beforeend" only: what the manager's Show more uses.
  insertAdjacentHTML(where, html) {
    if (where !== "beforeend") throw new Error(`minidom: insertAdjacentHTML ${where} not supported`);
    this.append(...parse(this.ownerDocument, html));
  }
  // An input's value starts as its attribute and follows what is set on it,
  // as a browser's does; a select's is its chosen option.
  get value() {
    if (this.nodeName !== "SELECT") return this._value ?? this.getAttribute("value") ?? "";
    const options = this.querySelectorAll("option");
    const pick = this._value != null ? options.find(o => o.getAttribute("value") === this._value) : options.findLast(o => o.hasAttribute("selected")) ?? options[0];
    return pick?.getAttribute("value") ?? "";
  }
  set value(v) { this._value = String(v); }
  get defaultValue() { return this.getAttribute("value") ?? ""; }
  set defaultValue(v) { this.setAttribute("value", String(v)); }
  // A checkbox's state starts as its attribute and follows what is set.
  get checked() { return this._checked ?? this.hasAttribute("checked"); }
  set checked(v) { this._checked = !!v; }
  insertBefore(node, ref) {
    node.remove();
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, node);
    node.parentNode = this;
    return node;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  replaceChildren(...nodes) {
    for (const n of [...this.childNodes]) n.remove();
    this.append(...nodes);
  }
  focus() { this.ownerDocument.activeElement = this; }
  matches(selector) { return matches(this, selector); }
  closest(selector) {
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, selector)) return n;
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = n => { for (const c of n.children) { if (matches(c, selector)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

// One compound selector: tag, .class, [attr], [attr="v"] and [attr=v], in any mix.
function matchesCompound(el, compound) {
  // Classes are read with the attribute values taken out ([data-entry="Item.x"]).
  const bare = compound.replace(/\[[^\]]*\]/g, "");
  const tag = bare.match(/^[a-z][a-z0-9]*/i)?.[0];
  if (tag && el.nodeName !== tag.toUpperCase()) return false;
  for (const [, c] of bare.matchAll(/\.([\w-]+)/g)) if (!el.classList.contains(c)) return false;
  for (const [, name, quoted, plain] of compound.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|([^\]"]+)))?\]/g)) {
    const value = quoted ?? plain;
    if (!el.hasAttribute(name) || (value != null && el.getAttribute(name) !== value)) return false;
  }
  return true;
}

// A descendant chain: the last part matches el, the rest some ancestors in order.
function matches(el, selector) {
  const parts = selector.trim().split(/\s+/);
  if (!matchesCompound(el, parts.pop())) return false;
  let n = el.parentNode;
  while (parts.length && n && n.nodeType === 1) {
    if (matchesCompound(n, parts.at(-1))) parts.pop();
    n = n.parentNode;
  }
  return !parts.length;
}

function parse(doc, html) {
  const root = new Element(doc, "template");
  let cur = root;
  const re = /<!--[\s\S]*?-->|<\/([a-z][a-z0-9]*)\s*>|<([a-z][a-z0-9]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/gi;
  for (const [tok, close, open, attrs, text] of html.matchAll(re)) {
    if (tok.startsWith("<!--")) continue;
    if (text != null) cur.appendChild(new Text(doc, decode(text)));
    else if (close) {
      for (let n = cur; n !== root; n = n.parentNode) if (n.nodeName === close.toUpperCase()) { cur = n.parentNode; break; }
    } else {
      const el = new Element(doc, open);
      for (const [, name, dq, sq, bare] of attrs.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) el.setAttribute(name, decode(dq ?? sq ?? bare ?? ""));
      cur.appendChild(el);
      if (!VOID.has(open.toLowerCase())) cur = el;
    }
  }
  return [...root.childNodes];
}

export function createDocument() {
  const doc = { activeElement: null };
  doc.createElement = tag => new Element(doc, tag);
  doc.createTextNode = text => new Text(doc, text);
  doc.documentElement = new Element(doc, "html");
  doc.head = new Element(doc, "head");
  doc.body = new Element(doc, "body");
  doc.documentElement.append(doc.head, doc.body);
  doc.activeElement = doc.body;
  doc.querySelector = sel => doc.documentElement.querySelector(sel);
  doc.querySelectorAll = sel => doc.documentElement.querySelectorAll(sel);
  doc.getElementById = id => doc.documentElement.querySelectorAll("[id]").find(el => el.id === id) ?? null;
  return doc;
}
