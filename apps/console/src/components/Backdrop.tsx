/**
 * The brand wash behind every page: two soft blooms in the park's coral and
 * mint. Fixed and clipped, so it can never add a scrollbar at any width, and
 * behind the content rather than over it.
 */
export function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="absolute -top-40 -left-32 h-[30rem] w-[30rem] rounded-full blur-3xl"
        style={{ background: 'var(--suite-wash-warm)' }}
      />
      <div
        className="absolute -bottom-48 -right-32 h-[34rem] w-[34rem] rounded-full blur-3xl"
        style={{ background: 'var(--suite-wash-mint)' }}
      />
    </div>
  );
}
