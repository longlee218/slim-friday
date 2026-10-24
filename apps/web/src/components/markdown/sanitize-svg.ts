import DOMPurify from "dompurify";

/**
 * Defense in depth for mermaid's SVG (already `securityLevel: "strict"`): strips scripts and
 * event attributes. `foreignObject` and the HTML profile stay so flowchart HTML labels survive.
 */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ["foreignObject"],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  });
}
