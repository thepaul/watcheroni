// The logo and favicons, from assets/logo at the top of the repository,
// bundled into the Worker by the module rules in wrangler.jsonc (SVGs as
// text, PNG and ICO as bytes) so the pages need nothing from another host.

import favicon from "../../../assets/logo/favicon.ico";
import touchIcon from "../../../assets/logo/favicon-180.png";
import logoDark from "../../../assets/logo/meerkat-dark.svg";
import faviconSvg from "../../../assets/logo/meerkat-favicon.svg";
import logo from "../../../assets/logo/meerkat.svg";

const IMAGES: Record<string, { body: string | ArrayBuffer; type: string }> = {
  "/favicon.ico": { body: favicon, type: "image/x-icon" },
  "/favicon.svg": { body: faviconSvg, type: "image/svg+xml" },
  "/apple-touch-icon.png": { body: touchIcon, type: "image/png" },
  "/logo.svg": { body: logo, type: "image/svg+xml" },
  "/logo-dark.svg": { body: logoDark, type: "image/svg+xml" },
};

// GET or HEAD of one of the paths above, or null for anything else.
export function image(request: Request, pathname: string): Response | null {
  const found = IMAGES[pathname];
  if (!found || (request.method !== "GET" && request.method !== "HEAD")) return null;
  return new Response(request.method === "HEAD" ? null : found.body, {
    headers: {
      "content-type": found.type,
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=86400",
    },
  });
}
