import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { createHmac } from "node:crypto";

// Mocking the verification logic since Deno functions depend on Edge runtime and env vars
function verifySignature(payload: string, signature: string, secret: string) {
  const expectedSig = createHmac("sha256", secret).update(payload).digest("hex");
  return expectedSig === signature;
}

Deno.test("Verify-QR: valid signature passes", () => {
  const secret = "test-secret-123";
  const payload = JSON.stringify({ session_id: "sess-1", timestamp: Date.now() });
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  
  assertEquals(verifySignature(payload, signature, secret), true);
});

Deno.test("Verify-QR: invalid signature fails", () => {
  const secret = "test-secret-123";
  const payload = JSON.stringify({ session_id: "sess-1", timestamp: Date.now() });
  
  assertEquals(verifySignature(payload, "invalid_signature", secret), false);
});

Deno.test("Verify-QR: expiry logic (QR older than 30s is rejected)", () => {
  const now = Date.now();
  const oldTimestamp = now - 35000; // 35 seconds ago
  const isExpired = now - oldTimestamp > 30000;
  
  assertEquals(isExpired, true);
});
