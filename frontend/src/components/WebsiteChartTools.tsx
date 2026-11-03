import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import '../../../shared/charts/websiteKLine.css';

const ToolsContext = createContext<{
  container: HTMLDivElement | null;
  register: (name: string) => () => void;
} | null>(null);
export const useWebsiteChartTools = () => useContext(ToolsContext);

/** One toolbar per website workspace; only its active KLine chart supplies controls. */
export function WebsiteChartTools({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [name, setName] = useState('');
  const [collapsed, setCollapsed] = useState(true);
  const owner = useRef<symbol>();
  const register = useCallback((label: string) => {
    const token = Symbol();
    owner.current = token;
    setName(label);
    return () => { if (owner.current === token) { owner.current = undefined; setName(''); } };
  }, []);
  const value = useMemo(() => ({ container, register }), [container, register]);
  return <ToolsContext.Provider value={value}>
    <div className="website-chart-workspace">
      <aside className={`website-chart-tools ${collapsed ? 'is-collapsed' : ''}`} hidden={!name} aria-label="Active chart drawings and indicators">
        <button title={collapsed ? 'Show drawings and indicators' : 'Hide drawings and indicators'} aria-label="Toggle drawing and indicator tools" aria-expanded={!collapsed} onClick={() => setCollapsed(v => !v)}>✎{!collapsed && ' Drawings & indicators'}</button>
        {!collapsed && <div className="website-chart-tools-name" title={name}>{name}</div>}
        <div ref={setContainer} hidden={collapsed} />
      </aside>
      <div className="website-chart-workspace-content">{children}</div>
    </div>
  </ToolsContext.Provider>;
}
