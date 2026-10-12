/**
 * Browser side of a direct upload: ask our own route for a signed URL, then
 * PUT the file straight to storage.
 *
 * The file deliberately does not pass through a Vercel function — anything
 * over 4.5 MB would be rejected before a handler ran.
 */
export async function uploadDirect(
  endpoint: string,
  pathname: string,
  file: File,
  contentType: string,
  payload: Record<string, unknown> = {}
): Promise<{ url: string }> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pathname, contentType, size: file.size, ...payload }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    uploadUrl?: string;
    publicUrl?: string;
    error?: string;
  };
  if (!res.ok || !json.uploadUrl || !json.publicUrl) {
    throw new Error(json.error ?? "the upload was not authorised");
  }

  const put = await fetch(json.uploadUrl, {
    method: "PUT",
    headers: { "content-type": contentType, "x-upsert": "true" },
    body: file,
  });
  if (!put.ok) {
    const detail = await put.text().catch(() => "");
    throw new Error(`storage refused the file (${put.status}) ${detail.slice(0, 160)}`.trim());
  }
  return { url: json.publicUrl };
}
