// Normalises Rwandan-style numbers so "0788 123 456", "+250788123456" and
// "250788123456" all map to the same key (used for the one-trial-per-business rule).
export function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 7) return "";
  return digits.slice(-9);
}
export const normalizeEmail = (e) => String(e || "").trim().toLowerCase();
