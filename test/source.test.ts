import assert from "node:assert/strict";
import { test } from "node:test";
import { annotate, applyEdit, ID_ATTR } from "../src/source.ts";

const page = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Test</title>
</head>
<body>
  <main class="wrap">
    <h1 class="title">Hello  world</h1>
    <p>Some <strong data-x="1">bold</strong> text &amp; more</p>
    <img src="a.png" srcset="a@2x.png 2x" alt="A">
    <ul><li>one<li>two</ul>
  </main>
</body>
</html>
`;

/** Finds an element's id the way the browser would read it from the served page. */
function idOf(source: string, pattern: RegExp): number {
  const match = pattern.exec(annotate(source));
  assert.ok(match, `no match for ${pattern}`);
  return Number(match[1]);
}

test("annotate adds an id to every source element and changes nothing else", () => {
  const out = annotate(page);
  assert.equal(out.replace(new RegExp(` ${ID_ATTR}="\\d+"`, "g"), ""), page);
  assert.match(out, /<h1 data-le="\d+" class="title">/);
});

test("a text edit only touches the inside of that element", () => {
  const id = idOf(page, /<h1 data-le="(\d+)"/);
  const { source, oldCount, newCount } = applyEdit(page, {
    type: "text",
    id,
    html: "Ciao &lt;mondo&gt; &amp; co",
  });
  assert.equal(
    source,
    page.replace("Hello  world", "Ciao &lt;mondo&gt; &amp; co"),
  );
  assert.deepEqual([oldCount, newCount], [0, 0]);
});

test("nested elements keep their original start tag, runtime attributes are ignored", () => {
  const id = idOf(page, /<p data-le="(\d+)"/);
  const strongId = idOf(page, /<strong data-le="(\d+)"/);
  const html = `Lots of <strong data-le="${strongId}" class="__le-hover" data-x="1">bold</strong> text &amp; more`;
  const { source } = applyEdit(page, { type: "text", id, html });
  assert.equal(source, page.replace("Some <strong", "Lots of <strong"));
});

test("removing a nested element reports the count change, JS-made elements are dropped", () => {
  const id = idOf(page, /<p data-le="(\d+)"/);
  const { source, oldCount, newCount } = applyEdit(page, {
    type: "text",
    id,
    html: 'Plain<br>line <span class="badge">injected</span>',
  });
  assert.match(source, /<p>Plain<br>line <\/p>/);
  assert.deepEqual([oldCount, newCount], [1, 0]);
});

test("non-breaking spaces stay visible in the source", () => {
  const id = idOf(page, /<h1 data-le="(\d+)"/);
  const { source } = applyEdit(page, { type: "text", id, html: "A B" });
  assert.match(source, /<h1 class="title">A&nbsp;B<\/h1>/);
});

test("elements without an end tag are edited up to their implied end", () => {
  const id = idOf(page, /<li data-le="(\d+)">one/);
  const { source } = applyEdit(page, { type: "text", id, html: "uno" });
  assert.match(source, /<ul><li>uno<li>two<\/ul>/);
});

test("an image swap rewrites src and drops srcset", () => {
  const id = idOf(page, /<img data-le="(\d+)"/);
  const { source } = applyEdit(page, {
    type: "attrs",
    id,
    set: { src: 'uploads/b "new".png' },
    remove: ["srcset"],
  });
  assert.match(source, /<img src="uploads\/b &quot;new&quot;.png" alt="A">/);
});

test("ids still line up after an edit that changes the element count", () => {
  const pId = idOf(page, /<p data-le="(\d+)"/);
  const imgBefore = idOf(page, /<img data-le="(\d+)"/);
  const { source, oldCount, newCount } = applyEdit(page, {
    type: "text",
    id: pId,
    html: "flat",
  });
  // The client shifts later ids by newCount - oldCount; the server must agree.
  assert.equal(
    idOf(source, /<img data-le="(\d+)"/),
    imgBefore + newCount - oldCount,
  );
});

test("an unknown id is a conflict", () => {
  assert.throws(() => applyEdit(page, { type: "text", id: 999, html: "x" }), {
    status: 409,
  });
});
