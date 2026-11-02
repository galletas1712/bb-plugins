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
    frame.style.cssText = "position:fixed;border:0;z-index:1;display:none";
    window.document.body.append(frame);
    entry = { pluginId, frame };
    frames.set(cacheKey, entry);
  }
  const { frame } = entry;
  frame.title = document.title;
  frame.style.colorScheme = document.colorScheme;
  if (frame.srcdoc !== document.html) frame.srcdoc = document.html;
  const position = () => {
    const rect = host.getBoundingClientRect();
    const visible = host.isConnected && rect.width > 0 && rect.height > 0;
    frame.style.display = visible ? "block" : "none";
    Object.assign(frame.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  };
  position();
  const observer = new ResizeObserver(position);
  observer.observe(host);
  window.addEventListener("resize", position);
  window.addEventListener("scroll", position, true);
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", position);
    window.removeEventListener("scroll", position, true);
    frame.style.display = "none";
  };
}
