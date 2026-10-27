import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { normalizeUid } from "./index.ts";

Deno.test("UID Normalisation: strips spaces and colons", () => {
  const raw1 = "04:EA:8B:12:F1:55:80";
  const raw2 = " 04 EA 8B 12 F1 55 80 ";
  
  assertEquals(normalizeUid(raw1), "04:EA:8B:12:F1:55:80");
  assertEquals(normalizeUid(raw2), "04:EA:8B:12:F1:55:80");
});

Deno.test("UID Normalisation: forces uppercase", () => {
  const raw = "04ea8b12f15580";
  assertEquals(normalizeUid(raw), "04:EA:8B:12:F1:55:80");
});

Deno.test("UID Normalisation: rejects malformed UIDs", () => {
  assertEquals(normalizeUid("04EA"), null);
  assertEquals(normalizeUid("04EA8B12F1558X"), null);
});
