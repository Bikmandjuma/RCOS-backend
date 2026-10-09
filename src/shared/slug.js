// Reserved so a restaurant can never shadow an app/platform route.
export const RESERVED_SLUGS = new Set([
  "app", "api", "admin", "login", "logout", "register", "signup", "pricing", "features", "invite",
  "r", "q", "t", "discover", "help", "support", "about", "contact", "static", "assets", "uploads",
  "billing", "dashboard", "settings", "staff", "roles", "terms", "privacy", "www", "mail", "status",
  "restaurantos", "platform", "demo", "test",
]);

export function slugify(input) {
  return String(input || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;
export const isValidSlug = (s) => SLUG_RE.test(s) && !s.includes("--") && !RESERVED_SLUGS.has(s);
