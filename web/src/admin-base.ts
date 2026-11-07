export function adminBasePath(): string {
  const configured = document.querySelector<HTMLMetaElement>('meta[name="perpay-admin-base"]')?.content;
  if (configured && /^\/(?:[A-Za-z0-9._~-]+\/)*admin\/$/.test(configured)) return configured;
  return import.meta.env.BASE_URL;
}

export function adminMountPath(): string {
  const base = adminBasePath();
  return base.endsWith("/admin/") ? base.slice(0, -"/admin/".length) : "";
}
