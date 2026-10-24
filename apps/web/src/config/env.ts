/** The only place that reads `import.meta.env`. */
export const env = {
  /** Engine API origin, no trailing slash (`VITE_API_URL`, default local engine). */
  apiUrl: (import.meta.env.VITE_API_URL ?? "http://localhost:8787").replace(/\/+$/, "") as string,
};
