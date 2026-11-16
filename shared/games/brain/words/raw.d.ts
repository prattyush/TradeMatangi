/** The word-list assets are imported as text (`?raw`) and only from `loader.ts`, through a dynamic import (they must not reach the main bundle). */
declare module '*.fc.txt?raw' {
  const text: string
  export default text
}
