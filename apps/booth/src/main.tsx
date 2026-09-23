import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import OrientationFrame from './components/OrientationFrame';
import './kiosk.css';

const container = document.getElementById('root');
if (!container) throw new Error('no #root to mount the booth on');

/**
 * The game is drawn portrait and the frame makes it fit the screen it is on —
 * including a television hung sideways, which is what the booths are. Nothing
 * inside `App` knows about the panel; see components/OrientationFrame.tsx.
 */
createRoot(container).render(
  <StrictMode>
    <OrientationFrame>
      <App />
    </OrientationFrame>
  </StrictMode>,
);
