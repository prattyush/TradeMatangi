import { createRoot } from 'react-dom/client'
import ChartContextMenu from '../../frontend/src/components/ChartContextMenu'
createRoot(document.getElementById('root')!).render(<ChartContextMenu
  x={innerWidth - 30} y={100} price={107} onClose={() => {}}
  actions={[{ label: 'Strategies', submenu: [{ label: 'Underlying target', submenu: [
    { label: 'Half', onClick: () => { (window as any).chosen = 'half' } },
    { label: 'Full', onClick: () => { (window as any).chosen = 'full' } },
  ] }] }]} />)
