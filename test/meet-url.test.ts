import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMeetingId } from "../src/meet-url.ts";

test("accepts the shapes people actually paste", () => {
  const cases: Array<[string, string]> = [
    ["https://meet.google.com/abc-defg-hij", "abc-defg-hij"],
    ["https://meet.google.com/abc-defg-hij?authuser=0", "abc-defg-hij"],
    ["https://meet.google.com/abc-defg-hij#anchor", "abc-defg-hij"],
    ["  https://meet.google.com/abc-defg-hij  ", "abc-defg-hij"],
    ["meet.google.com/abc-defg-hij", "abc-defg-hij"],
    ["http://meet.google.com/abc-defg-hij", "abc-defg-hij"],
    ["https://MEET.GOOGLE.COM/ABC-DEFG-HIJ", "abc-defg-hij"],
    ["abc-defg-hij", "abc-defg-hij"],
    ["ABC-DEFG-HIJ", "abc-defg-hij"],
  ];

  for (const [input, expected] of cases) {
    assert.equal(parseMeetingId(input), expected, `failed on: ${input}`);
  }
});

test("rejects anything that isn't a Meet link", () => {
  const cases = [
    "",
    "   ",
    "hello",
    "abc-def-hij", // wrong code shape
    "abcdefghij",
    "https://meet.google.com/",
    "https://meet.google.com/lookup/xyz",
    "https://zoom.us/j/123456",
    "not a url at all",
  ];

  for (const input of cases) {
    assert.equal(parseMeetingId(input), null, `should have rejected: ${input}`);
  }
});

test("rejects a Meet-shaped code hosted on another domain", () => {
  // Guards against being talked into dispatching a bot from a lookalike link.
  assert.equal(parseMeetingId("https://evil.com/abc-defg-hij"), null);
  assert.equal(parseMeetingId("https://meet.google.com.evil.com/abc-defg-hij"), null);
});
