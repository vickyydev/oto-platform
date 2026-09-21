import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './kiosk.css';

const container = document.getElementById('root');
if (!container) throw new Error('no #root to mount the booth on');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
