import { createRoot } from 'react-dom/client';
import App from './App';
// The faces before the page's own styles, as the till loads them: Inter and
// 'Till Thai' come from this build, not from an outside host (SCRUM-1016).
import './fonts.css';
import './index.css';

createRoot(document.getElementById('root')!).render(<App />);
