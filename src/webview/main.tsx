import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './city.css';
import './building.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  const view = rootEl.dataset.view === 'sidebar' ? 'sidebar' : 'panel';
  document.body.classList.add(`view-${view}`);
  createRoot(rootEl).render(<App view={view} />);
}
