export interface DrawingCommandState {
  id: number
  tool: string
}

export const shouldConsumeDrawingCommand = (
  mode: 'once' | 'repeat',
  command: DrawingCommandState | null,
  commandId: number,
  tool: string,
) => mode === 'once' && command?.id === commandId && command.tool === tool
