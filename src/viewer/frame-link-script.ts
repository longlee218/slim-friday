/**
 * The one static script injected into every html artifact's `srcdoc` (no artifact text is ever interpolated into it).
 * Why: a `srcdoc` document's base URL is the viewer page URL, so a click on `<a href="#section">` navigates the frame to
 * `<viewer url>#section`, which the viewer refuses to frame (`X-Frame-Options: DENY`) and Chrome shows a sad face.
 * - `#id` / `#name` links: scrolled to in place (smooth), never navigated; a bare `#` scrolls to the top.
 * - http(s) links: opened in a new tab (`noopener noreferrer`), so a site that cannot be framed still opens.
 * - anything else (`mailto:`, ...) is left alone.
 * Runs under the inner policy's `script-src 'unsafe-inline'` (the html artifact's own scripts run there anyway).
 */
export const FRAME_LINK_SCRIPT = `<script>
document.addEventListener("click", function (e) {
  var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
  if (!a || e.defaultPrevented) return;
  var href = a.getAttribute("href") || "";
  if (href.charAt(0) === "#") {
    e.preventDefault();
    var id = href.slice(1);
    try { id = decodeURIComponent(id); } catch (_) {}
    var el = id ? document.getElementById(id) || document.getElementsByName(id)[0] : document.documentElement;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (/^https?:/i.test(a.protocol)) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
});
</script>`;
