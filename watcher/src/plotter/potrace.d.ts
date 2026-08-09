declare module 'potrace' {
  interface TraceOptions {
    threshold?: number
    turdSize?: number
    optTolerance?: number
    color?: string
    background?: string
  }
  function trace(
    input: Buffer | string,
    options: TraceOptions,
    cb: (err: Error | null, svg: string) => void,
  ): void
  export default { trace }
  export { trace, TraceOptions }
}
