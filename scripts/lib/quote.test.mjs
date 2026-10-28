/* node --test — unit tests for the ported quote verifier. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyQuote, norm, units } from "./quote.mjs";

const SRC =
  "The pressure-cooking lid can be opened during use, causing hot contents to escape, " +
  "posing a risk of burn injuries. The glass basket shattered while preheating.";

test("exact substring match", () => {
  const r = verifyQuote("hot contents to escape", SRC);
  assert.equal(r.status, "exact");
  assert.equal(r.score, 1);
});

test("punctuation-insensitive exact match", () => {
  // trailing period / comma should not matter
  assert.equal(verifyQuote("glass basket shattered while preheating.", SRC).status, "exact");
});

test("case and smart-quote insensitive", () => {
  assert.equal(verifyQuote("The Glass Basket Shattered", SRC).status, "exact");
  assert.equal(verifyQuote("“hot contents to escape”", SRC).status, "exact");
});

test("near match on reordered / dropped words", () => {
  const r = verifyQuote("lid opened during use causing contents to escape", SRC);
  assert.equal(r.status, "near");
  assert.ok(r.score >= 0.8);
});

test("unsupported when fabricated", () => {
  const r = verifyQuote("the motor caught fire and exploded immediately", SRC);
  assert.equal(r.status, "unsupported");
  assert.ok(r.score < 0.8);
});

test("empty quote is unsupported", () => {
  assert.equal(verifyQuote("", SRC).status, "unsupported");
  assert.equal(verifyQuote("   ", SRC).status, "unsupported");
});

test("single-word quote not in source is unsupported", () => {
  assert.equal(verifyQuote("electrocution", SRC).status, "unsupported");
});

test("norm collapses whitespace and lowercases", () => {
  assert.equal(norm("  Hot   CONTENTS\n escape "), "hot contents escape");
});

test("units splits on punctuation for latin text", () => {
  assert.deepEqual(units("weeks. then, fire!"), ["weeks", "then", "fire"]);
});

test("CJK uses character units", () => {
  // Japanese: "発火した" (caught fire) — exact substring still matches
  const jp = "製品が発火した。煙が出た。";
  assert.equal(verifyQuote("発火した", jp).status, "exact");
});

test("Hindi (Devanagari) word units match", () => {
  const hi = "उपकरण से धुआं निकला और चिंगारी दिखी";
  assert.equal(verifyQuote("धुआं निकला", hi).status, "exact");
});
