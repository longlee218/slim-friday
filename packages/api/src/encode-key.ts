/** Encode each path segment of an R2 key for a URL; `/` stays. */
export const encodeKey = (key: string): string => key.split("/").map(encodeURIComponent).join("/");
