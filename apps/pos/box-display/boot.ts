/** Wait for the local agent; only an answered build mismatch asks for reload. */
export function startDisplayBoot(build: string, show: (state: 'waiting' | 'ready' | 'mismatch') => void): () => void {
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const check = async () => {
    const active = new AbortController();
    controller = active;
    const deadline = setTimeout(() => active.abort(), 3_000);
    try {
      const response = await fetch('/api/display/version', {
        credentials: 'omit', cache: 'no-store', signal: active.signal,
      });
      if (!response.ok) throw new Error('Agent unavailable');
      const version = await response.json() as { build?: string };
      if (typeof version.build !== 'string') throw new Error('Agent unavailable');
      if (!stopped) show(version.build === build ? 'ready' : 'mismatch');
      return;
    } catch {
      if (stopped) return;
      show('waiting');
      timer = setTimeout(() => { void check(); }, Math.min(10_000, 1_000 * 2 ** attempt++));
    } finally { clearTimeout(deadline); }
  };
  show('waiting');
  void check();
  return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
}
