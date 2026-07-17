// The one compatibility shim. The Notor orchestration called
// `obsidian.requestUrl({ url, method, headers, body, throw: false })` and read
// `res.status` / `res.json` / `res.text`. This wraps the Node 18+ global `fetch`
// to return the same `{ status, json, text }` shape so the three ported network
// call sites keep their exact access pattern with zero logic changes.
//
// Contract (mirrors `throw: false`):
//   - NEVER throws on a non-2xx response — the caller inspects `res.status`.
//   - `json` is the parsed body, or `null` if the body was not valid JSON.
//   - `text` is always the raw body string.
//   - Throws ONLY on a genuine transport error (fetch rejects / aborts), so the
//     ported `try/catch → "request-threw" / "token-exchange-failed"` branches
//     fire exactly as written.

export async function httpRequest({ url, method = "GET", headers, body } = {}) {
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null; // non-JSON body (e.g. an HTML error page) — leave json null.
  }
  return { status: res.status, json, text };
}
