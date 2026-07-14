// Safe UUID generator that works even in non-secure contexts (e.g. LAN IPs over plain HTTP).
// crypto.randomUUID() is only available in secure contexts (https / localhost).
// Falls back to a manual RFC4122 v4-ish UUID using crypto.getRandomValues, which IS available everywhere.

export function uuid(): string {
  // Prefer the native API where available
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // some browsers throw in non-secure contexts even though the function exists
    }
  }

  // Fallback: use getRandomValues (works in all modern browsers, secure or not)
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
