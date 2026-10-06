import Component from '../../../shared/analysis/TradeAnalysis'
import { withWebsiteAnalysis } from '../services/analysisEnvironment'
export default withWebsiteAnalysis(Component)
import { AnalysisChart as Underlying, OptionsChart as Options } from '../../../shared/analysis/TradeAnalysis'
export const AnalysisChart = withWebsiteAnalysis(Underlying)
export const OptionsChart = withWebsiteAnalysis(Options)
