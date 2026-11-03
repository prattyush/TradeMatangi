import { bindChartMenu } from '../../shared/charts/ChartMenuGesture'
const state = window as unknown as { menus: unknown[]; blocked: boolean; clean: () => void }
state.menus = []
state.blocked = false
state.clean = bindChartMenu(document.getElementById('chart')!, 'doubleclick', point => state.menus.push({ x: point.clientX, y: point.clientY }), () => state.blocked)
