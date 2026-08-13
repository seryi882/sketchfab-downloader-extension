/**
 * Map pipeline log lines to a 0–100 progress bar.
 * Returns null if the line should not move the bar.
 */
export function progressFromMessage(msg) {
  const s = String(msg || "");
  if (/^✅|Download ok|ZIP ready|done /i.test(s) && /ERROR/i.test(s) === false) {
    if (/ERROR/i.test(s)) return null;
  }
  if (/^✅/.test(s) || /ZIP ready|done /i.test(s)) return 100;
  if (/Saving /i.test(s)) return 96;
  if (/Building ZIP/i.test(s)) return 92;
  if (/GLB ready|Converting osgjs/i.test(s)) return 88;
  if (/ready for GLB|Merging /i.test(s)) return 82;
  const tm = s.match(/Texture\s+(\d+)\s*\/\s*(\d+)/i);
  if (tm) {
    const n = Number(tm[1]);
    const d = Number(tm[2]) || 1;
    return Math.min(80, 46 + Math.round((n / d) * 32));
  }
  if (/Textures: skipped/i.test(s)) return 70;
  if (/Downloading textures|Textures API|Textures:/i.test(s)) return 46;
  if (/model_file|wireframe/i.test(s)) return 40;
  if (/Downloading file\.binz|Decrypting file\.binz|file\.osgjs/i.test(s)) {
    return 32;
  }
  if (/WASM|Static key|Reading key/i.test(s)) return 22;
  if (/Extracting decrypt|Reading public|UID:/i.test(s)) return 12;
  if (/Background: starting|Opening offscreen|starting/i.test(s)) return 6;
  if (/ERROR|failed/i.test(s)) return null;
  return null;
}

export function saveTextFile(filename, text) {
  const blob = new Blob([text || ""], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "sf-dl-log.txt";
  a.rel = "noreferrer";
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
