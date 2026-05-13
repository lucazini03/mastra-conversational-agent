// Type declarations for packages without @types definitions.

declare module 'rtf-parser' {
  export interface RtfNode {
    type: string;
    value?: string;
    content?: RtfNode[];
    style?: Record<string, unknown>;
  }
  const rtfParser: {
    string(input: string, cb: (err: Error | null, doc: RtfNode) => void): void;
  };
  export default rtfParser;
}
