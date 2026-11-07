export const DEFAULT_SYSTEM_NAME = "StarPAY";
export const SYSTEM_NAME_MARKER = "__PERPAY_SYSTEM_NAME__";

export function displaySystemName(name: string | null | undefined): string {
  return name ? name.replace(/perpay/gi, DEFAULT_SYSTEM_NAME) : DEFAULT_SYSTEM_NAME;
}

export function escapeSystemName(name: string): string {
  return name.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
