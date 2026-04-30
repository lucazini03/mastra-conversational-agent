declare module 'rtf-parser' {
  interface RtfNode {
    value?: string;
    content?: RtfNode[] | undefined;
    [key: string]: unknown;
  }

  function string(rtf: string, callback: (err: Error | null, doc: RtfNode) => void): void;
  function stream(stream: NodeJS.ReadableStream, callback: (err: Error | null, doc: RtfNode) => void): void;
}
