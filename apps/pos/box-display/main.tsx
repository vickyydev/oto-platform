import { createRoot } from 'react-dom/client';
import Display from '../src/pages/Display';
import { LanguageProvider } from '../src/i18n/LanguageContext';
import { TooltipProvider } from '../src/components/ui/tooltip';
import '../src/fonts.css';
import '../src/index.css';
import { startDisplayBoot } from './boot';

declare const __OTO_DISPLAY_BUILD__: string;

const root = createRoot(document.getElementById('root')!);
startDisplayBoot(__OTO_DISPLAY_BUILD__, state => {
  if (state === 'ready') {
    root.render(<TooltipProvider><LanguageProvider><Display /></LanguageProvider></TooltipProvider>);
  } else if (state === 'mismatch') {
    root.render(<main className="p-8"><h1 className="text-2xl font-bold">Reload this display</h1><p>The display page and the box must be from the same release.</p><button className="mt-4 underline" onClick={() => window.location.reload()}>Reload</button></main>);
  } else {
    root.render(<main className="p-8" role="status"><h1 className="text-2xl font-bold">Connecting to this counter</h1><p>The box is starting or reconnecting. This display will open automatically.</p></main>);
  }
});
