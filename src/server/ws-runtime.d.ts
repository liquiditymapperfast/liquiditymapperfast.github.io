/** Public ws methods used by the optional live feed transport. Raw event payloads stay unknown. */
declare module 'ws' {
  class WebSocket {
    static readonly OPEN: number;
    static readonly CLOSED: number;
    readonly readyState: number;
    readonly bufferedAmount: number;
    constructor(url: string, options?: {maxPayload?: number});
    send(payload: string | Uint8Array, options?: {binary?: boolean; compress?: boolean}): void;
    close(): void;
    terminate(): void;
    on(event: string, listener: (payload: unknown) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    once(event: 'open', listener: () => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
    removeListener(event: string, listener: (...args: unknown[]) => void): this;
    off(event: 'open', listener: () => void): this;
    off(event: 'error', listener: (error: Error) => void): this;
  }
  class WebSocketServer {
    constructor(options: {host?: string; port?: number; perMessageDeflate?: boolean; noServer?: boolean});
    readonly clients: Set<WebSocket>;
    handleUpgrade(request: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, callback: (client: WebSocket) => void): void;
    address(): import('node:net').AddressInfo | string | null;
    on(event: 'connection', listener: (socket: WebSocket) => void): this;
    once(event: 'listening', listener: () => void): this;
    close(callback: (error?: Error) => void): void;
  }
  export { WebSocket, WebSocketServer };
  export default WebSocket;
}
