// Frames stay connected while their panel is unmounted. Moving or detaching an
// iframe reloads its browsing context, including state owned by the saved HTML.
const frames = new Map<
  string,
  { pluginId: string; frame: HTMLIFrameElement }
>();

export function disposeExplainerFrames(pluginId: string) {
  for (const [key, entry] of frames) {
    if (entry.pluginId !== pluginId) continue;
    entry.frame.remove();
    frames.delete(key);
  }
}

// The z-index that orders the host's outermost positioned ancestor on the page.
// A frame on body must sit just above it, such as the mobile panel shelf.
function stackLevel(host: HTMLElement) {
  let level = 0;
  for (let node = host.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.position !== "static" && style.zIndex !== "auto")
      level = Number.parseInt(style.zIndex, 10) || 0;
  }
  return level;
}

export function showExplainerFrame(
  pluginId: string,
  key: string,
  host: HTMLElement,
  document: { html: string; title: string; colorScheme: string },
) {
  const cacheKey = JSON.stringify([pluginId, key]);
  let entry = frames.get(cacheKey);
  if (!entry) {
    const frame = window.document.createElement("iframe");
    frame.setAttribute(
      "sandbox",
      "allow-scripts allow-popups allow-popups-to-escape-sandbox",
    );
    frame.style.cssText = "position:fixed;border:0;display:none";
    window.document.body.append(frame);
    entry = { pluginId, frame };
    frames.set(cacheKey, entry);
  }
  const { frame } = entry;
  frame.title = document.title;
  frame.style.colorScheme = document.colorScheme;
  if (frame.srcdoc !== document.html) frame.srcdoc = document.html;
  // Track the host every frame. Panels can slide with CSS transforms, which
  // neither resize nor scroll events report.
  let placement = "";
  let request = 0;
  const position = () => {
    const rect = host.getBoundingClientRect();
    const visible =
      host.isConnected &&
      rect.width > 0 &&
      rect.height > 0 &&
      (host.checkVisibility?.({ visibilityProperty: true }) ?? true);
    const style = visible
      ? {
          display: "block",
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          zIndex: String(stackLevel(host) + 1),
        }
      : { display: "none" };
    const next = JSON.stringify(style);
    if (next !== placement) {
      placement = next;
      Object.assign(frame.style, style);
    }
    request = requestAnimationFrame(position);
  };
  position();
  return () => {
    cancelAnimationFrame(request);
    frame.style.display = "none";
  };
}
