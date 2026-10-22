import { createHash } from "node:crypto";
import { parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";

type Element = DefaultTreeAdapterTypes.Element;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

export const ID_ATTR = "data-le";

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/** Elements the browser may insert while typing; kept even though they have no source id. */
const TYPED_TAGS = new Set(["br"]);

export type EditOp =
  | { type: "text"; id: number; html: string }
  | {
      type: "attrs";
      id: number;
      set?: Record<string, string>;
      remove?: string[];
    };

export interface EditResult {
  source: string;
  /** Source elements inside the edited element, before and after the edit. */
  oldCount: number;
  newCount: number;
}

export class EditError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function hashSource(source: string): string {
  return createHash("sha1").update(source).digest("hex");
}

function isElement(node: ChildNode): node is Element {
  return "tagName" in node;
}

function childrenOf(node: ParentNode): ChildNode[] {
  // Template contents are inert in the browser, so they never get an id.
  return node.nodeName === "template" ? [] : node.childNodes;
}

/**
 * Elements that exist in the source text, in document order. The index in this
 * list is the element's id, both when serving and when applying an edit, so the
 * two stay in sync as long as the source has not changed in between.
 */
function sourceElements(source: string): Element[] {
  const out: Element[] = [];
  const walk = (node: ParentNode) => {
    for (const child of childrenOf(node)) {
      if (!isElement(child)) continue;
      if (child.sourceCodeLocation?.startTag) out.push(child);
      walk(child);
    }
  };
  walk(parse(source, { sourceCodeLocationInfo: true }));
  return out;
}

function countDescendants(el: Element): number {
  let n = 0;
  for (const child of childrenOf(el)) {
    if (!isElement(child)) continue;
    if (child.sourceCodeLocation?.startTag) n++;
    n += countDescendants(child);
  }
  return n;
}

/** Adds an id attribute to every source element, right after its tag name. */
export function annotate(source: string): string {
  const chunks: string[] = [];
  let cursor = 0;
  sourceElements(source).forEach((el, id) => {
    const start = el.sourceCodeLocation!.startTag!.startOffset;
    const name = /^<([^\s/>]+)/.exec(source.slice(start))?.[1] ?? el.tagName;
    const at = start + 1 + name.length;
    chunks.push(source.slice(cursor, at), ` ${ID_ATTR}="${id}"`);
    cursor = at;
  });
  chunks.push(source.slice(cursor));
  return chunks.join("");
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/ /g, "&nbsp;");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Rebuilds the inner HTML of an edited element from what the browser sent.
 * Text comes from the browser; every element is re-emitted with its original
 * start tag from the source, so attributes added at runtime never leak in.
 * Elements the page created with JS (no id) are dropped.
 */
function rebuildInner(
  source: string,
  elements: Element[],
  target: Element,
  html: string,
): { inner: string; count: number } {
  const used = new Set<number>();
  let count = 0;

  const emit = (nodes: ChildNode[]): string =>
    nodes
      .map((node) => {
        if (node.nodeName === "#text" && "value" in node)
          return escapeText(node.value);
        if (node.nodeName === "#comment" && "data" in node)
          return `<!--${node.data}-->`;
        if (!isElement(node)) return "";

        const rawId = node.attrs.find((a) => a.name === ID_ATTR)?.value;
        const id = rawId === undefined ? NaN : Number(rawId);
        const original = elements[id];
        if (!original || used.has(id)) {
          return TYPED_TAGS.has(node.tagName) ? `<${node.tagName}>` : "";
        }
        used.add(id);
        count++;

        const loc = original.sourceCodeLocation!;
        const startTag = source.slice(
          loc.startTag!.startOffset,
          loc.startTag!.endOffset,
        );
        if (VOID_TAGS.has(original.tagName)) return startTag;
        const endTag = loc.endTag
          ? source.slice(loc.endTag.startOffset, loc.endTag.endOffset)
          : `</${original.tagName}>`;
        return startTag + emit(childrenOf(node)) + endTag;
      })
      .join("");

  const fragment = parseFragment(target, html, {});
  return { inner: emit(fragment.childNodes), count };
}

function applyText(
  source: string,
  elements: Element[],
  el: Element,
  html: string,
): EditResult {
  const loc = el.sourceCodeLocation!;
  if (VOID_TAGS.has(el.tagName))
    throw new EditError(`<${el.tagName}> has no text content`);
  const from = loc.startTag!.endOffset;
  const to = loc.endTag ? loc.endTag.startOffset : loc.endOffset;
  const { inner, count } = rebuildInner(source, elements, el, html);
  return {
    source: source.slice(0, from) + inner + source.slice(to),
    oldCount: countDescendants(el),
    newCount: count,
  };
}

function applyAttrs(
  source: string,
  el: Element,
  set: Record<string, string> = {},
  remove: string[] = [],
): EditResult {
  const loc = el.sourceCodeLocation!;
  const attrLocs = loc.attrs ?? {};
  const splices: { from: number; to: number; text: string }[] = [];

  for (const [name, value] of Object.entries(set)) {
    const text = `${name}="${escapeAttr(value)}"`;
    const existing = attrLocs[name];
    if (existing) {
      splices.push({
        from: existing.startOffset,
        to: existing.endOffset,
        text,
      });
    } else {
      const tag = source.slice(
        loc.startTag!.startOffset,
        loc.startTag!.endOffset,
      );
      const close =
        loc.startTag!.startOffset + tag.length - (tag.endsWith("/>") ? 2 : 1);
      splices.push({ from: close, to: close, text: ` ${text}` });
    }
  }
  for (const name of remove) {
    const existing = attrLocs[name];
    if (!existing || name in set) continue;
    // Take the whitespace before the attribute with it.
    let from = existing.startOffset;
    while (from > 0 && /\s/.test(source[from - 1]!)) from--;
    splices.push({ from, to: existing.endOffset, text: "" });
  }

  let out = source;
  for (const s of splices.sort((a, b) => b.from - a.from)) {
    out = out.slice(0, s.from) + s.text + out.slice(s.to);
  }
  const n = countDescendants(el);
  return { source: out, oldCount: n, newCount: n };
}

export function applyEdit(source: string, op: EditOp): EditResult {
  const elements = sourceElements(source);
  const el = elements[op.id];
  if (!el) throw new EditError(`No source element with id ${op.id}`, 409);
  if (op.type === "text") return applyText(source, elements, el, op.html);
  return applyAttrs(source, el, op.set, op.remove);
}
