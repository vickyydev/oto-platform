import { createRoot } from 'react-dom/client';
import Display from '../src/pages/Display';
import { LanguageProvider } from '../src/i18n/LanguageContext';
import { TooltipProvider } from '../src/components/ui/tooltip';
import '../src/fonts.css';
import '../src/index.css';

declare const __OTO_DISPLAY_BUILD__: string;

const root = createRoot(document.getElementById('root')!);
async function boot() {
  try {
    const response = await fetch('/api/display/version', { credentials: 'omit', cache: 'no-store' });
    const version = await response.json() as { build?: string };
    if (!response.ok || version.build !== __OTO_DISPLAY_BUILD__) throw new Error('version');
    root.render(<TooltipProvider><LanguageProvider><Display /></LanguageProvider></TooltipProvider>);
  } catch {
    root.render(<main className="p-8"><h1 className="text-2xl font-bold">Reload this display</h1><p>The display page and the box must be from the same release.</p><button className="mt-4 underline" onClick={() => window.location.reload()}>Reload</button></main>);
  }
}
void boot();
